import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { cursorPrompt, executeCursor, prepareCursor, shellQuote, type CursorExecution } from "./cursor.ts";
import type { DirectResult, DirectStart } from "./direct.ts";

// A fake cursor-agent that records what it was given, then answers the way
// the real one reports: FAKE_OUTPUT replaces its stdout, FAKE_STDERR is
// written to stderr, and FAKE_EXIT is its exit code
const FAKE = `#!${process.execPath}
import fs from "node:fs";
let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;
const env = process.env;
if (env.FAKE_ARGS) fs.writeFileSync(env.FAKE_ARGS, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), ppid: process.ppid, stdin, env }));
if (env.FAKE_STDERR) process.stderr.write(env.FAKE_STDERR);
process.stdout.write(env.FAKE_OUTPUT ?? '{"is_error":false,"session_id":"c-1","result":"hello from cursor"}\\n');
process.exitCode = Number(env.FAKE_EXIT ?? 0);
`;

// The direct owner's part: one executeCursor call in a process of its own,
// with the environment the CLI gave it
const OWNER = `
import fs from "node:fs";
import { executeCursor } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "cursor.ts")).href)};
const job = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const started = [];
const result = await executeCursor(job.input, new AbortController().signal, (start) => started.push(start));
fs.writeFileSync(job.result, JSON.stringify({ result, started }));
`;

type Recorded = { argv: string[]; cwd: string; ppid: number; stdin: string; env: Record<string, string> };

const BRIEF = "Do the thing.\n";

function scratch() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cursor-test-")));
  const home = path.join(root, "home");
  const target = path.join(root, "target");
  fs.mkdirSync(home);
  fs.mkdirSync(target);
  const agent = path.join(root, "cursor-agent.mjs");
  fs.writeFileSync(agent, FAKE, { mode: 0o755 });
  const owner = path.join(root, "owner.mjs");
  fs.writeFileSync(owner, OWNER);
  let runs = 0;
  // The owner needs the test's PATH for ps and lsof, and NODE_OPTIONS reaches
  // every node it starts
  const envOf = (extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
    HOME: home,
    PATH: process.env.PATH,
    ...(process.env.NODE_OPTIONS === undefined ? {} : { NODE_OPTIONS: process.env.NODE_OPTIONS }),
    ...extra,
  });
  const inputOf = (out: string, over: Partial<CursorExecution>): CursorExecution => ({
    provider: "cursor",
    out,
    target,
    gitRoot: null,
    mode: "read",
    model: "auto",
    executable: agent,
    ...over,
  });
  // What the CLI does before it claims a run, whose refusal, if any, is returned
  const refusal = (over: Partial<CursorExecution> = {}, extra: NodeJS.ProcessEnv = {}) => prepareCursor(inputOf(root, over), envOf(extra));
  // The CLI's part, then the owner's, in a fresh run directory
  const run = async (over: Partial<CursorExecution> = {}, extra: NodeJS.ProcessEnv = {}, between = () => {}) => {
    const out = path.join(root, `run-${++runs}`);
    fs.mkdirSync(out);
    const input = inputOf(out, over);
    const env = envOf(extra);
    assert.equal(prepareCursor(input, env), null);
    fs.writeFileSync(path.join(out, "prompt.md"), cursorPrompt(input, BRIEF));
    between();
    const job = path.join(root, `job-${runs}.json`);
    const resultFile = path.join(root, `result-${runs}.json`);
    fs.writeFileSync(job, JSON.stringify({ input, result: resultFile }));
    const child = spawn(process.execPath, [owner, job], { env, stdio: ["ignore", "inherit", "inherit"] });
    await once(child, "exit");
    const { result, started } = JSON.parse(fs.readFileSync(resultFile, "utf8")) as { result: DirectResult; started: DirectStart[] };
    const read = (name: string) => fs.readFileSync(path.join(out, name), "utf8");
    return { out, result, started, read };
  };
  const recorded = (file: string): Recorded => JSON.parse(fs.readFileSync(file, "utf8")) as Recorded;
  return { root, home, target, agent, refusal, run, recorded, configDir: path.join(home, ".config", "delegate", "cursor-config") };
}

const ok = (detail: string, sessionId = "c-1"): DirectResult => ({ exitCode: 0, sessionId, detail, failed: false, cleanup: { kind: "done", leftover: 0 } });
const fail = (detail: string, sessionId: string, exitCode: number | null = 0): DirectResult => ({ exitCode, sessionId, detail, failed: true, cleanup: { kind: "done", leftover: 0 } });

// The executor takes the git root the run CLI found, so a plain directory stands in for a repo
function repoDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test("a read run gets the exact argv, stdin, workspace, and environment, and saves its answer and session", async () => {
  const s = scratch();
  const args = path.join(s.root, "args.json");
  const { out, result, started, read } = await s.run(
    {},
    { FAKE_ARGS: args, CURSOR_API_KEY: "key-1", DELEGATE_WORKER_PATH: "/caller/bin:/usr/bin:/bin", GROK_AGENT: "1", CODEX_SESSION_ID: "x", OPENCODE: "1", OPENCODE_PID: "2" },
  );
  assert.deepEqual(result, ok("read"));
  const got = s.recorded(args);
  // The owner records and signals the supervisor, the worker's parent and group leader
  assert.equal(started.length, 1);
  assert.equal(started[0]?.pid, got.ppid);
  assert.equal(started[0]?.pgid, got.ppid);
  assert.match(started[0]?.start ?? "", /^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/);
  const workspace = path.join(out, "workspace");
  assert.deepEqual(got.argv, ["-p", "--trust", "--output-format", "json", "--workspace", workspace, "--model", "auto", "--sandbox", "enabled"]);
  assert.equal(got.cwd, workspace);
  assert.equal(
    got.stdin,
    `Runner rules:
- Do not commit, switch branches, or change git history unless the brief asks.
- The target is ${s.target}. When the brief says the repo or working directory, it means this path. Use absolute paths or \`cd ${s.target} && ...\`.
- Your workspace is an empty scratch directory. Put temporary files there and nowhere else.
- Any shell command runs. Everything outside the workspace is read-only, so a write there fails with "Operation not permitted". Report it and go on.

Do the thing.
`,
  );
  assert.equal(got.env.CURSOR_CONFIG_DIR, s.configDir);
  assert.equal(got.env.CURSOR_API_KEY, "key-1");
  assert.equal(got.env.PATH, "/caller/bin:/usr/bin:/bin");
  assert.deepEqual(
    ["GROK_AGENT", "CODEX_SESSION_ID", "OPENCODE", "OPENCODE_PID", "DELEGATE_WORKER_PATH"].filter((name) => name in got.env),
    [],
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(workspace, ".cursor", "sandbox.json"), "utf8")), { additionalReadonlyPaths: [s.target] });
  assert.equal(read("answer.md"), "hello from cursor\n");
  assert.equal(read("session_id"), "c-1\n");
  assert.equal(fs.readFileSync(path.join(s.home, ".config", "delegate", "cursor-sessions", "c-1"), "utf8"), `${workspace}\n`);
  assert.equal(fs.existsSync(path.join(out, "status")), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.configDir, "cli-config.json"), "utf8")), {
    version: 1,
    autoAcceptWebSearch: true,
    permissions: { allow: [], deny: [] },
  });
});

test("a resumed read run starts in the workspace its session started in, which now lists the new target", async () => {
  const s = scratch();
  const first = await s.run();
  const other = path.join(s.root, "other-target");
  fs.mkdirSync(other);
  const args = path.join(s.root, "args.json");
  const second = await s.run({ target: other, resume: "c-1" }, { FAKE_ARGS: args });
  const workspace = path.join(first.out, "workspace");
  const got = s.recorded(args);
  assert.equal(got.cwd, workspace);
  assert.deepEqual(got.argv.slice(-4), ["--sandbox", "enabled", "--resume", "c-1"]);
  assert.equal(fs.existsSync(path.join(second.out, "workspace")), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(workspace, ".cursor", "sandbox.json"), "utf8")), { additionalReadonlyPaths: [other] });
});

test("a write run works in the target itself, and full access swaps the sandbox for --force", async () => {
  const s = scratch();
  const repo = repoDir(path.join(s.root, "repo"));
  const args = path.join(s.root, "args.json");
  const write = await s.run({ target: repo, gitRoot: repo, mode: "write", resume: "w-1" }, { FAKE_ARGS: args });
  let got = s.recorded(args);
  assert.deepEqual(write.result, ok("write"));
  assert.deepEqual(got.argv, ["-p", "--trust", "--output-format", "json", "--workspace", repo, "--model", "auto", "--sandbox", "enabled", "--resume", "w-1"]);
  assert.equal(got.cwd, repo);
  assert.equal(
    got.stdin,
    `Runner rules:
- Do not commit, switch branches, or change git history unless the brief asks.
- Your workspace is the repo. Edit files in place. The parent reviews \`git diff\` when you finish.
- Any shell command runs. A write outside the workspace fails with "Operation not permitted", and the shell has no network. Report it and go on.

Do the thing.
`,
  );
  assert.equal(fs.existsSync(path.join(s.home, ".config", "delegate", "cursor-sessions", "c-1")), false);

  const full = await s.run({ target: repo, gitRoot: repo, mode: "write", fullAccess: true, model: "m1" }, { FAKE_ARGS: args });
  got = s.recorded(args);
  assert.deepEqual(full.result, ok("write full-access"));
  assert.deepEqual(got.argv, ["-p", "--trust", "--output-format", "json", "--workspace", repo, "--model", "m1", "--force"]);
  assert.equal(got.stdin.split("\n")[3], `- The sandbox is off. Write nothing outside ${repo}.`);
});

test("a read prompt names the rules files from the repo root down to the target, and its cd works in a shell", () => {
  const s = scratch();
  const repo = repoDir(path.join(s.root, "repo"));
  const target = path.join(repo, "my pkg's $HOME");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "");
  fs.writeFileSync(path.join(repo, "CLAUDE.md"), "");
  fs.writeFileSync(path.join(target, "CLAUDE.md"), "");
  const lines = cursorPrompt({ target, gitRoot: repo, mode: "read" }, BRIEF).split("\n");
  assert.deepEqual(lines.slice(3, 5), [
    `- Read ${repo}/AGENTS.md before you start. It does not load on its own here.`,
    `- Read ${target}/CLAUDE.md before you start. It does not load on its own here.`,
  ]);
  const cd = /`(cd .*) && \.\.\.`/.exec(lines[2] ?? "")?.[1];
  assert.ok(cd, lines[2]);
  assert.equal(execFileSync("/bin/sh", ["-c", `${cd} && pwd -P`], { encoding: "utf8" }), `${target}\n`);
});

test("shellQuote leaves a plain path bare and quotes anything a shell would read", () => {
  for (const s of ["/Users/me/dev/repo", "/a b/c", "it's", "$HOME", "a\nb", "é/x", "*", "~", "#x", ""]) {
    const quoted = shellQuote(s);
    assert.equal(execFileSync("/bin/sh", ["-c", `printf %s ${quoted}`], { encoding: "utf8" }), s, quoted);
  }
  assert.equal(shellQuote("/Users/me/dev/repo"), "/Users/me/dev/repo");
});

test("a result with is_error fails despite exit 0 and names the model it rejected", async () => {
  const s = scratch();
  const output = '{"is_error":true,"session_id":"c-2","result":"Cannot use this model: bad-model. Available models: auto"}\n';
  const { result, read } = await s.run({ model: "bad-model" }, { FAKE_OUTPUT: output });
  assert.deepEqual(result, fail("read exit=0 is_error=True model rejected: Cannot use this model: bad-model. Available models: auto", "c-2"));
  assert.equal(read("session_id"), "c-2\n");
});

test("a signed-out worker fails with its exit code and no session", async () => {
  const s = scratch();
  const stderr = "Error: Authentication required. Run 'agent login', pass --api-key/--auth-token, or set CURSOR_API_KEY/CURSOR_AUTH_TOKEN.\n";
  const { result, read } = await s.run({ model: "needs-login" }, { FAKE_OUTPUT: "", FAKE_STDERR: stderr, FAKE_EXIT: "1" });
  assert.deepEqual(result, fail("read exit=1 is_error=unknown", "", 1));
  assert.equal(read("session_id"), "\n");
  assert.equal(read("stderr.log"), stderr);
});

test("a result with no answer or no JSON fails, though the worker exited 0", async () => {
  const s = scratch();
  const empty = await s.run({}, { FAKE_OUTPUT: '{"is_error":false,"session_id":"c-3","result":""}' });
  assert.deepEqual(empty.result, fail("read exit=0 is_error=False", "c-3"));
  const text = await s.run({}, { FAKE_OUTPUT: "not json\n" });
  assert.deepEqual(text.result, fail("read exit=0 is_error=unknown", ""));
});

test("a worker that cannot start fails the run with nothing to clean up, and onStarted never fires", async () => {
  const s = scratch();
  const missing = path.join(s.root, "no-such-agent");
  const { result, started } = await s.run({ executable: missing });
  assert.deepEqual(result, fail(`cannot start ${missing}: ENOENT`, "", null));
  assert.deepEqual(started, []);
});

test("the executor refuses repo config that came to widen the sandbox after the CLI checked it", async () => {
  const s = scratch();
  const repo = repoDir(path.join(s.root, "repo"));
  const args = path.join(s.root, "args.json");
  const widen = () => {
    fs.mkdirSync(path.join(repo, ".cursor"));
    fs.writeFileSync(path.join(repo, ".cursor", "cli.json"), '{"permissions":{"allow":["Shell(ls)"]}}');
  };
  const { result, started } = await s.run({ target: repo, gitRoot: repo, mode: "write" }, { FAKE_ARGS: args }, widen);
  assert.deepEqual(result, fail(`${repo}/.cursor/cli.json allows commands, which would widen the sandbox. Remove it first.`, "", null));
  assert.deepEqual(started, []);
  assert.equal(fs.existsSync(args), false);
});

test("a resumed read run refuses a missing workspace and does not recreate it", async () => {
  const s = scratch();
  const first = await s.run();
  const workspace = path.join(first.out, "workspace");
  assert.equal(fs.existsSync(workspace), true);
  fs.rmSync(workspace, { recursive: true, force: true });
  assert.equal(s.refusal({ resume: "c-1" }), `session workspace expired: ${workspace}. Start a new run.`);
  assert.equal(fs.existsSync(workspace), false);
  const out = path.join(s.root, "resume-missing");
  fs.mkdirSync(out);
  const result = await executeCursor(
    {
      provider: "cursor",
      out,
      target: s.target,
      gitRoot: null,
      mode: "read",
      model: "auto",
      executable: s.agent,
      resume: "c-1",
      workspaceSource: workspace,
    },
    new AbortController().signal,
    () => {},
  );
  assert.equal(result.failed, true);
  assert.match(result.detail, /session workspace expired/);
  assert.equal(fs.existsSync(workspace), false);
});

test("Cursor refuses a host that is Cursor, an unknown read session, and a config it cannot prepare", () => {
  const s = scratch();
  assert.equal(s.refusal({}, { CURSOR_AGENT: "1" }), "delegate run --cli cursor: this host is cursor, so use its native subagents");
  assert.equal(s.refusal({ resume: "no-such-session" }), "no workspace recorded for Cursor read session no-such-session. Start a new run.");
  assert.equal(s.refusal({ resume: "../c-1" }), "no workspace recorded for Cursor read session ../c-1. Start a new run.");
  // A write run keeps its workspace, so it resumes any session
  const repo = repoDir(path.join(s.root, "repo"));
  assert.equal(s.refusal({ target: repo, gitRoot: repo, mode: "write", resume: "no-such-session" }), null);
  fs.writeFileSync(path.join(s.configDir, "cli-config.json"), "{");
  assert.equal(s.refusal(), `cannot prepare ${s.configDir}/cli-config.json`);
});

test("the private config's allow list is emptied whenever it has entries, and every other key stays", () => {
  const s = scratch();
  const file = path.join(s.configDir, "cli-config.json");
  fs.mkdirSync(s.configDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, model: "x", permissions: { allow: ["Shell(ls)"], deny: ["Shell(rm)"] } }));
  assert.equal(s.refusal(), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { version: 1, model: "x", permissions: { allow: [], deny: ["Shell(rm)"] } });
  const untouched = '{ "version": 1, "permissions": { "allow": [] } }';
  fs.writeFileSync(file, untouched);
  assert.equal(s.refusal(), null);
  assert.equal(fs.readFileSync(file, "utf8"), untouched);
});

test("a write run refuses repo config that would widen the sandbox, in the target or its repo root", () => {
  const s = scratch();
  const repo = repoDir(path.join(s.root, "repo"));
  const target = path.join(repo, "pkg");
  fs.mkdirSync(path.join(target, ".cursor"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".cursor"));
  const write = (over: Partial<CursorExecution> = {}) => s.refusal({ target, gitRoot: repo, mode: "write", ...over });
  const cases: [string, string, string, string][] = [
    [repo, "cli.json", '{"permissions":{"allow":["Shell(ls)"]}}', `${repo}/.cursor/cli.json allows commands`],
    [target, "sandbox.json", '{"additionalReadwritePaths":["/"]}', `${target}/.cursor/sandbox.json lists additionalReadwritePaths`],
    [target, "sandbox.json", '{"type":"insecure_none"}', `${target}/.cursor/sandbox.json sets type insecure_none`],
  ];
  for (const [root, name, text, found] of cases) {
    const file = path.join(root, ".cursor", name);
    fs.writeFileSync(file, text);
    assert.equal(write(), `${found}, which would widen the sandbox. Remove it first.`);
    // Full access has no sandbox to widen, and a read run's workspace is not the repo
    assert.equal(write({ fullAccess: true }), null);
    assert.equal(s.refusal({ target, gitRoot: repo }), null);
    fs.rmSync(file);
  }
  fs.writeFileSync(path.join(target, ".cursor", "cli.json"), '{"permissions":{"allow":[]}}');
  fs.writeFileSync(path.join(target, ".cursor", "sandbox.json"), '{"additionalReadwritePaths":[],"type":"workspace_readwrite"}');
  assert.equal(write(), null);
  fs.writeFileSync(path.join(repo, ".cursor", "sandbox.json"), "[]");
  assert.equal(write(), `cannot read the Cursor config in ${target}`);
});
