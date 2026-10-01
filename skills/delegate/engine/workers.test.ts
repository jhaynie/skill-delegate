import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { compareRules, opencodeConfig, opencodePermission, parseRules, rulesOf, type Rule } from "./workers.ts";

const toolOutput = "/home/u/.local/share/opencode/tool-output/*";
const allow = (permission: string, pattern = "*"): Rule => ({ permission, pattern, action: "allow" });
const tools = ["read", "glob", "grep", "list", "webfetch", "websearch", "codesearch", "todowrite", "skill", "lsp"];

test("the OpenCode config turns off every resolved MCP server and denies before it allows", () => {
  const read = opencodeConfig("read", ["linear", "context7"], opencodePermission("read", toolOutput));
  assert.equal(
    JSON.stringify(read),
    JSON.stringify({
      mcp: { linear: { enabled: false }, context7: { enabled: false } },
      agent: {
        plan: {
          permission: {
            "*": "deny",
            ...Object.fromEntries(tools.map((t) => [t, "allow"])),
            external_directory: "allow",
          },
        },
      },
    }),
  );
  const write = opencodeConfig("write", [], opencodePermission("write", toolOutput));
  assert.deepEqual(write.mcp, {});
  assert.deepEqual(Object.keys(write.agent), ["build"]);
  assert.deepEqual(Object.entries(write.agent.build?.permission ?? {}).slice(-3), [
    ["bash", "allow"],
    ["edit", "allow"],
    ["external_directory", { "*": "ask", [toolOutput]: "allow" }],
  ]);
});

test("the rules a permission config makes keep its order, one per pattern", () => {
  assert.deepEqual(rulesOf({ "*": "deny", read: "allow", external_directory: { "*": "ask", [toolOutput]: "allow" } }), [
    { permission: "*", pattern: "*", action: "deny" },
    allow("read"),
    { permission: "external_directory", pattern: "*", action: "ask" },
    allow("external_directory", toolOutput),
  ]);
});

// The tail of `opencode debug agent plan` under the read lockdown, from a live run
const planDefaults: Rule[] = [
  allow("*"),
  { permission: "external_directory", pattern: "*", action: "ask" },
  { permission: "edit", pattern: "*", action: "deny" },
  allow("*"),
];
const readRules = rulesOf(opencodePermission("read", toolOutput));
const writeRules = rulesOf(opencodePermission("write", toolOutput));

test("the lockdown holds when every rule after the deny is the runner's", () => {
  assert.deepEqual(compareRules([...planDefaults, ...readRules, allow("external_directory", toolOutput)], readRules), { kind: "held" });
  assert.deepEqual(compareRules([...planDefaults, ...writeRules, allow("external_directory", toolOutput)], writeRules), { kind: "held" });
});

test("a rule that survives the merge after the deny breaks the lockdown", () => {
  const userBash = allow("bash");
  assert.deepEqual(compareRules([...planDefaults, ...readRules, userBash], readRules), { kind: "extra", rules: [userBash] });
  const outside = allow("external_directory", "/etc/*");
  assert.deepEqual(compareRules([...writeRules, outside], writeRules), { kind: "extra", rules: [outside] });
  const askShell: Rule = { permission: "bash", pattern: "*", action: "ask" };
  assert.deepEqual(compareRules([...readRules, askShell], readRules), { kind: "extra", rules: [askShell] });
});

test("a tighter rule after the deny keeps the lockdown, and a ruleset without the deny breaks it", () => {
  const tighter: Rule[] = [
    { permission: "read", pattern: "*.env", action: "ask" },
    { permission: "edit", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "*", action: "ask" },
  ];
  assert.deepEqual(compareRules([...writeRules, ...tighter], writeRules), { kind: "held" });
  assert.deepEqual(compareRules(planDefaults, readRules), { kind: "noDeny" });
});

test("the effective rules parse from the debug agent output, and a malformed rule throws", () => {
  const agent = { name: "plan", permission: [{ permission: "read", action: "allow", pattern: "*" }], tools: {} };
  assert.deepEqual(parseRules(agent), [allow("read")]);
  assert.throws(() => parseRules({ permission: [{ permission: "read", action: "maybe", pattern: "*" }] }), /unreadable rule/);
  assert.throws(() => parseRules({ name: "plan" }), /no permission list/);
});

// Starts a Devin launch in a process whose config home is home, the way each
// engine owner does
function launchDevin(home: string): void {
  const script = `const { profiles } = await import(${JSON.stringify(path.join(import.meta.dirname, "workers.ts"))}); profiles.devin.launch({ preset: "read" }, {});`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, XDG_CONFIG_HOME: home } });
  assert.equal(r.status, 0, r.stderr);
}

test("Devin's shared config follows the template's content, not its mtime, and keeps Devin's own writes", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "engine-devin-config-"));
  const copy = path.join(home, "delegate", "devin-worker.json");
  const template = fs.readFileSync(path.join(import.meta.dirname, "..", "config", "devin-worker.json"), "utf8");
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  // Another checkout's template, copied later than this one was written
  fs.writeFileSync(copy, '{"from":"another checkout"}\n');
  const later = new Date(Date.now() + 86_400_000);
  fs.utimesSync(copy, later, later);
  launchDevin(home);
  assert.equal(fs.readFileSync(copy, "utf8"), template);

  const withState = template.replace("{", '{"devinSetup":true,');
  fs.writeFileSync(copy, withState);
  launchDevin(home);
  assert.equal(fs.readFileSync(copy, "utf8"), withState);
});
