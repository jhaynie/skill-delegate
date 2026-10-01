import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import type { DirectCleanup, DirectResult, DirectStart } from "./direct.ts";
import { executing } from "./procs.ts";
import { NO_PROCESS_LIST, NO_WRITER_LIST } from "./cursor-supervisor.ts";

// What a Cursor run stops when it ends, is stopped, or its owner is killed,
// and what it leaves alone, with real processes. The owner here stands in
// for the direct owner: it runs one executeCursor call, aborts it on
// SIGTERM, and writes the result as JSON.

const LINUX_PROC = fs.existsSync("/proc/self/fd");
const node = process.execPath;

const OWNER = `
import fs from "node:fs";
import { executeCursor } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "cursor.ts")).href)};
const job = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
fs.writeFileSync(job.ownerPid, String(process.pid));
const controller = new AbortController();
process.on("SIGTERM", () => controller.abort());
if (job.abortFirst) controller.abort();
const running = executeCursor(job.input, controller.signal, (start) => {
  fs.writeFileSync(job.started, JSON.stringify(start));
  if (job.throwOnStart) throw new Error("run.json is read-only");
});
if (job.abortSoon) setImmediate(() => controller.abort());
fs.writeFileSync(job.result, JSON.stringify(await running));
`;

// A fake cursor-agent. Each FAKE_* variable makes it leave, detach, or hang
// on a process the way a worker can, and names the file that gets its pid.
// Then it answers the way the real one does.
const AGENT = `#!${node}
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const env = process.env;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const script = (name) => path.join(import.meta.dirname, name);
const sleeper = (ms, opts) => spawn(process.execPath, [script("sleeper.mjs"), String(ms)], opts);
for await (const _ of process.stdin);
if (env.FAKE_WAIT) while (!fs.existsSync(env.FAKE_WAIT)) await sleep(50);
if (env.FAKE_SETSID) {
  const child = sleeper(30000, { detached: true, stdio: "ignore" });
  fs.writeFileSync(env.FAKE_SETSID, String(child.pid));
  child.unref();
  await sleep(2000);
}
if (env.FAKE_READONLY) fs.chmodSync(env.FAKE_READONLY, 0o555);
if (env.FAKE_IGNORE_TERM) process.on("SIGTERM", () => {});
if (env.FAKE_STOP) process.kill(Number(fs.readFileSync(env.FAKE_STOP, "utf8")), "SIGTERM");
if (env.FAKE_DETACH) {
  spawn(process.execPath, [script("double-fork.mjs"), env.FAKE_DETACH], { detached: true, stdio: ["ignore", "inherit", "inherit"] }).unref();
  await sleep(1000);
}
if (env.FAKE_HANG) {
  fs.writeFileSync(env.FAKE_HANG, String(process.pid));
  await sleep(30000);
}
if (env.FAKE_ORPHAN) {
  spawn(process.execPath, [script("orphan-parent.mjs"), env.FAKE_ORPHAN], { stdio: "ignore" }).unref();
  const until = Date.now() + 10_000;
  for (;;) {
    try {
      const pid = Number(fs.readFileSync(env.FAKE_ORPHAN, "utf8"));
      if (Number.isInteger(pid) && pid > 0) break;
    } catch {}
    if (Date.now() >= until) throw new Error("orphan fixture did not publish its grandchild PID");
    await sleep(50);
  }
}
if (env.FAKE_LEAVE) {
  const child = sleeper(30000, { stdio: "ignore" });
  fs.writeFileSync(env.FAKE_LEAVE, String(child.pid));
  child.unref();
}
process.stdout.write('{"is_error":false,"session_id":"c-1","result":"hello from cursor"}\\n');
process.exit(0);
`;

const SCRIPTS: Record<string, string> = {
  "sleeper.mjs": "setTimeout(() => {}, Number(process.argv[2]));",
  // Starts in a session of its own, starts a grandchild that keeps the
  // worker's stdout and stderr, and exits at once, so no parent chain links
  // the grandchild to the run
  "double-fork.mjs": `
import { spawn } from "node:child_process";
import fs from "node:fs";
const child = spawn(process.execPath, [new URL("sleeper.mjs", import.meta.url).pathname, "25000"], { stdio: ["ignore", "inherit", "inherit"] });
fs.writeFileSync(process.argv[2], String(child.pid));
process.exit(0);`,
  // Starts a middle process in a session of its own and exits a second
  // later. The middle starts a child a second after that, with no file of
  // the run's open, so only the notes the run took link it to the worker.
  "orphan-parent.mjs": `
import { spawn } from "node:child_process";
spawn(process.execPath, [new URL("orphan-middle.mjs", import.meta.url).pathname, process.argv[2]], { detached: true, stdio: "ignore" }).unref();
setTimeout(() => process.exit(0), 1000);`,
  "orphan-middle.mjs": `
import { spawn } from "node:child_process";
import fs from "node:fs";
setTimeout(() => {
  const child = spawn(process.execPath, [new URL("sleeper.mjs", import.meta.url).pathname, "30000"], { stdio: "ignore" });
  const tmp = process.argv[2] + ".tmp";
  fs.writeFileSync(tmp, String(child.pid));
  fs.renameSync(tmp, process.argv[2]);
}, 2000);
setTimeout(() => {}, 30000);`,
  // Opens stdout.raw for append once the run creates it, then says so
  "collector.mjs": `
import fs from "node:fs";
while (!fs.existsSync(process.argv[2])) await new Promise((resolve) => setTimeout(resolve, 50));
fs.openSync(process.argv[2], "a");
fs.writeFileSync(process.argv[3], "");
setTimeout(() => {}, 60000);`,
};

const bin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cursor-lifecycle-bin-")));
fs.writeFileSync(path.join(bin, "owner.mjs"), OWNER);
fs.writeFileSync(path.join(bin, "cursor-agent.mjs"), AGENT, { mode: 0o755 });
for (const [name, body] of Object.entries(SCRIPTS)) fs.writeFileSync(path.join(bin, name), body);

type Dir = { dir: string; file: (name: string) => string };

// A directory for one run, whose *.pid files name processes a fake started.
// Any still alive when the test ends get SIGKILL.
function runDir(t: TestContext): Dir {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cursor-lifecycle-")));
  const file = (name: string) => path.join(dir, name);
  t.after(() => {
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".pid") && n !== "owner.pid")) {
      const pid = Number(fs.readFileSync(file(name), "utf8"));
      if (pid > 0 && alive(pid)) process.kill(pid, "SIGKILL");
    }
  });
  return { dir, file };
}

type Run = Dir & {
  out: string;
  ownerPid: () => number;
  started: () => DirectStart | null;
  exited: Promise<unknown>;
  result: () => Promise<DirectResult>;
};

type RunOptions = {
  at?: Dir;
  target?: string;
  mode?: "read" | "write";
  // The owner's, so the fake cursor-agent's too
  env?: (file: (name: string) => string) => Record<string, string>;
  // Fake ps or lsof scripts, first on the owner's PATH
  tools?: Record<string, string>;
  abortFirst?: boolean;
  abortSoon?: boolean;
  throwOnStart?: boolean;
};

// One owner process for one run, in a run directory that has prompt.md, as
// the CLI leaves it
function startRun(t: TestContext, opts: RunOptions = {}): Run {
  const { dir, file } = opts.at ?? runDir(t);
  const out = file("out");
  const target = opts.target ?? file("target");
  fs.mkdirSync(out);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(out, "prompt.md"), "brief\n");
  const tools = file("tools");
  fs.mkdirSync(tools);
  for (const [name, body] of Object.entries(opts.tools ?? {})) fs.writeFileSync(path.join(tools, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const mode = opts.mode ?? "read";
  const job = {
    ownerPid: file("owner.pid"),
    started: file("started.json"),
    result: file("result.json"),
    abortFirst: opts.abortFirst ?? false,
    abortSoon: opts.abortSoon ?? false,
    throwOnStart: opts.throwOnStart ?? false,
    input: { provider: "cursor", out, target, gitRoot: mode === "read" ? null : target, mode, model: "auto", executable: path.join(bin, "cursor-agent.mjs") },
  };
  fs.writeFileSync(file("job.json"), JSON.stringify(job));
  const { CURSOR_AGENT: _, ...env } = process.env;
  const owner = spawn(node, [path.join(bin, "owner.mjs"), file("job.json")], {
    env: { ...env, HOME: dir, PATH: `${tools}:${process.env.PATH}`, ...opts.env?.(file) },
    stdio: ["ignore", "ignore", fs.openSync(file("owner.err"), "w")],
  });
  const exited = once(owner, "exit");
  t.after(() => owner.kill("SIGKILL"));
  const readJson = <T>(name: string): T | null => (fs.existsSync(file(name)) ? (JSON.parse(fs.readFileSync(file(name), "utf8")) as T) : null);
  return {
    dir,
    file,
    out,
    ownerPid: () => Number(fs.readFileSync(job.ownerPid, "utf8")),
    started: () => readJson<DirectStart>("started.json"),
    exited,
    result: async () => {
      await exited;
      const result = readJson<DirectResult>("result.json");
      if (result === null) assert.fail(`the owner wrote no result: ${fs.readFileSync(file("owner.err"), "utf8")}`);
      return result;
    },
  };
}

// Only ESRCH proves a pid gone
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function until(done: () => boolean, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 100))) {
    if (done()) return true;
  }
  return done();
}

// The pid in a file a fake wrote, once it has
async function pidIn(file: string, ms = 10_000): Promise<number> {
  assert.ok(await until(() => fs.existsSync(file) && fs.readFileSync(file, "utf8") !== "", ms), `nothing wrote ${file}`);
  return Number(fs.readFileSync(file, "utf8"));
}

function gone(pid: number, ms: number): Promise<boolean> {
  return until(() => !executing(pid), ms);
}

// A process of the test's own that no run started
function control(t: TestContext, script: string, args: string[], cwd?: string): number {
  const child = spawn(node, [path.join(bin, script), ...args], { cwd, detached: true, stdio: "ignore" });
  child.unref();
  t.after(() => child.kill());
  return child.pid!;
}

const done = (leftover: number): DirectCleanup => ({ kind: "done", leftover });
const unsure = (...notes: string[]): DirectCleanup => ({ kind: "uncertain", detail: notes.join("; ") });
const ok = (detail: string, cleanup: DirectCleanup): DirectResult => ({ exitCode: 0, sessionId: "c-1", detail, failed: false, cleanup });
const stopped = (exitCode: number | null, cleanup: DirectCleanup): DirectResult => ({
  exitCode,
  sessionId: "",
  detail: `read exit=${exitCode ?? "null"} stopped`,
  failed: true,
  cleanup,
  endedBy: "stop",
});
// A worker the supervisor stopped with SIGTERM
const TERMINATED = 128 + os.constants.signals.SIGTERM;

describe("Cursor run lifecycle", { concurrency: true }, () => {
  test("a process the worker leaves in its group is stopped and counted, and a matching process another run started in the repo is not", async (t) => {
    const at = runDir(t);
    const repo = at.file("wt2");
    fs.mkdirSync(repo);
    const sibling = control(t, "sleeper.mjs", ["60000"], repo);
    const run = startRun(t, { at, target: repo, mode: "write", env: (f) => ({ FAKE_LEAVE: f("left.pid") }) });
    assert.deepEqual(await run.result(), ok("write", done(1)));
    assert.equal(await gone(await pidIn(run.file("left.pid")), 1_000), true, "the process left in the group still runs");
    assert.equal(alive(sibling), true, "another run's process was stopped");
  });

  test("a process the worker started in a session of its own is stopped too", async (t) => {
    const run = startRun(t, { env: (f) => ({ FAKE_SETSID: f("setsid.pid") }) });
    assert.deepEqual(await run.result(), ok("read", done(1)));
    assert.equal(await gone(await pidIn(run.file("setsid.pid")), 1_000), true, "the setsid child still runs");
  });

  test("a setsid process stays tracked after its parent exits, so a child it starts later is stopped too", async (t) => {
    const run = startRun(t, { env: (f) => ({ FAKE_ORPHAN: f("orphan.pid") }) });
    assert.deepEqual(await run.result(), ok("read", done(2)));
    assert.equal(await gone(await pidIn(run.file("orphan.pid")), 1_000), true, "the orphaned middle's child still runs");
  });

  test("a stopped run stops the worker's group and the process that left it before it returns", async (t) => {
    const run = startRun(t, { env: (f) => ({ FAKE_SETSID: f("setsid.pid"), FAKE_HANG: f("hang.pid") }) });
    const worker = await pidIn(run.file("hang.pid"));
    process.kill(run.ownerPid(), "SIGTERM");
    assert.deepEqual(await run.result(), stopped(TERMINATED, done(2)));
    assert.equal(executing(worker), false, "the hung worker still runs");
    assert.equal(executing(await pidIn(run.file("setsid.pid"))), false, "the setsid child still runs");
    assert.equal(fs.existsSync(path.join(run.out, "answer.md")), false);
  });

  test("a worker that ignores SIGTERM leaves the stop uncertain, and gets no harder signal", async (t) => {
    const run = startRun(t, { env: (f) => ({ FAKE_IGNORE_TERM: "1", FAKE_HANG: f("hang.pid") }) });
    const worker = await pidIn(run.file("hang.pid"));
    process.kill(run.ownerPid(), "SIGTERM");
    assert.deepEqual(await run.result(), stopped(null, unsure(`still running 3 s after SIGTERM: ${worker}`)));
    assert.equal(alive(worker), true, "the worker got more than SIGTERM");
  });

  test("an owner that cannot record the started worker stops it, and the run fails with why", async (t) => {
    const run = startRun(t, { throwOnStart: true, env: (f) => ({ FAKE_HANG: f("hang.pid") }) });
    const result = await run.result();
    assert.deepEqual(result, { exitCode: TERMINATED, sessionId: "", detail: "read cannot record the started worker: run.json is read-only", failed: true, cleanup: done(1) });
    assert.equal(executing(await pidIn(run.file("hang.pid"))), false, "the worker still runs");
  });

  test("a run whose directory turns read-only while the worker runs still ends, with the failures to save its result", async (t) => {
    const run = startRun(t, { env: (f) => ({ FAKE_READONLY: f("out") }) });
    t.after(() => fs.chmodSync(run.out, 0o755));
    assert.deepEqual(await run.result(), {
      exitCode: 0,
      sessionId: "c-1",
      detail: "read exit=0 is_error=False cannot save answer.md: EACCES cannot save session_id: EACCES",
      failed: true,
      cleanup: done(0),
    });
  });

  test("a run stopped as its worker starts stops the worker, even when ps fails", async (t) => {
    const run = startRun(t, { env: (f) => ({ FAKE_STOP: f("owner.pid"), FAKE_HANG: f("hang.pid") }), tools: { ps: "exit 1" } });
    assert.deepEqual(await run.result(), stopped(TERMINATED, unsure(NO_PROCESS_LIST, NO_WRITER_LIST)));
    const hang = run.file("hang.pid");
    assert.equal(fs.existsSync(hang) && executing(Number(fs.readFileSync(hang, "utf8"))), false, "the worker still runs");
  });

  test("a run aborted before it starts launches nothing", async (t) => {
    const run = startRun(t, { abortFirst: true, env: (f) => ({ FAKE_HANG: f("hang.pid") }) });
    assert.deepEqual(await run.result(), stopped(null, done(0)));
    assert.deepEqual(fs.readdirSync(run.out), ["prompt.md"]);
    assert.equal(run.started(), null);
  });

  test("a run aborted while its supervisor starts leaves no worker running", async (t) => {
    const run = startRun(t, { abortSoon: true, env: (f) => ({ FAKE_HANG: f("hang.pid") }) });
    const result = await run.result();
    assert.equal(result.failed, true);
    assert.match(result.detail, / stopped$/);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const hang = run.file("hang.pid");
    assert.equal(fs.existsSync(hang) && executing(Number(fs.readFileSync(hang, "utf8"))), false, "a worker outlived the stop");
  });

  for (const hungPs of [false, true]) {
    test(`an owner killed with SIGKILL leaves no worker group behind${hungPs ? ", even while its ps hangs" : ""}`, async (t) => {
      const at = runDir(t);
      const unrelated = control(t, "sleeper.mjs", ["60000"]);
      const mark = at.file("ps.pid");
      const tools: Record<string, string> = hungPs ? { ps: `case "$*" in *-A*) echo $$ > ${mark}; exec sleep 300 ;; esac\nPATH="\${PATH#*:}" exec ps "$@"` } : {};
      const run = startRun(t, { at, tools, env: (f) => ({ FAKE_HANG: f("hang.pid") }) });
      const hang = await pidIn(run.file("hang.pid"));
      if (hungPs) await pidIn(mark);
      assert.ok(await until(() => run.started() !== null, 5_000), "the owner never reported the worker started");
      const start = run.started()!;
      assert.equal(start.pid, start.pgid);
      process.kill(run.ownerPid(), "SIGKILL");
      assert.equal(await until(() => !executing(hang), 12_000), true, `the worker ${hang} outlived its owner`);
      assert.equal(executing(unrelated), true, "a process no run started was stopped");
    });
  }

  test("a double-forked grandchild that holds the run's files is stopped and counted", async (t) => {
    const run = startRun(t, { env: (f) => ({ FAKE_DETACH: f("detach.pid") }) });
    assert.deepEqual(await run.result(), ok("read", done(1)));
    assert.equal(executing(await pidIn(run.file("detach.pid"))), false, "the grandchild still runs");
  });

  test("an owner killed with SIGKILL leaves no double-forked grandchild that holds the run's files", async (t) => {
    const run = startRun(t, { env: (f) => ({ FAKE_DETACH: f("detach.pid"), FAKE_HANG: f("hang.pid") }) });
    await pidIn(run.file("hang.pid"));
    const detached = await pidIn(run.file("detach.pid"));
    process.kill(run.ownerPid(), "SIGKILL");
    assert.equal(await gone(detached, 12_000), true, "the grandchild outlived the owner");
  });

  test("a writer of the run's files that started before the run is left alone and not counted", async (t) => {
    const at = runDir(t);
    const collector = control(t, "collector.mjs", [at.file("out/stdout.raw"), at.file("ready")]);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const run = startRun(t, { at, env: (f) => ({ FAKE_WAIT: f("ready") }) });
    assert.deepEqual(await run.result(), ok("read", done(0)));
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(alive(collector), true, "the collector was stopped");
  });

  test("a failing lsof makes the cleanup uncertain", { skip: LINUX_PROC && "Linux reads /proc" }, async (t) => {
    const run = startRun(t, { tools: { lsof: "exit 1" } });
    assert.deepEqual(await run.result(), ok("read", unsure(NO_WRITER_LIST)));
  });

  test("a hung lsof makes the cleanup uncertain within its deadline, and the group still stops", { skip: LINUX_PROC && "Linux reads /proc" }, async (t) => {
    const began = Date.now();
    const run = startRun(t, { env: (f) => ({ FAKE_LEAVE: f("left.pid") }), tools: { lsof: "exec sleep 30" } });
    assert.deepEqual(await run.result(), ok("read", unsure(NO_WRITER_LIST)));
    assert.ok(Date.now() - began < 15_000, `the run took ${Date.now() - began} ms`);
    assert.equal(executing(await pidIn(run.file("left.pid"))), false, "the process left in the group still runs");
  });

  test("an lsof that exits 1 after it found the supervisor makes the cleanup uncertain", { skip: LINUX_PROC && "Linux reads /proc" }, async (t) => {
    const run = startRun(t, { tools: { lsof: "printf 'p%s\\nf8\\nar\\n' \"$PPID\"\nexit 1" } });
    assert.deepEqual(await run.result(), ok("read", unsure(NO_WRITER_LIST)));
  });

  test("a ps that prints the start times and then exits 1 makes the cleanup uncertain", async (t) => {
    const run = startRun(t, { tools: { ps: 'case "$*" in *"pid=,lstart="*) PATH="${PATH#*:}" ps "$@"; exit 1 ;; esac\nPATH="${PATH#*:}" exec ps "$@"' } });
    assert.deepEqual(await run.result(), ok("read", unsure(NO_WRITER_LIST)));
  });

  test("a previously noted detached child is still TERMed when the final process list fails", async (t) => {
    const run = startRun(t, {
      env: (f) => ({ FAKE_SETSID: f("setsid.pid"), FAKE_HANG: f("hang.pid"), FAIL_FINAL_SCAN: f("fail-final-scan") }),
      tools: { ps: 'case "$*" in *-A*) if [ -f "$FAIL_FINAL_SCAN" ]; then exit 1; fi ;; esac\nPATH="${PATH#*:}" exec ps "$@"' },
    });
    const child = await pidIn(run.file("setsid.pid"));
    await pidIn(run.file("hang.pid"));
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    fs.writeFileSync(run.file("fail-final-scan"), "");
    process.kill(run.ownerPid(), "SIGTERM");
    const result = await run.result();
    assert.equal(result.failed, true);
    assert.match(result.cleanup.kind === "uncertain" ? result.cleanup.detail : "", /cannot list processes/);
    assert.equal(await gone(child, 3_000), true, "detached child survived failed final ps");
  });

  test("a failed identity lookup does not TERM a saved pid or an unrelated process", async (t) => {
    const at = runDir(t);
    const sentinel = control(t, "sleeper.mjs", ["60000"]);
    const run = startRun(t, {
      at,
      env: (f) => ({ FAKE_SETSID: f("setsid.pid"), FAKE_HANG: f("hang.pid") }),
      tools: { ps: "exit 1" },
    });
    const child = await pidIn(run.file("setsid.pid"));
    await pidIn(run.file("hang.pid"));
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    process.kill(run.ownerPid(), "SIGTERM");
    const result = await run.result();
    assert.equal(result.failed, true);
    assert.equal(result.cleanup.kind, "uncertain");
    assert.equal(executing(child), true, "a noted pid was signalled without a confirmed identity");
    assert.equal(executing(sentinel), true, "an unrelated process was stopped");
  });

  for (const [label, ps] of [
    ["malformed", 'case "$*" in *"pid=,stat=,lstart="*) echo garbage; exit 0 ;; esac\nPATH="${PATH#*:}" exec ps "$@"'],
    ["failed", 'case "$*" in *"pid=,stat=,lstart="*) exit 1 ;; esac\nPATH="${PATH#*:}" exec ps "$@"'],
  ] as const) {
    test(`a ${label} state probe leaves a live TERM-resistant worker running`, async (t) => {
      const run = startRun(t, {
        env: (f) => ({ FAKE_IGNORE_TERM: "1", FAKE_HANG: f("hang.pid") }),
        tools: { ps },
      });
      const worker = await pidIn(run.file("hang.pid"));
      process.kill(run.ownerPid(), "SIGTERM");
      const result = await run.result();
      assert.equal(result.cleanup.kind, "uncertain");
      assert.equal(alive(worker), true, "a live worker was treated as ended after a bad state probe");
    });
  }

  test("bounded cleanup when per-pid ps hangs", async (t) => {
    const run = startRun(t, {
      env: (f) => ({ FAKE_IGNORE_TERM: "1", FAKE_HANG: f("hang.pid") }),
      tools: { ps: 'case "$*" in *"pid=,stat=,lstart="*) sleep 5 ;; esac\nPATH="${PATH#*:}" exec ps "$@"' },
    });
    await pidIn(run.file("hang.pid"));
    const began = Date.now();
    process.kill(run.ownerPid(), "SIGTERM");
    const result = await run.result();
    assert.ok(Date.now() - began < 7_000, `cleanup exceeded 7 s: ${Date.now() - began} ms`);
    assert.equal(result.cleanup.kind, "uncertain");
  });
});
