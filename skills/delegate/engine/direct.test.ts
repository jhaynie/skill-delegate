import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { createDirect, directFinalLine, forceDirectStop, patchDirect, readDirect, reconcileDirect, requestStop } from "./direct.ts";
import { sameProcess, startTime } from "./procs.ts";
import { ownerLock } from "./run.ts";
import type { RunNonce } from "./state.ts";
import { HOST_MARKERS } from "./workers.ts";

const CLI = path.join(import.meta.dirname, "cli.ts");

function cliEnv(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DELEGATE_OUT_ROOT: root, ...extra };
  for (const name of HOST_MARKERS) {
    if (!Object.hasOwn(extra, name)) delete env[name];
  }
  return env;
}

function delegate(
  root: string,
  args: string[],
  extra: NodeJS.ProcessEnv = {},
  timeout = 30_000,
): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: cliEnv(root, extra),
    timeout,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function scratch(t: { after: (fn: () => void) => void }): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(import.meta.dirname, "..", ".tmp-direct-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeCodex(home: string, body?: string): string {
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, "codex"),
    body ??
      `#!/bin/sh
answer=""
while [ $# -gt 0 ]; do [ "$1" = -o ] && answer="$2"; shift; done
cat > /dev/null
[ -z "\${FAKE_SLOW:-}" ] || sleep "$FAKE_SLOW"
[ -z "\${FAKE_SILENT:-}" ] && printf 'hello from codex\\n' > "$answer"
printf '%s\\n' '{"type":"thread.started","thread_id":"t-1"}' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}'
`,
    { mode: 0o755 },
  );
  return `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`;
}

function setup(t: { after: (fn: () => void) => void }) {
  const home = scratch(t);
  const target = path.join(home, "target");
  fs.mkdirSync(target);
  execFileSync("git", ["-C", target, "init", "-q"]);
  fs.writeFileSync(path.join(home, "brief.md"), "brief\n");
  const PATH = fakeCodex(home);
  return { home, target, PATH, brief: path.join(home, "brief.md") };
}

function runArgs(s: { target: string; brief: string }, out: string, extra: string[] = []) {
  return ["run", "--cli", "codex", "--cwd", s.target, "--prompt-file", s.brief, "--out", out, ...extra];
}

function killRecorded(dir: string): void {
  if (!fs.existsSync(dir)) return;
  let meta: ReturnType<typeof readDirect> | undefined;
  try {
    meta = readDirect(dir);
  } catch {
    meta = undefined;
  }
  if (meta?.workerPgid !== undefined && sameProcess(meta.workerPgid, meta.workerStart)) {
    try {
      process.kill(-meta.workerPgid, "SIGKILL");
    } catch {
      // already gone
    }
    try {
      process.kill(meta.workerPgid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  const holder = ownerLock(dir).holder();
  if (holder && sameProcess(holder.pid, holder.start)) {
    try {
      process.kill(holder.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

function stopOut(
  t: { after: (fn: () => void) => void },
  home: string,
  out: string,
  extra: NodeJS.ProcessEnv = {},
): void {
  t.after(() => {
    if (fs.existsSync(path.join(out, "run.json"))) delegate(home, ["stop", out], extra, 20_000);
    killRecorded(out);
  });
}

test("default run returns a live line while the worker is still running", async (t) => {
  const s = setup(t);
  const out = path.join(s.home, "live");
  stopOut(t, s.home, out, { PATH: s.PATH });
  const child = spawn(process.execPath, [CLI, ...runArgs(s, out)], {
    env: cliEnv(s.home, { PATH: s.PATH, FAKE_SLOW: "4" }),
  });
  t.after(() => child.kill("SIGTERM"));
  const stdout = await new Promise<string>((resolve) => {
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      if (buf.includes("\n")) resolve(buf);
    });
  });
  assert.match(stdout, /^\[codex \| running \| gpt-6\.1-sol \| high read \| session=- \| out=/);
  assert.equal(fs.existsSync(path.join(out, "status")), false);
  assert.equal(fs.existsSync(path.join(out, "spec.json")), false);
  const meta = readDirect(out);
  assert.equal(meta.provider, "codex");
  assert.ok(meta.nonce);
  assert.ok(ownerLock(out).holder());
});

test("--wait prints one final line and --answer adds a blank line and the body", (t) => {
  const s = setup(t);
  const waitOut = path.join(s.home, "wait");
  const waited = delegate(s.home, runArgs(s, waitOut, ["--wait", "--model", "m1", "--effort", "low"]), { PATH: s.PATH });
  const line = `[codex | ok | m1 | low read in=1 out=2 | session=t-1 | out=${waitOut}]\n`;
  assert.deepEqual(waited, { code: 0, stdout: line, stderr: "" });
  assert.equal(fs.readFileSync(path.join(waitOut, "status"), "utf8"), line);
  const completedAt = readDirect(waitOut).completedAt;
  assert.ok(completedAt !== undefined && completedAt > 0 && completedAt <= Date.now());
  patchDirect(waitOut, { heartbeatAt: Date.now() });
  assert.equal(readDirect(waitOut).completedAt, completedAt);
  const answerOut = path.join(s.home, "answer");
  const answered = delegate(s.home, runArgs(s, answerOut, ["--answer", "--model", "m1", "--effort", "low"]), { PATH: s.PATH });
  assert.deepEqual(answered, { code: 0, stdout: `${line.replace(waitOut, answerOut)}\nhello from codex\n`, stderr: "" });
  assert.deepEqual(delegate(s.home, ["result", answerOut]), answered);
});

test("an empty Codex answer is fail, and a missing binary is fail with no directory", (t) => {
  const s = setup(t);
  const empty = path.join(s.home, "empty");
  const r = delegate(s.home, runArgs(s, empty, ["--wait"]), { PATH: s.PATH, FAKE_SILENT: "1" });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^\[codex \| fail \| gpt-6\.1-sol \| high exit=0 in=1 out=2 \| session=t-1 \| out=/);
  const missing = delegate(s.home, runArgs(s, path.join(s.home, "missing"), ["--wait"]), { PATH: "/usr/bin:/bin" });
  assert.deepEqual(missing, {
    code: 1,
    stdout: "[codex | fail | - | codex is not installed | session=- | out=-]\n",
    stderr: "",
  });
  assert.equal(fs.existsSync(path.join(s.home, "missing")), false);
});

test("same-host Codex refusal and unsupported flags leave no directory", (t) => {
  const s = setup(t);
  const host = delegate(s.home, runArgs(s, path.join(s.home, "host")), { PATH: s.PATH, CODEX_SESSION_ID: "1" });
  assert.equal(host.code, 2);
  assert.match(host.stdout, /this host is codex/);
  assert.equal(fs.existsSync(path.join(s.home, "host")), false);
  const deadline = delegate(s.home, runArgs(s, path.join(s.home, "dead"), ["--deadline", "45m"]), { PATH: s.PATH });
  assert.equal(deadline.code, 2);
  assert.match(deadline.stdout, /does not take --deadline/);
  assert.equal(fs.existsSync(path.join(s.home, "dead")), false);
});

test("send and answer refuse a direct run, status and stop work", (t) => {
  const s = setup(t);
  const out = path.join(s.home, "cmd");
  const started = delegate(s.home, runArgs(s, out, ["--wait", "--model", "m1", "--effort", "low"]), { PATH: s.PATH });
  assert.equal(started.code, 0);
  const sent = delegate(s.home, ["send", out, "hi"]);
  assert.equal(sent.code, 1);
  assert.match(sent.stderr, /unsupported on a direct run/);
  const answered = delegate(s.home, ["answer", out, "r1", "deny"]);
  assert.equal(answered.code, 1);
  assert.match(answered.stderr, /unsupported on a direct run/);
  const status = delegate(s.home, ["status", out]);
  assert.equal(status.stdout, started.stdout);
});

test("stop on a live run ends it", async (t) => {
  const s = setup(t);
  const out = path.join(s.home, "stop-live");
  stopOut(t, s.home, out, { PATH: s.PATH });
  const child = spawn(process.execPath, [CLI, ...runArgs(s, out)], {
    env: cliEnv(s.home, { PATH: s.PATH, FAKE_SLOW: "8" }),
  });
  t.after(() => child.kill("SIGTERM"));
  await new Promise<void>((resolve) => {
    child.stdout.on("data", () => resolve());
  });
  const stopped = delegate(s.home, ["stop", out], { PATH: s.PATH }, 20_000);
  assert.equal(stopped.code, 1);
  assert.match(stopped.stdout, /\[codex \| fail \|/);
  assert.match(stopped.stdout, /stopped/);
  await new Promise((resolve) => child.on("close", resolve));
});

test("a stop.json with the run nonce before start is honored, and another nonce is ignored", (t) => {
  const root = scratch(t);
  const claimed = (name: string) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    assert.equal(ownerLock(dir).lock(), true);
    const identity = createDirect(dir, {
      provider: "codex",
      target: dir,
      gitRoot: null,
      model: "mock",
      mode: "read",
      effort: "medium",
    });
    fs.writeFileSync(path.join(dir, "prompt.md"), "brief\n");
    t.after(() => killRecorded(dir));
    return { dir, identity };
  };
  fs.writeFileSync(
    path.join(root, "owner.mjs"),
    `
import { writeFileSync } from "node:fs";
import { ownDirect } from ${JSON.stringify(path.join(import.meta.dirname, "direct.ts"))};
import { startTime } from ${JSON.stringify(path.join(import.meta.dirname, "procs.ts"))};
const dir = process.argv[2];
await ownDirect(dir, process.execPath, async (_input, signal, onStarted) => {
  writeFileSync(dir + "/phase", signal.aborted ? "aborted" : "started");
  if (signal.aborted) {
    return { exitCode: null, sessionId: "", detail: "medium exit=null stopped", failed: true, cleanup: { kind: "done", leftover: 0 } };
  }
  onStarted({ pid: process.pid, pgid: process.pid, start: startTime(process.pid) });
  return { exitCode: 0, sessionId: "", detail: "medium read", failed: false, cleanup: { kind: "done", leftover: 0 } };
});
`,
  );
  const runOwner = (dir: string) =>
    spawnSync(process.execPath, [path.join(root, "owner.mjs"), dir], { encoding: "utf8", timeout: 15_000 });

  const matching = claimed("match");
  requestStop(matching.dir, matching.identity.nonce);
  const matched = runOwner(matching.dir);
  assert.equal(matched.status, 1, matched.stderr);
  assert.equal(fs.readFileSync(path.join(matching.dir, "phase"), "utf8"), "aborted");
  assert.match(fs.readFileSync(path.join(matching.dir, "status"), "utf8"), /stopped/);

  const other = claimed("other");
  requestStop(other.dir, "other-run-nonce" as RunNonce);
  const ignored = runOwner(other.dir);
  assert.equal(ignored.status, 0, ignored.stderr);
  assert.equal(fs.readFileSync(path.join(other.dir, "phase"), "utf8"), "started");
  assert.match(fs.readFileSync(path.join(other.dir, "status"), "utf8"), /\[codex \| ok \|/);
  assert.doesNotMatch(fs.readFileSync(path.join(other.dir, "status"), "utf8"), /stopped/);
});

test("a waiting client's Ctrl-C leaves the owner running", async (t) => {
  const s = setup(t);
  const out = path.join(s.home, "ctrlc");
  stopOut(t, s.home, out, { PATH: s.PATH });
  const child = spawn(process.execPath, [CLI, ...runArgs(s, out, ["--wait"])], {
    env: cliEnv(s.home, { PATH: s.PATH, FAKE_SLOW: "8" }),
  });
  t.after(() => child.kill("SIGKILL"));
  for (let i = 0; i < 50; i++) {
    if (fs.existsSync(path.join(out, "run.json"))) {
      try {
        if (readDirect(out).startedAt) break;
      } catch {
        // not written yet
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const holder = ownerLock(out).holder();
  assert.ok(holder);
  child.kill("SIGINT");
  await new Promise((resolve) => child.on("close", resolve));
  assert.ok(ownerLock(out).holder(), "owner should still hold the lock");
  assert.equal(fs.existsSync(path.join(out, "status")), false);
});

test("proven owner death fails with a cause and keeps a partial answer; a control worker stays up", async (t) => {
  const s = setup(t);
  const out = path.join(s.home, "death");
  t.after(() => killRecorded(out));
  const control = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  t.after(() => {
    try {
      if (control.pid) process.kill(control.pid, "SIGKILL");
    } catch {
      // already gone
    }
  });
  control.unref();
  const child = spawn(process.execPath, [CLI, ...runArgs(s, out)], {
    env: cliEnv(s.home, { PATH: s.PATH, FAKE_SLOW: "8" }),
  });
  t.after(() => child.kill("SIGKILL"));
  await new Promise<void>((resolve) => {
    child.stdout.on("data", () => resolve());
  });
  fs.writeFileSync(path.join(out, "answer.md"), "partial answer\n");
  const holder = ownerLock(out).holder();
  assert.ok(holder);
  process.kill(holder.pid, "SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 500));
  const result = delegate(s.home, ["result", out]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /owner died/);
  assert.match(result.stdout, /partial answer/);
  try {
    process.kill(control.pid!, 0);
  } catch {
    assert.fail("control worker died");
  }
});

test("an occupied --out is refused, and leftover lock temps are not occupancy", (t) => {
  const s = setup(t);
  const occupied = path.join(s.home, "occupied");
  fs.mkdirSync(occupied);
  fs.writeFileSync(path.join(occupied, "prompt.md"), "old\n");
  const refused = delegate(s.home, runArgs(s, occupied, ["--wait"]), { PATH: s.PATH });
  assert.equal(refused.code, 2);
  assert.match(refused.stdout, /already holds a run/);
  assert.equal(fs.readFileSync(path.join(occupied, "prompt.md"), "utf8"), "old\n");
  const fresh = path.join(s.home, "fresh");
  fs.mkdirSync(fresh);
  fs.writeFileSync(path.join(fresh, ".tmp-99-owner.lock"), "stale\n");
  const ok = delegate(s.home, runArgs(s, fresh, ["--wait", "--model", "m1", "--effort", "low"]), { PATH: s.PATH });
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /^\[codex \| ok \|/);
});

test("denied final status publication fails status and result while retaining the answer", (t) => {
  const home = scratch(t);
  const dir = path.join(home, "run");
  fs.mkdirSync(dir);
  createDirect(dir, { provider: "codex", target: home, gitRoot: null, model: "mock", mode: "read", effort: "medium" });
  fs.writeFileSync(path.join(dir, "answer.md"), "partial answer\n");
  const preload = path.join(home, "deny-status.mjs");
  fs.writeFileSync(preload, `
import fs from "node:fs";
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  if (String(to).endsWith("/status")) {
    throw Object.assign(new Error("status publication denied"), { code: "EACCES" });
  }
  return rename(from, to);
};
`);
  for (const command of ["status", "result"]) {
    const r = delegate(home, [command, dir], { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` });
    const line = `[- | fail | - | cannot update run: status publication denied | session=- | out=${dir}]`;
    assert.equal(r.code, 1);
    assert.equal(r.stdout, command === "result" ? `${line}\n\npartial answer\n` : `${line}\n`);
    assert.doesNotMatch(r.stderr, /\n\s+at /);
    assert.equal(fs.existsSync(path.join(dir, "status")), false);
  }
});

test("direct metadata is provider-discriminated: Cursor cannot carry effort", (t) => {
  const dir = scratch(t);
  createDirect(dir, { provider: "cursor", target: dir, gitRoot: null, model: "m1", mode: "read", fullAccess: true });
  const meta = readDirect(dir);
  assert.equal(meta.provider, "cursor");
  if (meta.provider !== "cursor") throw new Error("narrow");
  assert.equal(meta.fullAccess, true);
  const body = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8")) as Record<string, unknown>;
  fs.writeFileSync(path.join(dir, "run.json"), `${JSON.stringify({ ...body, effort: "medium" })}\n`);
  assert.throws(() => readDirect(dir), { message: /bad effort/ });
  createDirect(dir, { provider: "codex", target: dir, gitRoot: null, model: "m1", mode: "read", effort: "low" });
  assert.equal(readDirect(dir).provider, "codex");
  const codex = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8")) as Record<string, unknown>;
  fs.writeFileSync(path.join(dir, "run.json"), `${JSON.stringify({ ...codex, fullAccess: true })}\n`);
  assert.throws(() => readDirect(dir), { message: /bad fullAccess/ });
});

test("directFinalLine renders leftover once and fails on cleanup uncertainty", (t) => {
  const dir = scratch(t);
  const meta = createDirect(dir, { provider: "cursor", target: dir, gitRoot: null, model: "auto", mode: "read" });
  const uncertain = directFinalLine(dir, meta, {
    exitCode: 0,
    sessionId: "c-1",
    detail: "read",
    failed: false,
    cleanup: { kind: "uncertain", detail: "scan failed" },
  });
  assert.equal(uncertain, `[cursor | fail | auto | read cleanup uncertain: scan failed | session=c-1 | out=${dir}]`);
  const leftover = directFinalLine(dir, meta, {
    exitCode: 0,
    sessionId: "c-1",
    detail: "read",
    failed: false,
    cleanup: { kind: "done", leftover: 2 },
  });
  assert.equal(leftover, `[cursor | ok | auto | read leftover=2 | session=c-1 | out=${dir}]`);
  const clean = directFinalLine(dir, meta, {
    exitCode: 0,
    sessionId: "c-1",
    detail: "read",
    failed: false,
    cleanup: { kind: "done", leftover: 0 },
  });
  assert.equal(clean, `[cursor | ok | auto | read | session=c-1 | out=${dir}]`);
});

test("ownDirect cleans up a recorded worker after a post-start throw", async (t) => {
  const dir = scratch(t);
  t.after(() => killRecorded(dir));
  const lock = ownerLock(dir);
  assert.equal(lock.lock(), true);
  createDirect(dir, { provider: "codex", target: dir, gitRoot: null, model: "mock", mode: "read", effort: "medium" });
  fs.writeFileSync(path.join(dir, "prompt.md"), "brief\n");
  const ownerScript = path.join(dir, "owner.mjs");
  fs.writeFileSync(
    ownerScript,
    `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { ownDirect } from ${JSON.stringify(path.join(import.meta.dirname, "direct.ts"))};
import { startTime } from ${JSON.stringify(path.join(import.meta.dirname, "procs.ts"))};
const dir = process.argv[2];
await ownDirect(dir, process.execPath, async (_input, _signal, onStarted) => {
  const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  if (!worker.pid) throw new Error("worker did not start");
  worker.unref();
  writeFileSync(dir + "/worker.pid", String(worker.pid));
  onStarted({ pid: worker.pid, pgid: worker.pid, start: startTime(worker.pid) });
  throw new Error("post-spawn parse failed");
});
`,
  );
  const owner = spawn(process.execPath, [ownerScript, dir], { stdio: ["ignore", "ignore", "pipe"] });
  const ownerExit = await new Promise<number | null>((resolve) => owner.on("close", resolve));
  const pid = Number(fs.readFileSync(path.join(dir, "worker.pid"), "utf8"));
  t.after(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  });
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch {
    alive = false;
  }
  const line = fs.readFileSync(path.join(dir, "status"), "utf8").trim();
  assert.equal(ownerExit, 1);
  assert.match(line, /\[codex \| fail \|/);
  if (alive) assert.match(line, /cleanup uncertain/);
  else assert.doesNotMatch(line, /cleanup uncertain: worker identity was not recorded/);
});

test("a zombie owner is reconciled as dead even when kill 0 would succeed", async (t) => {
  const dir = scratch(t);
  createDirect(dir, { provider: "codex", target: dir, gitRoot: null, model: "mock", mode: "read", effort: "medium" });
  const start = "Thu Jan  1 00:00:00 2026";
  fs.writeFileSync(path.join(dir, "owner.lock"), `${process.pid}\n${start}\nold\nutc\n`);
  const bin = fs.mkdtempSync(path.join(dir, "ps-"));
  fs.writeFileSync(
    path.join(bin, "ps"),
    `#!/bin/sh\nfor a; do last=$a; done\n[ "$last" = ${process.pid} ] && { echo "$last Z ${start}"; exit 0; }\nexec /bin/ps "$@"\n`,
    { mode: 0o755 },
  );
  const prev = process.env.PATH;
  process.env.PATH = `${bin}:${prev ?? "/usr/bin:/bin"}`;
  t.after(() => {
    process.env.PATH = prev;
  });
  await reconcileDirect(dir);
  assert.match(fs.readFileSync(path.join(dir, "status"), "utf8"), /owner died/);
});

test("owner death before a worker identity is recorded reports cleanup uncertainty", async (t) => {
  const dir = scratch(t);
  createDirect(dir, { provider: "codex", target: dir, gitRoot: null, model: "mock", mode: "read", effort: "medium" });
  const gone = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
  fs.writeFileSync(path.join(dir, "owner.lock"), `${gone}\nThu Jan  1 00:00:00 2026\nold\nutc\n`);
  await reconcileDirect(dir);
  const line = fs.readFileSync(path.join(dir, "status"), "utf8");
  assert.match(line, /owner died/);
  assert.match(line, /cleanup uncertain/);
  const completedAt = readDirect(dir).completedAt;
  assert.ok(completedAt !== undefined && completedAt > 0);
  t.mock.method(Date, "now", () => completedAt + 1_000);
  fs.rmSync(path.join(dir, "status"));
  await reconcileDirect(dir);
  assert.equal(readDirect(dir).completedAt, completedAt);
});

test("direct metadata accepts old runs and rejects invalid completion times", (t) => {
  const dir = scratch(t);
  createDirect(dir, { provider: "codex", target: dir, gitRoot: null, model: "mock", mode: "read", effort: "medium" });
  const old = readDirect(dir);
  assert.equal(old.completedAt, undefined);
  patchDirect(dir, { completedAt: 123 });
  assert.equal(readDirect(dir).completedAt, 123);
  for (const completedAt of [null, "123", 0, -1, {}, 1e999]) {
    fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({ ...old, completedAt }));
    assert.throws(() => readDirect(dir), /bad completedAt/);
  }
});

test("reaping a gone or reused recorded group leader reports cleanup uncertainty", async (t) => {
  const gone = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
  const lock = `${gone}\nThu Jan  1 00:00:00 2026\nold\nutc\n`;
  const goneDir = scratch(t);
  createDirect(goneDir, { provider: "codex", target: goneDir, gitRoot: null, model: "mock", mode: "read", effort: "medium" });
  patchDirect(goneDir, { workerPgid: Number(gone), workerStart: "Thu Jan  1 00:00:00 2026" });
  fs.writeFileSync(path.join(goneDir, "owner.lock"), lock);
  await reconcileDirect(goneDir);
  const goneLine = fs.readFileSync(path.join(goneDir, "status"), "utf8");
  assert.match(goneLine, /cleanup uncertain/);
  assert.match(goneLine, /recorded worker is gone/);

  const reused = scratch(t);
  createDirect(reused, { provider: "codex", target: reused, gitRoot: null, model: "mock", mode: "read", effort: "medium" });
  patchDirect(reused, { workerPgid: process.pid, workerStart: "Thu Jan  1 00:00:00 2026" });
  fs.writeFileSync(path.join(reused, "owner.lock"), lock);
  await reconcileDirect(reused);
  const reusedLine = fs.readFileSync(path.join(reused, "status"), "utf8");
  assert.match(reusedLine, /cleanup uncertain/);
  assert.doesNotMatch(reusedLine, /leftover=/);
  process.kill(process.pid, 0);
});

async function cursorForceStopOwner(t: { after: (fn: () => void) => void }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(import.meta.dirname, "..", ".tmp-direct-")));
  const pids: number[] = [];
  t.after(() => {
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    try {
      const recorded = Number(fs.readFileSync(path.join(dir, "supervisor.pid"), "utf8"));
      if (recorded > 0) process.kill(recorded, "SIGKILL");
    } catch {
      // missing or already gone
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.writeFileSync(
    path.join(dir, "owner.mjs"),
    `
import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { ownerLock } from ${JSON.stringify(path.join(import.meta.dirname, "run.ts"))};
import { startTime } from ${JSON.stringify(path.join(import.meta.dirname, "procs.ts"))};
const dir = process.argv[2];
if (!ownerLock(dir).lock()) process.exit(1);
const child = spawn(
  process.execPath,
  ["-e", "process.on('SIGTERM', () => {}); process.on('SIGHUP', () => {}); process.send('ready'); setInterval(() => {}, 1000)"],
  { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
);
if (!child.pid) process.exit(1);
child.on("message", (msg) => {
  if (msg !== "ready") return;
  const start = startTime(child.pid);
  if (!start) return;
  const tmp = dir + "/.tmp-" + process.pid + "-supervisor.identity";
  writeFileSync(tmp, child.pid + "\\n" + start + "\\n");
  renameSync(tmp, dir + "/supervisor.identity");
});
writeFileSync(dir + "/supervisor.pid", String(child.pid));
setInterval(() => {}, 1000);
`,
  );
  const owner = spawn(process.execPath, [path.join(dir, "owner.mjs"), dir], { stdio: ["ignore", "ignore", "pipe"] });
  if (owner.pid) pids.push(owner.pid);
  const identityFile = path.join(dir, "supervisor.identity");
  const identity = await new Promise<{ pid: number; start: string }>((resolve, reject) => {
    let done = false;
    const succeed = (value: { pid: number; start: string }) => {
      if (done) return;
      done = true;
      owner.off("close", onClose);
      resolve(value);
    };
    const fail = (err: Error) => {
      if (done) return;
      done = true;
      owner.off("close", onClose);
      reject(err);
    };
    const onClose = (code: number | null) => {
      fail(new Error(`owner exited before supervisor identity (code ${code})`));
    };
    owner.once("close", onClose);
    const until = Date.now() + 5_000;
    const tick = () => {
      if (done) return;
      try {
        const [pidText, start] = fs.readFileSync(identityFile, "utf8").split("\n");
        const pid = Number(pidText);
        if (Number.isInteger(pid) && pid > 0 && start) {
          succeed({ pid, start });
          return;
        }
      } catch {
        // identity not published yet
      }
      if (Date.now() > until) fail(new Error("owner did not record a supervisor"));
      else setTimeout(tick, 50);
    };
    tick();
  });
  return { dir, supervisorPid: identity.pid, supervisorStart: identity.start, pids };
}

test("forceDirectStop on a Cursor run SIGKILLs only the owner and TERMs the recorded supervisor", async (t) => {
  const { dir, supervisorPid, supervisorStart, pids } = await cursorForceStopOwner(t);
  const control = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  if (control.pid) pids.push(control.pid);
  control.unref();
  createDirect(dir, { provider: "cursor", target: dir, gitRoot: null, model: "auto", mode: "read" });
  patchDirect(dir, { workerPgid: supervisorPid, workerStart: supervisorStart, startedAt: Date.now() });
  const { forced } = await forceDirectStop(dir, "cursor");
  assert.equal(forced, true);
  const line = fs.readFileSync(path.join(dir, "status"), "utf8");
  assert.match(line, /\[cursor \| fail \|/);
  assert.match(line, /cleanup uncertain/);
  assert.equal((line.match(/cleanup uncertain/g) ?? []).length, 1);
  process.kill(supervisorPid, 0);
  process.kill(control.pid!, 0);
  assert.ok(startTime(supervisorPid));
});

test("forceDirectStop with a known Cursor provider does not SIGKILL the supervisor after run.json is unreadable", async (t) => {
  const { dir, supervisorPid } = await cursorForceStopOwner(t);
  createDirect(dir, { provider: "cursor", target: dir, gitRoot: null, model: "auto", mode: "read" });
  fs.writeFileSync(path.join(dir, "run.json"), "{corrupted\n");
  await forceDirectStop(dir, "cursor");
  process.kill(supervisorPid, 0);
});

test("ownDirect keeps an executor's uncertain cleanup when a later metadata write fails", async (t) => {
  const dir = scratch(t);
  t.after(() => killRecorded(dir));
  const lock = ownerLock(dir);
  assert.equal(lock.lock(), true);
  createDirect(dir, { provider: "cursor", target: dir, gitRoot: null, model: "mock", mode: "read" });
  fs.writeFileSync(path.join(dir, "prompt.md"), "brief\n");
  const ownerScript = path.join(dir, "owner.mjs");
  fs.writeFileSync(
    ownerScript,
    `
import fs from "node:fs";
import { spawn } from "node:child_process";
import { ownDirect } from ${JSON.stringify(path.join(import.meta.dirname, "direct.ts"))};
import { startTime } from ${JSON.stringify(path.join(import.meta.dirname, "procs.ts"))};
const dir = process.argv[2];
const rename = fs.renameSync;
let writes = 0;
fs.renameSync = (from, to) => {
  if (String(to).endsWith("/run.json") && ++writes === 3) {
    throw Object.assign(new Error("post-result metadata write denied"), { code: "EACCES" });
  }
  return rename(from, to);
};
await ownDirect(dir, process.execPath, async (_input, _signal, onStarted) => {
  const worker = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  if (!worker.pid) throw new Error("worker did not start");
  worker.unref();
  fs.writeFileSync(dir + "/worker.pid", String(worker.pid));
  onStarted({ pid: worker.pid, pgid: worker.pid, start: startTime(worker.pid) });
  return {
    exitCode: null,
    sessionId: "s1",
    detail: "read supervisor timed out",
    failed: true,
    cleanup: { kind: "uncertain", detail: "supervisor did not report cleanup" },
  };
});
`,
  );
  const owner = spawn(process.execPath, [ownerScript, dir], { stdio: ["ignore", "ignore", "pipe"] });
  const ownerExit = await new Promise<number | null>((resolve) => owner.on("close", resolve));
  const line = fs.readFileSync(path.join(dir, "status"), "utf8");
  assert.equal(ownerExit, 1);
  assert.match(line, /cleanup uncertain: supervisor did not report cleanup/);
  assert.doesNotMatch(line, /leftover=0/);
});

test("stop on an unreadable owner.lock keeps the live line and reports cleanup uncertainty", (t) => {
  const dir = scratch(t);
  createDirect(dir, { provider: "codex", target: dir, gitRoot: null, model: "mock", mode: "read", effort: "medium" });
  fs.writeFileSync(path.join(dir, "owner.lock"), "unreadable lock\n");
  const script = `
    import { main } from ${JSON.stringify(CLI)};
    const realNow = Date.now;
    let tick = realNow();
    Date.now = () => (tick += 70_000);
    const code = await main(["stop", ${JSON.stringify(dir)}]);
    Date.now = realNow;
    process.exitCode = code;
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 15_000 });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /\[codex \| starting \|/);
  assert.equal(fs.existsSync(path.join(dir, "status")), false);
  assert.match(r.stderr, /cleanup uncertain/);
  assert.doesNotMatch(r.stderr, /already ended/);
});

test("legacy runner directories still read through result", (t) => {
  const s = setup(t);
  const dir = path.join(s.home, "codex-legacy");
  fs.mkdirSync(dir);
  const line = `[codex | ok | m1 | low read in=1 out=2 | session=t-1 | out=${dir}]`;
  fs.writeFileSync(path.join(dir, "prompt.md"), "brief\n");
  fs.writeFileSync(path.join(dir, "status"), `${line}\n`);
  fs.writeFileSync(path.join(dir, "answer.md"), "hello from codex\n");
  assert.deepEqual(delegate(s.home, ["result", dir]), { code: 0, stdout: `${line}\n\nhello from codex\n`, stderr: "" });
});

test("--wait and --answer still print only the final line when startup acknowledgment times out", (t) => {
  const s = setup(t);
  const waitOut = path.join(s.home, "wait-timeout");
  const answerOut = path.join(s.home, "answer-timeout");
  stopOut(t, s.home, waitOut, { PATH: s.PATH });
  stopOut(t, s.home, answerOut, { PATH: s.PATH });
  const run = (out: string, extra: string[]) => {
    const script = `
      import { main } from ${JSON.stringify(CLI)};
      const realNow = Date.now;
      let tick = realNow();
      Date.now = () => (tick += 70_000);
      const code = await main(${JSON.stringify(runArgs(s, out, extra))});
      Date.now = realNow;
      process.exitCode = code;
    `;
    return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: cliEnv(s.home, { PATH: s.PATH }),
      timeout: 20_000,
    });
  };
  const waited = run(waitOut, ["--wait", "--model", "m1", "--effort", "low"]);
  const waitLine = `[codex | ok | m1 | low read in=1 out=2 | session=t-1 | out=${waitOut}]\n`;
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(waited.stdout, waitLine);
  const answered = run(answerOut, ["--answer", "--model", "m1", "--effort", "low"]);
  assert.equal(answered.status, 0, answered.stderr);
  assert.equal(answered.stdout, `${waitLine.replace(waitOut, answerOut)}\nhello from codex\n`);
});

test("run --cli codex --print-flags lists Codex flags including --tier", (t) => {
  const s = setup(t);
  const printed = delegate(s.home, ["run", "--cli", "codex", "--print-flags"]);
  assert.equal(printed.code, 0);
  assert.match(printed.stdout, /--tier value/);
  assert.match(printed.stdout, /--effort value/);
  assert.doesNotMatch(printed.stdout, /--deadline/);
  assert.doesNotMatch(printed.stdout, /--full-access/);
});
