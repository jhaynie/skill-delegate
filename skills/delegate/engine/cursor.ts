import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { processStart, type Launch, type Report } from "./cursor-supervisor.ts";
import {
  type DirectCleanup,
  type DirectExecution,
  type DirectResult,
  type DirectStart,
  type ExecuteDirect,
  directEnv,
} from "./direct.ts";
import { modelRejection } from "./model-rejection.ts";
import { rulesFiles } from "./workers.ts";

// Cursor as a direct provider: cursor-agent in print mode, one prompt on
// stdin, one JSON result on stdout.
//
// Both sandboxed modes pass --sandbox enabled, so any shell command runs
// and the OS blocks writes outside the workspace. In read mode the workspace
// is <out>/workspace-<run nonce>, an empty directory whose .cursor/sandbox.json
// lists the target as read-only. A run that omits workspaceSource still uses
// <out>/workspace, which is the executor-test fallback. The sandboxed shell has
// no network in either mode:
// Cursor's print-mode sandbox ignored a networkPolicy of default allow.
// Agent mode rejects the file tools outside the workspace, and plan mode is
// not used because it can put the answer in a plan instead of the reply. In
// write mode the workspace is the target itself. Full access passes --force
// instead of --sandbox enabled. Nothing passes --approve-mcps, so the worker
// has no MCP servers.
// Commands on a Cursor allow list skip the sandbox, so the worker runs with
// its own CURSOR_CONFIG_DIR, whose allow list stays empty. Cursor keeps
// chats in that dir, keyed by workspace path, so a resumed read run reuses
// the scratch workspace the session started in.

export const DEFAULT_MODEL = "auto";

const HANDSHAKE_MS = 10_000;
const STOP_REPORT_MS = 30_000;
const SUPERVISOR = path.join(import.meta.dirname, "cursor-supervisor.ts");
const SESSION_ID = /^[A-Za-z0-9-]+$/;

export type CursorExecution = Extract<DirectExecution, { provider: "cursor" }>;

// What the run CLI knows before it claims the run directory
export type CursorRequest = Pick<CursorExecution, "target" | "gitRoot" | "mode" | "resume" | "fullAccess">;

type Prepared = { kind: "refused"; message: string } | { kind: "ready"; configDir: string; sessionsDir: string; resumeWorkspace: string | null };

// The supervisor's end of a run, with its report turned into a cleanup
type End =
  | { kind: "unstarted"; reason: string; cleanup: DirectCleanup }
  | { kind: "done"; exitCode: number | null; cleanup: DirectCleanup; unrecorded: string | null };

const NOTHING_LEFT: DirectCleanup = { kind: "done", leftover: 0 };

// Why Cursor refuses the request, or null once its private config is ready.
// The CLI calls it before it claims the run directory, so a refused run
// leaves none behind, and executeCursor calls it again before the worker
// starts, since a repo's config can change in between.
export function prepareCursor(request: CursorRequest, env: Readonly<NodeJS.ProcessEnv> = process.env): string | null {
  const prepared = prepare(request, env);
  return prepared.kind === "refused" ? prepared.message : null;
}

export function recordedCursorWorkspace(resume: string, env: Readonly<NodeJS.ProcessEnv> = process.env): string | null {
  if (!SESSION_ID.test(resume)) return null;
  const recorded = readIfFile(path.join(cursorDirs(env).sessionsDir, resume));
  return recorded ? recorded.replace(/\n+$/, "") : null;
}

function cursorDirs(env: Readonly<NodeJS.ProcessEnv>): { configDir: string; sessionsDir: string } {
  const home = env.HOME || os.homedir();
  const delegateDir = path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "delegate");
  return {
    configDir: path.join(delegateDir, "cursor-config"),
    sessionsDir: path.join(delegateDir, "cursor-sessions"),
  };
}

function prepare(request: CursorRequest, env: Readonly<NodeJS.ProcessEnv>, pinnedWorkspace?: string): Prepared {
  const refuse = (message: string): Prepared => ({ kind: "refused", message });
  if (env.CURSOR_AGENT) return refuse("delegate run --cli cursor: this host is cursor, so use its native subagents");
  const { configDir, sessionsDir } = cursorDirs(env);
  const { mode, resume, target, gitRoot } = request;

  let resumeWorkspace: string | null = null;
  if (mode === "read" && resume !== undefined) {
    if (pinnedWorkspace !== undefined) {
      if (!fs.existsSync(pinnedWorkspace)) return refuse(`session workspace expired: ${pinnedWorkspace}. Start a new run.`);
      resumeWorkspace = pinnedWorkspace;
    } else {
      const recorded = recordedCursorWorkspace(resume, env);
      if (!recorded) return refuse(`no workspace recorded for Cursor read session ${resume}. Start a new run.`);
      if (!fs.existsSync(recorded)) return refuse(`session workspace expired: ${recorded}. Start a new run.`);
      resumeWorkspace = recorded;
    }
  }

  const configFile = path.join(configDir, "cli-config.json");
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true });
    emptyAllowList(configFile);
  } catch {
    return refuse(`cannot prepare ${configFile}`);
  }

  // The workspace is the repo, so its own Cursor config applies
  if (mode === "write" && !request.fullAccess) {
    let widened: string | undefined;
    try {
      widened = widenings([target, ...(gitRoot === null ? [] : [gitRoot])])[0];
    } catch {
      return refuse(`cannot read the Cursor config in ${target}`);
    }
    if (widened !== undefined) return refuse(`${widened}, which would widen the sandbox. Remove it first.`);
  }
  return { kind: "ready", configDir, sessionsDir, resumeWorkspace };
}

// Runs the worker in input.out until it exits or signal aborts it, and
// returns once cleanup has run. onStarted gets the supervisor once the
// worker runs, and always before this returns. It writes stdout.raw,
// stderr.log, answer.md, and session_id, never status.
export const executeCursor: ExecuteDirect = async (input, signal, onStarted) => {
  if (input.provider !== "cursor") throw new Error("executeCursor requires provider cursor");
  const base = modeDetail(input);
  const failed = (detail: string, exitCode: number | null, cleanup: DirectCleanup): DirectResult => ({
    exitCode,
    sessionId: "",
    detail,
    failed: true,
    cleanup,
  });
  const stopped = (exitCode: number | null, cleanup: DirectCleanup): DirectResult => ({
    ...failed(`${base} exit=${exitCode ?? "null"} stopped`, exitCode, cleanup),
    endedBy: "stop",
  });
  if (signal.aborted) return stopped(null, NOTHING_LEFT);
  const prepared = prepare(input, process.env, input.workspaceSource);
  if (prepared.kind === "refused") return failed(prepared.message, null, NOTHING_LEFT);
  const file = (name: string) => path.join(input.out, name);
  // Production always passes workspaceSource from run metadata. The last
  // fallback is for direct executor tests that omit it.
  const workspace = input.mode === "read" ? (input.workspaceSource ?? prepared.resumeWorkspace ?? file("workspace")) : input.target;
  try {
    if (input.mode === "read") {
      if (input.resume !== undefined && !fs.existsSync(workspace)) {
        return failed(`session workspace expired: ${workspace}. Start a new run.`, null, NOTHING_LEFT);
      }
      if (input.resume === undefined) fs.mkdirSync(workspace, { recursive: true });
      fs.mkdirSync(path.join(workspace, ".cursor"), { recursive: true });
      fs.writeFileSync(path.join(workspace, ".cursor", "sandbox.json"), JSON.stringify({ additionalReadonlyPaths: [input.target] }));
    }
    fs.writeFileSync(file("stdout.raw"), "");
    fs.writeFileSync(file("stderr.log"), "");
  } catch (e) {
    return failed(`cannot make the worker's output files: ${errorCode(e)}`, null, NOTHING_LEFT);
  }
  const launch: Launch = {
    kind: "launch",
    argv: [input.executable, ...cursorArgs(input, workspace)],
    cwd: workspace,
    env: workerEnv(prepared.configDir),
    // The prompt goes in on stdin. That avoids ARG_MAX and keeps a brief that
    // starts with - from being read as a flag.
    stdin: file("prompt.md"),
    stdout: file("stdout.raw"),
    stderr: file("stderr.log"),
  };
  const end = await supervise(launch, signal, onStarted);
  if (end.kind === "unstarted") return signal.aborted ? stopped(null, end.cleanup) : failed(end.reason, null, end.cleanup);
  if (end.unrecorded !== null) return failed(`${base} ${end.unrecorded}`, end.exitCode, end.cleanup);
  if (signal.aborted) return stopped(end.exitCode, end.cleanup);
  return finish(input, prepared.sessionsDir, workspace, base, end);
}

function cursorArgs(input: CursorExecution, workspace: string): string[] {
  return [
    "-p",
    "--trust",
    "--output-format",
    "json",
    "--workspace",
    workspace,
    "--model",
    input.model,
    ...(input.mode === "write" && input.fullAccess ? ["--force"] : ["--sandbox", "enabled"]),
    ...(input.resume === undefined ? [] : ["--resume", input.resume]),
  ];
}

function workerEnv(configDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(directEnv())) {
    if (value !== undefined) env[name] = value;
  }
  env.CURSOR_CONFIG_DIR = configDir;
  return env;
}

function modeDetail(request: CursorRequest): string {
  return request.mode === "write" && request.fullAccess ? "write full-access" : request.mode;
}

// Starts the supervisor, hands it the launch, and waits for its report. The
// supervisor's pid may be signalled until its exit is seen, and Node never
// signals a child it has reaped.
function supervise(launch: Launch, signal: AbortSignal, onStarted: (start: DirectStart) => void): Promise<End> {
  const uncertain = (detail: string): DirectCleanup => ({ kind: "uncertain", detail });
  // spawn throws for some errors, such as EPERM, and emits the rest
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [SUPERVISOR], { detached: true, cwd: "/", stdio: ["ignore", "ignore", "inherit", "ipc"] });
  } catch (e) {
    return Promise.resolve({ kind: "unstarted", reason: `cannot start the Cursor supervisor: ${errorCode(e)}`, cleanup: NOTHING_LEFT });
  }
  return new Promise((resolve) => {
    let phase: "starting" | "running" | "timed-out" = "starting";
    let settled = false;
    let recording = Promise.resolve();
    let unrecorded: string | null = null;
    const timers: NodeJS.Timeout[] = [];
    const settle = (end: End) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      resolve(recording.then(() => (end.kind === "done" ? { ...end, unrecorded } : end)));
    };
    const stop = () => {
      child.kill("SIGTERM");
      const note = `the Cursor supervisor did not report its cleanup within ${STOP_REPORT_MS / 1_000} s`;
      timers.push(setTimeout(() => settle({ kind: "done", exitCode: null, cleanup: uncertain(note), unrecorded: null }), STOP_REPORT_MS));
    };
    signal.addEventListener("abort", stop, { once: true });
    timers.push(
      setTimeout(() => {
        if (phase !== "starting") return;
        phase = "timed-out";
        child.kill("SIGTERM");
      }, HANDSHAKE_MS),
    );
    child.on("message", (message: unknown) => {
      const report = parseReport(message);
      if (report?.kind === "started" && phase === "starting" && child.pid !== undefined) {
        phase = "running";
        const pid = child.pid;
        // A worker the owner cannot record is one it cannot stop, so the run stops now
        recording = processStart(pid)
          .then((start) => onStarted({ pid, pgid: pid, start }))
          .catch((e: unknown) => {
            unrecorded = `cannot record the started worker: ${(e as Error).message}`;
            if (!signal.aborted) stop();
          });
      } else if (report?.kind === "unstarted") {
        settle({ ...report, cleanup: NOTHING_LEFT });
      } else if (report?.kind === "done") {
        const cleanup = report.notes.length ? uncertain(report.notes.join("; ")) : { kind: "done" as const, leftover: report.leftover };
        settle(phase === "timed-out" ? { kind: "unstarted", reason: timedOut(), cleanup } : { kind: "done", exitCode: report.exitCode, cleanup, unrecorded: null });
      }
    });
    child.on("error", (e) => settle({ kind: "unstarted", reason: `cannot start the Cursor supervisor: ${errorCode(e)}`, cleanup: NOTHING_LEFT }));
    // close comes after the IPC channel closes, so after every report
    child.on("close", (code, sig) => {
      const ended = `the Cursor supervisor ended with ${sig ?? `code ${code}`} before it reported`;
      if (phase === "running") {
        settle({ kind: "done", exitCode: null, cleanup: uncertain(`${ended} its cleanup`), unrecorded: null });
      } else {
        settle({ kind: "unstarted", reason: phase === "timed-out" ? timedOut() : `${ended} the worker`, cleanup: uncertain(`${ended} whether the worker started`) });
      }
    });
    child.send(launch);
  });
}

function timedOut(): string {
  return `the Cursor supervisor did not start the worker within ${HANDSHAKE_MS / 1_000} s`;
}

function parseReport(message: unknown): Report | null {
  if (typeof message !== "object" || message === null || !("kind" in message)) return null;
  const m = message as Record<string, unknown>;
  switch (m.kind) {
    case "started":
      return typeof m.workerPid === "number" ? { kind: "started", workerPid: m.workerPid } : null;
    case "unstarted":
      return typeof m.reason === "string" ? { kind: "unstarted", reason: m.reason } : null;
    case "done": {
      const { exitCode, leftover, notes } = m;
      if (exitCode !== null && typeof exitCode !== "number") return null;
      if (typeof leftover !== "number") return null;
      if (!Array.isArray(notes) || !notes.every((n) => typeof n === "string")) return null;
      return { kind: "done", exitCode, leftover, notes };
    }
    default:
      return null;
  }
}

// cursor-agent exits 0 even when the request is rejected, so is_error in its
// JSON result decides too
function finish(input: CursorExecution, sessionsDir: string, workspace: string, base: string, end: Extract<End, { kind: "done" }>): DirectResult {
  const file = (name: string) => path.join(input.out, name);
  const raw = readIfFile(file("stdout.raw")) ?? "";
  const { isError, sessionId, answer } = cursorResult(raw);
  const unsaved: string[] = [];
  const save = (target: string, text: string, name: string) => {
    try {
      fs.writeFileSync(target, text);
    } catch (e) {
      unsaved.push(`cannot save ${name}: ${errorCode(e)}`);
    }
  };
  save(file("answer.md"), `${answer}\n`, "answer.md");
  save(file("session_id"), `${sessionId}\n`, "session_id");
  if (input.mode === "read" && SESSION_ID.test(sessionId)) save(path.join(sessionsDir, sessionId), `${workspace}\n`, "the session's workspace");
  const result = { exitCode: end.exitCode, sessionId, cleanup: end.cleanup };
  if (end.exitCode === 0 && isError !== "True" && answer !== "" && !unsaved.length) return { ...result, detail: base, failed: false };
  const rejected = modelRejection(input.model, [raw, readIfFile(file("stderr.log")) ?? ""]);
  const detail = [base, `exit=${end.exitCode ?? "unknown"}`, `is_error=${isError || "unknown"}`, rejected ?? "", ...unsaved].filter(Boolean).join(" ");
  return { ...result, detail, failed: true };
}

// The fields as the shell runner printed them: Python's text for a JSON
// value, and an empty string for a missing field or output that is not one
// JSON object
export function cursorResult(raw: string): { isError: string; sessionId: string; answer: string } {
  let d: unknown;
  try {
    d = JSON.parse(raw);
  } catch {
    d = null;
  }
  const field = (name: string) => (isObject(d) ? pyText(d[name]) : "");
  return { isError: field("is_error"), sessionId: field("session_id"), answer: field("result") };
}

function pyText(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "boolean") return v ? "True" : "False";
  return typeof v === "string" ? v : JSON.stringify(v);
}

// The text the CLI writes to prompt.md: runner rules, then the brief. A
// read-mode worker's workspace is not the target, so the rules start with
// where the target is.
export function cursorPrompt(request: CursorRequest, brief: string): string {
  const lines = ["Runner rules:", "- Do not commit, switch branches, or change git history unless the brief asks."];
  if (request.mode === "read") {
    lines.push(
      `- The target is ${request.target}. When the brief says the repo or working directory, it means this path. Use absolute paths or \`cd ${shellQuote(request.target)} && ...\`.`,
      ...rulesFiles(request.target, request.gitRoot).map((f) => `- Read ${f} before you start. It does not load on its own here.`),
      "- Your workspace is an empty scratch directory. Put temporary files there and nowhere else.",
      '- Any shell command runs. Everything outside the workspace is read-only, so a write there fails with "Operation not permitted". Report it and go on.',
    );
  } else {
    lines.push("- Your workspace is the repo. Edit files in place. The parent reviews `git diff` when you finish.");
    lines.push(
      request.fullAccess
        ? `- The sandbox is off. Write nothing outside ${request.target}.`
        : '- Any shell command runs. A write outside the workspace fails with "Operation not permitted", and the shell has no network. Report it and go on.',
    );
  }
  return `${lines.join("\n")}\n\n${brief}`;
}

// One POSIX shell word for s
export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}

// Cursor rewrites its config and can add allow rules to it, so the allow
// list is emptied whenever it has entries. Every other key stays.
function emptyAllowList(file: string): void {
  const text = readIfPresent(file);
  if (text === null) {
    fs.writeFileSync(file, JSON.stringify({ version: 1, autoAcceptWebSearch: true, permissions: { allow: [], deny: [] } }));
    return;
  }
  const config = JSON.parse(text) as unknown;
  const permissions = get(config, "permissions", {});
  if (!truthy(get(permissions, "allow"))) return;
  (permissions as Record<string, unknown>).allow = [];
  fs.writeFileSync(file, JSON.stringify(config));
}

// What in each root's .cursor config would widen or remove the sandbox:
// allowed commands skip it, and these sandbox.json keys widen or remove it.
// Throws on a config that is not JSON objects.
function widenings(roots: readonly string[]): string[] {
  const found: string[] = [];
  for (const root of new Set(roots)) {
    const load = (name: string): unknown => {
      const text = readIfPresent(path.join(root, ".cursor", name));
      return text === null ? {} : JSON.parse(text);
    };
    if (truthy(get(get(load("cli.json"), "permissions", {}), "allow"))) found.push(`${root}/.cursor/cli.json allows commands`);
    const sandbox = load("sandbox.json");
    if (truthy(get(sandbox, "additionalReadwritePaths"))) found.push(`${root}/.cursor/sandbox.json lists additionalReadwritePaths`);
    if (get(sandbox, "type") === "insecure_none") found.push(`${root}/.cursor/sandbox.json sets type insecure_none`);
  }
  return found;
}

// A JSON object's field, or fallback when it has none. Anything but an
// object throws, so a config of another shape reads as broken.
function get(value: unknown, key: string, fallback?: unknown): unknown {
  if (!isObject(value)) throw new TypeError(`not a JSON object: ${JSON.stringify(value)}`);
  return key in value ? value[key] : fallback;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// JSON truthiness as Python has it, where an empty list or object is false
function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

// null for a missing file
function readIfPresent(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

// null for anything that is not a readable, non-empty file
function readIfFile(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8") || null;
  } catch {
    return null;
  }
}

function errorCode(e: unknown): string {
  return (e as NodeJS.ErrnoException).code ?? (e as Error).message;
}
