import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Cli, Preset, RunSpec } from "./state.ts";

export interface WorkerProfile {
  argv(preset: Preset): string[];
  authMethod: string;
  defaults: { model: string; effort: string };
  configIds: { model: string; effort: string };
  // The config option that sets the session mode, or null when argv sets it
  mode: { configId: string; value(preset: Preset): string } | null;
  // The shell marker a host sets for its own CLI; that host runs this family natively
  hostMarker: string | null;
  sandbox(preset: Preset): string | null;
  // A read-only sandbox, or no write tools at all, lets a read-mode worker
  // run in the target itself instead of a scratch workspace
  readInTarget: boolean;
  fullAccess: boolean;
  // Throws when the worker cannot be locked down, so it never starts
  // executable is the worker CLI's absolute path, for any command it runs
  launch(spec: RunSpec, base: NodeJS.ProcessEnv, executable: string): Launch;
  // The lines that tell the worker what its tools can reach
  access(spec: RunSpec): string[];
  rules(spec: RunSpec): string[];
}

export interface Launch {
  env: Record<string, string>;
  // Checked after the session opens; the engine sends no prompt unless it holds
  lockdown(): Lockdown;
}

export type Action = "allow" | "ask" | "deny";
export interface Rule {
  permission: string;
  pattern: string;
  action: Action;
}

export type Lockdown =
  | { kind: "held" }
  | { kind: "noDeny" }
  | { kind: "extra"; rules: Rule[] }
  | { kind: "unreadable"; reason: string };

export const HOST_MARKERS = ["CURSOR_AGENT", "GROK_AGENT", "CODEX_SESSION_ID", "OPENCODE", "OPENCODE_PID"];
const SECRET = /TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL/;
const packageDir = path.resolve(import.meta.dirname, "..");
const configDir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "delegate");
const devinConfig = path.join(configDir, "devin-worker.json");
const held = (): Lockdown => ({ kind: "held" });
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const sandboxed = (spec: RunSpec): string[] =>
  spec.preset === "read" && spec.cwd === spec.target
    ? ['- Any shell command runs. The sandbox is read-only, so every write fails with "Operation not permitted". Report it and go on.']
    : ['- Any shell command runs. A write outside your working directory fails with "Operation not permitted". Report it and go on.'];

export const profiles: Record<Cli, WorkerProfile> = {
  devin: {
    // The --sandbox flag form leaves ACP sessions unsandboxed; only the env form works
    argv: () => ["devin", "--config", devinConfig, "--respect-workspace-trust", "false", "acp"],
    authMethod: "devin-browser",
    // Devin's ACP server rejects swe-2-medium
    defaults: { model: "swe-2-high", effort: "medium" },
    configIds: { model: "model", effort: "thought_level" },
    mode: null,
    hostMarker: null,
    sandbox: () => null,
    readInTarget: false,
    fullAccess: true,
    // Devin writes setup state into the config it is given, so it gets one
    // persistent copy per user. The copy is replaced when the template's
    // content differs from the one it was made from, whose hash sits beside
    // it. An mtime proves nothing: Devin's writes and every checkout's copy
    // bump it. The hash goes last, so a copy cut short is redone next launch.
    launch: (spec) => {
      const template = fs.readFileSync(path.join(packageDir, "config", "devin-worker.json"));
      const hash = createHash("sha256").update(template).digest("hex");
      const hashFile = `${devinConfig}.template-sha256`;
      const copied = fs.existsSync(devinConfig) && fs.existsSync(hashFile) ? fs.readFileSync(hashFile, "utf8").trim() : null;
      if (copied !== hash) {
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(devinConfig, template);
        fs.writeFileSync(hashFile, `${hash}\n`);
      }
      const env: Record<string, string> = spec.preset === "full" ? {} : { DEVIN_SANDBOX: "true" };
      return { env, lockdown: held };
    },
    access: sandboxed,
    rules: (spec) => [
      "- Do not hand the task to a cloud session.",
      "- MCP tools and commands on the deny list, such as `git push`, end your run.",
      ...(spec.preset === "full" ? [] : ["- The sandbox makes `.git` read-only, so git commands that write it fail."]),
    ],
  },
  grok: {
    // An explicit mode overrides permission_mode in ~/.grok/config.toml, so requests reach the policy
    argv: (preset) => [
      "grok",
      ...{ read: ["--sandbox", "read-only", "--permission-mode", "default"], write: ["--sandbox", "workspace", "--permission-mode", "default"], full: [] }[preset],
      "agent",
      "--no-leader",
      "stdio",
    ],
    authMethod: "cached_token",
    defaults: { model: "grok-4.7", effort: "medium" },
    configIds: { model: "model", effort: "reasoning_effort" },
    mode: null,
    hostMarker: "GROK_AGENT",
    sandbox: (preset) => ({ read: "read-only", write: "workspace", full: "off" })[preset],
    readInTarget: true,
    fullAccess: true,
    launch: () => ({ env: {}, lockdown: held }),
    access: sandboxed,
    rules: () => [],
  },
  // No OS sandbox: the permissions in OPENCODE_CONFIG_CONTENT are the fence
  opencode: {
    argv: () => ["opencode", "acp"],
    authMethod: "opencode-login",
    defaults: { model: "azure/gpt-6.1-sol", effort: "medium" },
    configIds: { model: "model", effort: "effort" },
    mode: { configId: "mode", value: (preset) => opencodeAgent(preset) },
    hostMarker: "OPENCODE",
    sandbox: () => null,
    readInTarget: true,
    fullAccess: false,
    launch: (spec, base, executable) => {
      if (spec.preset === "full") throw new Error("OpenCode has no full-access preset");
      const opencode = (args: string[], env: NodeJS.ProcessEnv): string =>
        execFileSync(executable, args, { cwd: spec.cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64_000_000 });
      let mcp: string[];
      let data: string;
      try {
        mcp = mcpNames(JSON.parse(opencode(["debug", "config"], base)));
        data = dataDir(opencode(["debug", "paths"], base));
      } catch (e) {
        throw new Error(`cannot read the OpenCode config to lock the worker down: ${message(e)}`);
      }
      const permission = opencodePermission(spec.preset, path.join(data, "tool-output", "*"));
      const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig(spec.preset, mcp, permission)) };
      return {
        env,
        lockdown: () => {
          let effective: Rule[];
          try {
            effective = parseRules(JSON.parse(opencode(["debug", "agent", opencodeAgent(spec.preset)], { ...base, ...env })));
          } catch (e) {
            return { kind: "unreadable", reason: message(e) };
          }
          return compareRules(effective, rulesOf(permission));
        },
      };
    },
    access: (spec) =>
      spec.preset === "read"
        ? ["- You have no shell and no edit tools. Read, search, and fetch with the file and web tools."]
        : ["- A file tool call outside your working directory waits for the parent, who may deny it. Never write outside it with the shell."],
    rules: () => [],
  },
};

// Rules match last-first, so "*": "deny" goes first and the allows follow.
// write, patch, and apply_patch all check the edit permission.
const OPENCODE_TOOLS = ["read", "glob", "grep", "list", "webfetch", "websearch", "codesearch", "todowrite", "skill", "lsp"];

type Permission = Record<string, Action | Record<string, Action>>;

const opencodeAgent = (preset: Preset) => (preset === "read" ? "plan" : "build");

// toolOutput is where OpenCode saves a long tool output for the worker to read back
export function opencodePermission(preset: "read" | "write", toolOutput: string): Permission {
  const tools: Permission = Object.fromEntries(OPENCODE_TOOLS.map((tool) => [tool, "allow"]));
  return preset === "read"
    ? { "*": "deny", ...tools, external_directory: "allow" }
    : { "*": "deny", ...tools, bash: "allow", edit: "allow", external_directory: { "*": "ask", [toolOutput]: "allow" } };
}

// Every MCP server is turned off by name, because OpenCode keeps its MCP
// resource tools while any server is connected
export function opencodeConfig(preset: "read" | "write", mcp: string[], permission: Permission) {
  return {
    mcp: Object.fromEntries(mcp.map((server) => [server, { enabled: false }])),
    agent: { [opencodeAgent(preset)]: { permission } },
  };
}

// The ruleset OpenCode builds from a permission config, in order
export function rulesOf(permission: Permission): Rule[] {
  return Object.entries(permission).flatMap(([name, value]) =>
    typeof value === "string"
      ? [{ permission: name, pattern: "*", action: value }]
      : Object.entries(value).map(([pattern, action]) => ({ permission: name, pattern, action })),
  );
}

// A managed or organization config, or a user's rule for this agent, can
// survive the merge after the runner's "*": "deny". Every later rule that is
// not a deny must be covered by one the runner put there: an allow by an
// allow, and an ask, which the policy may answer, by an allow or an ask.
export function compareRules(effective: Rule[], expected: Rule[]): Lockdown {
  const anchor = effective.findLastIndex((r) => r.permission === "*" && r.pattern === "*" && r.action === "deny");
  if (anchor === -1) return { kind: "noDeny" };
  const covered = (r: Rule) =>
    expected.some(
      (e) => e.permission === r.permission && (e.pattern === "*" || e.pattern === r.pattern) && (e.action === "allow" || e.action === r.action),
    );
  const extra = effective.slice(anchor + 1).filter((r) => r.action !== "deny" && !covered(r));
  return extra.length ? { kind: "extra", rules: extra } : { kind: "held" };
}

const isAction = (v: unknown): v is Action => v === "allow" || v === "ask" || v === "deny";

// `opencode debug agent` prints the agent with its effective ruleset
export function parseRules(agent: unknown): Rule[] {
  const rules = typeof agent === "object" && agent !== null && "permission" in agent ? agent.permission : undefined;
  if (!Array.isArray(rules)) throw new Error("the agent has no permission list");
  return rules.map((r: unknown) => {
    if (typeof r !== "object" || r === null || !("permission" in r) || !("pattern" in r) || !("action" in r)) {
      throw new Error(`unreadable rule ${JSON.stringify(r)}`);
    }
    const { permission, pattern, action } = r;
    if (typeof permission !== "string" || typeof pattern !== "string" || !isAction(action)) {
      throw new Error(`unreadable rule ${JSON.stringify(r)}`);
    }
    return { permission, pattern, action };
  });
}

function mcpNames(config: unknown): string[] {
  const mcp = typeof config === "object" && config !== null && "mcp" in config ? config.mcp : undefined;
  return typeof mcp === "object" && mcp !== null ? Object.keys(mcp) : [];
}

// `opencode debug paths` prints one "<name> <path>" line per directory
function dataDir(paths: string): string {
  const dir = /^data\s+(\S.*)$/m.exec(paths)?.[1]?.trim();
  if (!dir) throw new Error("opencode debug paths names no data directory");
  return dir;
}

// The host's variables minus its markers and anything that looks like a
// secret, with the caller's own PATH, which the engine filtered for itself
export function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (HOST_MARKERS.includes(name) || name === "DELEGATE_WORKER_PATH") continue;
    // A sandboxed shell can read and send secrets, and a git credential helper can use them
    if (SECRET.test(name) && !name.startsWith("DEVIN_")) continue;
    if (name === "DEVIN_SANDBOX" || name === "GROK_SANDBOX" || name === "DEVIN_PERMISSION_MODE") continue;
    env[name] = value;
  }
  if (process.env.DELEGATE_WORKER_PATH !== undefined) env.PATH = process.env.DELEGATE_WORKER_PATH;
  return env;
}

// AGENTS.md or CLAUDE.md from the repo root down to the target, because a
// read-mode worker starts in a scratch workspace and loads neither
export function rulesFiles(target: string, gitRoot: string | null): string[] {
  const files: string[] = [];
  for (let dir = target; ; dir = path.dirname(dir)) {
    const found = ["AGENTS.md", "CLAUDE.md"].map((n) => path.join(dir, n)).find((f) => fs.statSync(f, { throwIfNoEntry: false })?.isFile());
    if (found) files.unshift(found);
    if (!gitRoot || dir === gitRoot || dir === path.dirname(dir)) break;
  }
  return files;
}

// Rules every brief carries, so no parent has to remember them
export function briefRules(spec: RunSpec, rulesFiles: string[]): string {
  const profile = profiles[spec.cli];
  const lines = [
    "Runner rules:",
    ...profile.rules(spec),
    "- Do not commit, switch branches, or change git history unless the brief asks.",
    "- End with the files you changed and the checks you ran, even when both are none.",
  ];
  if (spec.preset === "full") {
    lines.push(`- The sandbox is off. Write nothing outside ${spec.target}. Do not ask for more access.`);
  } else {
    lines.push(...profile.access(spec), "- Do not ask for more access. The parent answers every such request, and it may deny it.");
  }
  if (spec.preset === "read" && spec.cwd === spec.target) {
    lines.push(
      "- Your working directory is the repo. Read it; do not write files anywhere.",
      "- `gh` is not logged in here. If the brief needs private GitHub data it did not attach, say so in your answer.",
    );
  } else if (spec.preset === "read") {
    lines.push(
      `- The target is ${spec.target}. When the brief says the repo or working directory, it means this path. Use absolute paths.`,
      ...rulesFiles.map((file) => `- Read ${file} before you start. It does not load on its own here.`),
      "- Your own working directory is an empty scratch repo. Put temporary files there and nowhere else.",
      "- `gh` is not logged in here. If the brief needs private GitHub data it did not attach, say so in your answer.",
    );
  } else {
    lines.push("- Your working directory is the repo. Edit files in place. The parent reviews `git diff` when you finish.");
  }
  return `${lines.join("\n")}\n\n`;
}
