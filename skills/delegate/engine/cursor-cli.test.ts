import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { readDirect } from "./direct.ts";
import { executing, sameProcess } from "./procs.ts";
import { ownerLock } from "./run.ts";
import { HOST_MARKERS } from "./workers.ts";

const CLI = path.join(import.meta.dirname, "cli.ts");

function cliEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    DELEGATE_OUT_ROOT: home,
    ...extra,
  };
  for (const name of HOST_MARKERS) {
    if (!Object.hasOwn(extra, name)) delete env[name];
  }
  return env;
}

function delegate(
  home: string,
  args: string[],
  extra: NodeJS.ProcessEnv = {},
  timeout = 30_000,
): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: cliEnv(home, extra),
    timeout,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function fakeCursor(home: string): string {
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, "cursor-agent"),
    `#!${process.execPath}
import fs from "node:fs";
const env = process.env;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
if (env.FAKE_PID) fs.writeFileSync(env.FAKE_PID, String(process.pid));
if (env.FAKE_IGNORE_TERM) process.on("SIGTERM", () => {});
if (env.FAKE_HOLD) {
  while (!fs.existsSync(env.FAKE_HOLD)) await sleep(50);
}
if (env.FAKE_SLOW) await sleep(Number(env.FAKE_SLOW) * 1000);
for await (const _ of process.stdin);
if (env.FAKE_STDERR) process.stderr.write(env.FAKE_STDERR);
process.stdout.write(env.FAKE_OUTPUT ?? '{"is_error":false,"session_id":"c-1","result":"hello from cursor"}\\n');
process.exitCode = Number(env.FAKE_EXIT ?? 0);
`,
    { mode: 0o755 },
  );
  return `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`;
}

function setup(t: { after: (fn: () => void) => void }) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(import.meta.dirname, "..", ".tmp-direct-")));
  const outs: string[] = [];
  const pids: number[] = [];
  t.after(() => {
    for (const out of outs) {
      try {
        if (fs.existsSync(path.join(out, "run.json"))) delegate(home, ["stop", out], { PATH: fakeCursor(home) }, 8_000);
      } catch {
        // best-effort stop before kill
      }
      killRecorded(out);
    }
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
  const target = path.join(home, "target");
  fs.mkdirSync(target);
  execFileSync("git", ["-C", target, "init", "-q"]);
  fs.writeFileSync(path.join(home, "brief.md"), "brief\n");
  const PATH = fakeCursor(home);
  return {
    home,
    target,
    PATH,
    brief: path.join(home, "brief.md"),
    trackOut: (out: string) => outs.push(out),
    trackPid: (pid: number) => pids.push(pid),
  };
}

function runArgs(s: { target: string; brief: string }, out: string, extra: string[] = []) {
  return ["run", "--cli", "cursor", "--cwd", s.target, "--prompt-file", s.brief, "--out", out, ...extra];
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

function firstLine(child: ChildProcess, ms: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for a status line")), ms);
    let buf = "";
    const done = (err: Error | null, line?: string) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(line ?? buf);
    };
    child.stdout?.on("data", (d) => {
      buf += d;
      if (buf.includes("\n")) done(null, buf);
    });
    child.on("error", (e) => done(e));
    child.on("close", (code) => {
      if (!buf.includes("\n")) done(new Error(`cli exited ${code} with ${JSON.stringify(buf)}`));
    });
  });
}

async function pidFile(file: string, ms: number): Promise<number> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fs.existsSync(file)) {
      const n = Number(fs.readFileSync(file, "utf8"));
      if (n > 1) return n;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${file}`);
}

test("default Cursor run returns a live line while the worker is still running", async (t) => {
  const s = setup(t);
  const out = path.join(s.home, "live");
  const agentPid = path.join(s.home, "agent.pid");
  const hold = path.join(s.home, "hold");
  s.trackOut(out);
  const child = spawn(process.execPath, [CLI, ...runArgs(s, out)], {
    env: cliEnv(s.home, { PATH: s.PATH, FAKE_HOLD: hold, FAKE_PID: agentPid }),
  });
  if (child.pid) s.trackPid(child.pid);
  const stdout = await firstLine(child, 15_000);
  assert.match(stdout, /^\[cursor \| running \| auto \| read \| session=- \| out=/);
  assert.equal(fs.existsSync(path.join(out, "status")), false);
  assert.equal(fs.existsSync(path.join(out, "spec.json")), false);
  const meta = readDirect(out);
  assert.equal(meta.provider, "cursor");
  assert.ok(meta.nonce);
  assert.ok(ownerLock(out).holder());
  assert.ok(meta.workerPgid);
  process.kill(meta.workerPgid, 0);
  const pid = await pidFile(agentPid, 5_000);
  s.trackPid(pid);
  process.kill(pid, 0);
  fs.writeFileSync(hold, "x");
});

test("Cursor --wait prints one final line and --answer adds a blank line and the body", (t) => {
  const s = setup(t);
  const waitOut = path.join(s.home, "wait");
  s.trackOut(waitOut);
  const waited = delegate(s.home, runArgs(s, waitOut, ["--wait", "--model", "m1"]), { PATH: s.PATH });
  const line = `[cursor | ok | m1 | read | session=c-1 | out=${waitOut}]\n`;
  assert.deepEqual(waited, { code: 0, stdout: line, stderr: "" });
  assert.equal(fs.readFileSync(path.join(waitOut, "status"), "utf8"), line);
  const answerOut = path.join(s.home, "answer");
  s.trackOut(answerOut);
  const answered = delegate(s.home, runArgs(s, answerOut, ["--answer", "--model", "m1"]), { PATH: s.PATH });
  assert.deepEqual(answered, { code: 0, stdout: `${line.replace(waitOut, answerOut)}\nhello from cursor\n`, stderr: "" });
  assert.deepEqual(delegate(s.home, ["result", answerOut]), answered);
  const status = delegate(s.home, ["status", answerOut]);
  assert.equal(status.stdout, `${line.replace(waitOut, answerOut)}`);
});

test("Cursor send and answer refuse a direct run, status and stop work", (t) => {
  const s = setup(t);
  const out = path.join(s.home, "cmd");
  s.trackOut(out);
  const started = delegate(s.home, runArgs(s, out, ["--wait", "--model", "m1"]), { PATH: s.PATH });
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

test("stop on a live Cursor run ends it", async (t) => {
  const s = setup(t);
  const out = path.join(s.home, "stop-live");
  const hold = path.join(s.home, "hold");
  s.trackOut(out);
  const child = spawn(process.execPath, [CLI, ...runArgs(s, out)], {
    env: cliEnv(s.home, { PATH: s.PATH, FAKE_HOLD: hold }),
  });
  if (child.pid) s.trackPid(child.pid);
  await firstLine(child, 15_000);
  const stopped = delegate(s.home, ["stop", out], { PATH: s.PATH }, 20_000);
  assert.equal(stopped.code, 1);
  assert.match(stopped.stdout, /\[cursor \| fail \|/);
  assert.match(stopped.stdout, /stopped/);
  fs.writeFileSync(hold, "x");
});

test("TERM-resistant Cursor worker makes stop report cleanup uncertainty and exit nonzero", async (t) => {
  const s = setup(t);
  const out = path.join(s.home, "resist");
  const agentPid = path.join(s.home, "resist.pid");
  const hold = path.join(s.home, "resist.hold");
  s.trackOut(out);
  const child = spawn(process.execPath, [CLI, ...runArgs(s, out)], {
    env: cliEnv(s.home, { PATH: s.PATH, FAKE_HOLD: hold, FAKE_IGNORE_TERM: "1", FAKE_PID: agentPid }),
  });
  if (child.pid) s.trackPid(child.pid);
  await firstLine(child, 15_000);
  const pid = await pidFile(agentPid, 5_000);
  s.trackPid(pid);
  const stopped = delegate(s.home, ["stop", out], { PATH: s.PATH }, 20_000);
  assert.equal(stopped.code, 1);
  assert.match(stopped.stdout, /\[cursor \| fail \|/);
  assert.match(stopped.stdout, /cleanup uncertain/);
  assert.equal((stopped.stdout.match(/cleanup uncertain/g) ?? []).length, 1);
  assert.equal(executing(pid), true);
});

test("owner SIGKILL on a Cursor run fails with cleanup uncertainty and leaves an independent survivor", async (t) => {
  const s = setup(t);
  const out = path.join(s.home, "death");
  const agentPid = path.join(s.home, "death.pid");
  const hold = path.join(s.home, "death.hold");
  s.trackOut(out);
  const control = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  if (control.pid) s.trackPid(control.pid);
  control.unref();
  const child = spawn(process.execPath, [CLI, ...runArgs(s, out)], {
    env: cliEnv(s.home, { PATH: s.PATH, FAKE_HOLD: hold, FAKE_PID: agentPid }),
  });
  if (child.pid) s.trackPid(child.pid);
  await firstLine(child, 15_000);
  s.trackPid(await pidFile(agentPid, 5_000));
  fs.writeFileSync(path.join(out, "answer.md"), "partial answer\n");
  const holder = ownerLock(out).holder();
  assert.ok(holder);
  process.kill(holder.pid, "SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 500));
  const result = delegate(s.home, ["result", out]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /owner died/);
  assert.match(result.stdout, /cleanup uncertain/);
  assert.match(result.stdout, /partial answer/);
  process.kill(control.pid!, 0);
});

test("an occupied Cursor --out is refused", (t) => {
  const s = setup(t);
  const occupied = path.join(s.home, "occupied");
  fs.mkdirSync(occupied);
  fs.writeFileSync(path.join(occupied, "prompt.md"), "old\n");
  const refused = delegate(s.home, runArgs(s, occupied, ["--wait"]), { PATH: s.PATH });
  assert.equal(refused.code, 2);
  assert.match(refused.stdout, /already holds a run/);
  assert.equal(fs.readFileSync(path.join(occupied, "prompt.md"), "utf8"), "old\n");
});

test("same-host Cursor refusal and unsupported flags leave no directory", (t) => {
  const s = setup(t);
  const host = delegate(s.home, runArgs(s, path.join(s.home, "host")), { PATH: s.PATH, CURSOR_AGENT: "1" });
  assert.equal(host.code, 2);
  assert.match(host.stdout, /this host is cursor/);
  assert.equal(fs.existsSync(path.join(s.home, "host")), false);
  const effort = delegate(s.home, runArgs(s, path.join(s.home, "effort"), ["--effort", "high"]), { PATH: s.PATH });
  assert.equal(effort.code, 2);
  assert.match(effort.stdout, /does not take --effort/);
  assert.equal(fs.existsSync(path.join(s.home, "effort")), false);
  const missing = delegate(s.home, runArgs(s, path.join(s.home, "missing"), ["--wait"]), { PATH: "/usr/bin:/bin" });
  assert.deepEqual(missing, {
    code: 1,
    stdout: "[cursor | fail | - | cursor-agent is not installed | session=- | out=-]\n",
    stderr: "",
  });
  assert.equal(fs.existsSync(path.join(s.home, "missing")), false);
});
