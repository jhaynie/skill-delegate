import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createRun, holdsRun, newNonce, openRun, ownerLock, readRun, RunFileError } from "./run.ts";
import type { MsgId, NewRunSpec, RunId } from "./state.ts";

test("ended states preserve completion times, accept old states, and reject invalid stored times", (t) => {
  const run = freshRun();
  t.after(() => fs.rmSync(run.dir, { recursive: true, force: true }));
  const old = { ...run.state(), phase: { kind: "ended" as const, outcome: "ok" as const, reason: "", leftover: 0, dirty: null } };
  run.commit(old);
  assert.deepEqual(run.state(), old);
  const completed = { ...old, phase: { ...old.phase, completedAt: 123 } };
  run.commit(completed);
  assert.deepEqual(run.state(), completed);
  run.commit(run.state());
  assert.deepEqual(run.state(), completed);
  for (const completedAt of [null, "123", 0, -1, {}, 1e999]) {
    fs.writeFileSync(run.file("state.json"), JSON.stringify({ ...old, phase: { ...old.phase, completedAt } }));
    assert.throws(() => run.state(), /bad phase.completedAt/);
  }
});

function freshRun() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-test-"));
  const spec: NewRunSpec = {
    id: dir as RunId,
    nonce: newNonce(),
    cli: "grok",
    target: "/repo",
    cwd: "/repo",
    gitRoot: "/repo",
    preset: "write",
    model: "grok-4.7",
    effort: "medium",
    deadlineAt: 0,
    sandbox: "workspace",
  };
  return createRun(spec, "brief");
}

test("claim returns commands oldest first by number, not by name, and each only once", () => {
  const run = freshRun();
  run.post({ id: "1000-2" as MsgId, kind: "send", text: "second", now: false });
  run.post({ id: "999-9" as MsgId, kind: "stop" });
  run.post({ id: "1000-1" as MsgId, kind: "send", text: "first now", now: true });
  run.post({ id: "1001-1" as MsgId, kind: "answer", approval: "r2", decision: "deny" });
  fs.writeFileSync(run.file("inbox/998-1.queue.json"), "{not json");
  fs.writeFileSync(run.file("inbox/997-1.stop.json"), JSON.stringify({ id: "997-1", kind: "stop", nonce: "another run" }));
  fs.writeFileSync(run.file("inbox/.tmp-5-1002-1.queue.json"), "{}");

  assert.deepEqual(run.claim(), [
    { id: "999-9", kind: "stop" },
    { id: "1000-1", kind: "send", text: "first now", now: true },
    { id: "1000-2", kind: "send", text: "second", now: false },
    { id: "1001-1", kind: "answer", approval: "r2", decision: "deny" },
  ]);
  assert.deepEqual(run.claim(), []);
  assert.deepEqual(fs.readdirSync(run.file("inbox/rejected")).sort(), ["997-1.stop.json", "998-1.queue.json"]);
  assert.deepEqual(fs.readdirSync(run.file("inbox/claimed")).sort(), [
    "1000-1.now.json",
    "1000-2.queue.json",
    "1001-1.answer.json",
    "999-9.stop.json",
  ]);
  assert.deepEqual(fs.readdirSync(run.file("inbox")).sort(), [".tmp-5-1002-1.queue.json", "claimed", "rejected"]);
});

test("the lock admits one owner, and only a dead holder can be taken over", () => {
  const run = freshRun();
  assert.equal(run.lock(), true);
  assert.equal(run.lock(), false);
  assert.equal(run.holder()?.pid, process.pid);
  assert.equal(run.takeover(), false);

  const gone = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  fs.writeFileSync(run.file("owner.lock"), `${gone.stdout}\nThu Jan  1 00:00:00 2026\nold\n`);
  assert.equal(run.takeover(), true);
  assert.equal(run.holder()?.pid, process.pid);
});

test("a reader in another time zone, or with no ps, never takes over a live owner's lock", () => {
  const run = freshRun();
  assert.equal(run.lock(), true);
  const reader = `const { openRun } = await import(${JSON.stringify(path.join(import.meta.dirname, "run.ts"))}); process.stdout.write(String(openRun(${JSON.stringify(run.dir)}).takeover()));`;
  for (const env of [{ TZ: "Pacific/Kiritimati" }, { LC_ALL: "fr_FR.UTF-8", LANG: "fr_FR.UTF-8" }, { PATH: "/nonexistent" }]) {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", reader], { encoding: "utf8", env: { ...process.env, ...env } });
    assert.equal(r.stdout, "false", JSON.stringify(env));
  }
  assert.equal(run.holder()?.pid, process.pid);
});

test("an owner that recorded its start in its own zone, as engines before C and UTC did, still holds its lock", () => {
  const run = freshRun();
  const local = spawnSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8", env: { ...process.env, TZ: "Pacific/Kiritimati" } }).stdout.trim();
  fs.writeFileSync(run.file("owner.lock"), `${process.pid}\n${local}\nold-engine\n`);
  const reader = `const { openRun } = await import(${JSON.stringify(path.join(import.meta.dirname, "run.ts"))}); process.stdout.write(String(openRun(${JSON.stringify(run.dir)}).takeover()));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", reader], { encoding: "utf8", env: { ...process.env, TZ: "Pacific/Kiritimati" } });
  assert.equal(r.stdout, "false");
  assert.equal(fs.readFileSync(run.file("owner.lock"), "utf8"), `${process.pid}\n${local}\nold-engine\n`);
});

test("a legacy lock timed in a third zone holds while its pid lives, and a current lock with another start does not", () => {
  const run = freshRun();
  const kolkata = spawnSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8", env: { ...process.env, TZ: "Asia/Kolkata" } }).stdout.trim();
  const reader = `const { openRun } = await import(${JSON.stringify(path.join(import.meta.dirname, "run.ts"))}); process.stdout.write(String(openRun(${JSON.stringify(run.dir)}).takeover()));`;
  const takeover = () => spawnSync(process.execPath, ["--input-type=module", "-e", reader], { encoding: "utf8", env: { ...process.env, TZ: "Pacific/Kiritimati" } }).stdout;
  fs.writeFileSync(run.file("owner.lock"), `${process.pid}\n${kolkata}\nold-engine\n`);
  assert.equal(takeover(), "false");
  // A current lock names its C and UTC format, so another start is a recycled pid
  fs.writeFileSync(run.file("owner.lock"), `${process.pid}\nThu Jan  1 00:00:00 2026\nnew-engine\nutc\n`);
  assert.equal(takeover(), "true");
});

// A ps that runs body, where $last is the pid asked about, before the real ps
function fakePs(body: string): string {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "engine-fake-ps-"));
  fs.writeFileSync(path.join(bin, "ps"), `#!/bin/sh\nfor a; do last=$a; done\n${body}\nexec /bin/ps "$@"\n`, { mode: 0o755 });
  return `${bin}:/usr/bin:/bin`;
}

// takeover on dir from another process, with env over this one's
function takeoverFrom(dir: string, env: NodeJS.ProcessEnv): string {
  const reader = `const { openRun } = await import(${JSON.stringify(path.join(import.meta.dirname, "run.ts"))}); process.stdout.write(String(openRun(${JSON.stringify(dir)}).takeover()));`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", reader], { encoding: "utf8", env: { ...process.env, ...env } }).stdout;
}

test("a live holder keeps its lock while ps cannot run, cannot read its pid, or prints no start time for it", () => {
  const run = freshRun();
  assert.equal(run.lock(), true);
  const lock = fs.readFileSync(run.file("owner.lock"), "utf8");
  const paths = {
    "no ps": "/nonexistent",
    "ps fails for the holder": fakePs(`[ "$last" = ${process.pid} ] && exit 1`),
    "ps prints garbage for the holder": fakePs(`[ "$last" = ${process.pid} ] && { echo 'garbage 12'; exit 0; }`),
    "ps prints a Z-prefixed word": fakePs(`[ "$last" = ${process.pid} ] && { echo "$last Zombies nonsense"; exit 0; }`),
    "ps prints Z without an lstart": fakePs(`[ "$last" = ${process.pid} ] && { echo "$last Z not-a-date"; exit 0; }`),
    "ps prints another start for the holder and fails": fakePs(`[ "$last" = ${process.pid} ] && { echo 'Thu Jan  1 00:00:00 2026'; exit 1; }`),
  };
  for (const [name, PATH] of Object.entries(paths)) assert.equal(takeoverFrom(run.dir, { PATH }), "false", name);
  assert.equal(fs.readFileSync(run.file("owner.lock"), "utf8"), lock);
});

test("a holder whose pid is gone is taken over, even when ps cannot read anything", () => {
  const run = freshRun();
  const gone = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
  fs.writeFileSync(run.file("owner.lock"), `${gone}\nThu Jan  1 00:00:00 2026\nold\nutc\n`);
  assert.equal(takeoverFrom(run.dir, { PATH: fakePs("exit 1") }), "true");
  assert.notEqual(fs.readFileSync(run.file("owner.lock"), "utf8").split("\n")[0], gone);
});

test("a kill(pid, 0) error other than ESRCH proves nothing, so the lock holds", () => {
  const run = freshRun();
  const gone = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
  const lock = `${gone}\nThu Jan  1 00:00:00 2026\nold\nutc\n`;
  fs.writeFileSync(run.file("owner.lock"), lock);
  const reader = `
    const kill = process.kill;
    process.kill = (pid, sig) => {
      if (sig === 0) throw Object.assign(new Error("kill EIO"), { code: "EIO", syscall: "kill" });
      return kill(pid, sig);
    };
    const { openRun } = await import(${JSON.stringify(path.join(import.meta.dirname, "run.ts"))});
    process.stdout.write(String(openRun(${JSON.stringify(run.dir)}).takeover()));`;
  assert.equal(spawnSync(process.execPath, ["--input-type=module", "-e", reader], { encoding: "utf8" }).stdout, "false");
  assert.equal(fs.readFileSync(run.file("owner.lock"), "utf8"), lock);
});

test("an owner.lock that cannot be read holds", () => {
  const run = freshRun();
  for (const body of ["", "garbage\n", `${process.pid}\n\nx\nutc\n`, "0\nThu Jan  1 00:00:00 2026\nx\nutc\n"]) {
    fs.writeFileSync(run.file("owner.lock"), body);
    assert.equal(run.takeover(), false, JSON.stringify(body));
    assert.equal(fs.readFileSync(run.file("owner.lock"), "utf8"), body);
  }
  fs.chmodSync(run.file("owner.lock"), 0o000);
  assert.equal(run.takeover(), false, "no read permission");
  fs.chmodSync(run.file("owner.lock"), 0o600);
});

test("a runner's lock, which records its start with single spaces, holds while ps pads the day, and another start ends it", () => {
  const run = freshRun();
  const PATH = fakePs(`[ "$last" = ${process.pid} ] && { echo "$last Ss Thu Jan  1 00:00:00 2026   "; exit 0; }`);
  fs.writeFileSync(run.file("owner.lock"), `${process.pid}\nThu Jan 1 00:00:00 2026\nrunner-x\nutc\n`);
  assert.equal(takeoverFrom(run.dir, { PATH }), "false");
  fs.writeFileSync(run.file("owner.lock"), `${process.pid}\nFri Jan 2 00:00:00 2026\nrunner-x\nutc\n`);
  assert.equal(takeoverFrom(run.dir, { PATH }), "true");
});

test("a holder whose ps state starts with Z is taken over even when kill 0 succeeds and lstart matches", () => {
  const run = freshRun();
  const start = "Thu Jan  1 00:00:00 2026";
  fs.writeFileSync(run.file("owner.lock"), `${process.pid}\n${start}\nold\nutc\n`);
  const PATH = fakePs(`[ "$last" = ${process.pid} ] && { echo "$last Z ${start}"; exit 0; }`);
  assert.equal(takeoverFrom(run.dir, { PATH }), "true");
  assert.notEqual(fs.readFileSync(run.file("owner.lock"), "utf8").split("\n")[0], String(process.pid));
});

test("a zombie pid with a matching start is still the recorded process for group signaling", () => {
  const start = "Thu Jan  1 00:00:00 2026";
  const PATH = fakePs(`[ "$last" = ${process.pid} ] && { echo "$last Z ${start}"; exit 0; }`);
  const reader = `const { sameProcess } = await import(${JSON.stringify(path.join(import.meta.dirname, "procs.ts"))}); process.stdout.write(String(sameProcess(${process.pid}, ${JSON.stringify(start)})));`;
  assert.equal(spawnSync(process.execPath, ["--input-type=module", "-e", reader], { encoding: "utf8", env: { ...process.env, PATH } }).stdout, "true");
});

// Processes that each call takeover on dir at the same instant; resolves to
// each racer's answer, "<reached the barrier before the instant> <won>".
// Each racer lives until all have answered: a racer that starts late would
// otherwise find a winner that already exited, and rightly take its lock too
async function raceTakeovers(dir: string, racers: number): Promise<string[]> {
  const at = Date.now() + 1_500;
  const script = `
    const { openRun } = await import(${JSON.stringify(path.join(import.meta.dirname, "run.ts"))});
    const run = openRun(${JSON.stringify(dir)});
    await new Promise((resolve) => setTimeout(resolve, ${at} - 20 - Date.now()));
    const inTime = Date.now() < ${at};
    while (Date.now() < ${at});
    process.stdout.write(inTime + " " + run.takeover() + "\\n");
    process.stdin.resume();`;
  const children = Array.from({ length: racers }, () =>
    spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "inherit"] }),
  );
  const closed = children.map((child) => new Promise((resolve) => child.on("close", resolve)));
  const answers = await Promise.all(
    children.map((child) => {
      let out = "";
      return new Promise<string>((resolve) => {
        child.stdout.on("data", (d) => {
          out += d;
          if (out.endsWith("\n")) resolve(out.trim());
        });
        child.on("close", () => resolve(out.trim()));
      });
    }),
  );
  for (const child of children) child.stdin.end();
  await Promise.all(closed);
  return answers;
}

test("two reapers racing to take over a dead holder's lock: exactly one wins", async (t) => {
  const run = freshRun();
  const gone = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  for (let round = 0; round < 10; round++) {
    // A round where a racer reached the barrier late raced nothing, so it runs again
    let answers: string[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      fs.writeFileSync(run.file("owner.lock"), `${gone.stdout}\nThu Jan  1 00:00:00 2026\nold\n`);
      answers = await raceTakeovers(run.dir, 6);
      for (const a of answers) assert.match(a, /^(true|false) (true|false)$/, `round ${round}: a racer did not answer`);
      if (answers.every((a) => a.startsWith("true "))) break;
      t.diagnostic(`round ${round} attempt ${attempt}: a racer missed the barrier`);
    }
    assert.ok(answers.every((a) => a.startsWith("true ")), `round ${round}: a racer missed the barrier 3 times`);
    assert.equal(answers.filter((a) => a.endsWith(" true")).length, 1, `round ${round}`);
    assert.deepEqual(fs.readdirSync(run.dir).filter((n) => n.startsWith("owner.lock")), ["owner.lock"]);
  }
});

test("a reaper that died between its claim and its rename does not block the next one", () => {
  const run = freshRun();
  const gone = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  fs.writeFileSync(run.file("owner.lock"), `${gone.stdout}\nThu Jan  1 00:00:00 2026\nold\n`);
  const crash = `
    import fs from "node:fs";
    const { openRun } = await import(${JSON.stringify(path.join(import.meta.dirname, "run.ts"))});
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => (String(to).endsWith("owner.lock") ? process.exit(9) : rename(from, to));
    openRun(${JSON.stringify(run.dir)}).takeover();`;
  assert.equal(spawnSync(process.execPath, ["--input-type=module", "-e", crash]).status, 9);
  assert.equal(run.takeover(), true);
  assert.equal(run.holder()?.pid, process.pid);
  assert.deepEqual(fs.readdirSync(run.dir).filter((n) => n.startsWith("owner.lock")), ["owner.lock"]);
});

test("a lock whose write fails publishes nothing, so no reader sees a lock without its owner", () => {
  const run = freshRun();
  // The exclusive create succeeds under a zero file-size limit, and every write fails
  const locker = `const { openRun } = await import(${JSON.stringify(path.join(import.meta.dirname, "run.ts"))}); openRun(${JSON.stringify(run.dir)}).lock();`;
  const r = spawnSync("sh", ["-c", 'ulimit -f 0; exec "$0" --input-type=module -e "$1"', process.execPath, locker], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.equal(fs.existsSync(run.file("owner.lock")), false);
  assert.equal(run.lock(), true);
});

test("an ended state reaches state.json before status, so a failed status write leaves the run ended", () => {
  const run = freshRun();
  // A non-empty directory where status goes makes its rename fail
  fs.mkdirSync(run.file("status/blocked"), { recursive: true });
  const ended = { ...run.state(), phase: { kind: "ended" as const, outcome: "ok" as const, reason: "", leftover: 0, dirty: 0 } };
  assert.throws(() => run.commit(ended));
  assert.deepEqual(run.state().phase, ended.phase);
});

test("unlock removes only the lock this handle wrote", () => {
  const run = freshRun();
  assert.equal(run.lock(), true);
  fs.writeFileSync(run.file("owner.lock"), `${process.pid}\nsomeone else\ntheirs\n`);
  run.unlock();
  assert.equal(fs.readFileSync(run.file("owner.lock"), "utf8"), `${process.pid}\nsomeone else\ntheirs\n`);
});

test("a state.json with a bad pid or phase is rejected by name, not trusted", () => {
  const run = freshRun();
  const good = run.state();
  assert.equal(good.phase.kind, "starting");
  fs.writeFileSync(run.file("state.json"), JSON.stringify({ ...good, workerPgid: 1 }));
  assert.throws(() => run.state(), { message: `${run.file("state.json")}: bad workerPgid` });
  fs.writeFileSync(run.file("state.json"), JSON.stringify({ ...good, phase: { kind: "waiting", turn: 1, tools: 0 } }));
  assert.throws(() => run.state(), RunFileError);
  fs.writeFileSync(run.file("state.json"), JSON.stringify({ ...good, phase: { kind: "ended", outcome: "ok", reason: "", leftover: 0, dirty: "?" } }));
  assert.deepEqual(run.state().phase, { kind: "ended", outcome: "ok", reason: "", leftover: 0, dirty: "?" });
});

test("a turn's error survives a state.json round trip", () => {
  const run = freshRun();
  const turns = [{ n: 1, end: "error" as const, tools: 0, text: false, error: "no deployment" }];
  run.commit({ ...run.state(), turns });
  assert.deepEqual(run.state().turns, turns);
});

test("a spec.json with an unknown cli is rejected by name", () => {
  const run = freshRun();
  const spec = JSON.parse(fs.readFileSync(run.file("spec.json"), "utf8"));
  fs.writeFileSync(run.file("spec.json"), JSON.stringify({ ...spec, cli: "cursor" }));
  assert.throws(() => openRun(run.dir), { message: `${run.file("spec.json")}: bad cli` });
});

test("readRun parses a run whose files both parse", () => {
  const run = freshRun();
  const read = readRun(run.dir);
  if (read.kind !== "ok") assert.fail(`expected ok, got ${read.kind}`);
  assert.equal(read.run.dir, run.dir);
  assert.deepEqual(read.state.phase, { kind: "starting" });
});

test("readRun calls a state.json that parses to the wrong shape an older format", () => {
  const run = freshRun();
  fs.writeFileSync(run.file("state.json"), JSON.stringify({ ...run.state(), phase: { kind: "waiting", turn: 1, tools: 0 } }));
  assert.deepEqual(readRun(run.dir), { kind: "older-format", dir: run.dir });
});

test("readRun calls a run with a non-JSON state.json or no spec.json unreadable", () => {
  const run = freshRun();
  fs.writeFileSync(run.file("state.json"), "{not json");
  assert.deepEqual(readRun(run.dir), { kind: "unreadable", dir: run.dir });
  const other = freshRun();
  fs.rmSync(other.file("spec.json"));
  assert.deepEqual(readRun(other.dir), { kind: "unreadable", dir: other.dir });
});

test("holdsRun ignores lock temps, including leftovers, and still sees any other file as a run", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-lock-temp-"));
  fs.writeFileSync(path.join(dir, ".tmp-123-owner.lock"), "lock temp\n");
  assert.equal(holdsRun(dir), false);
  fs.writeFileSync(path.join(dir, ".tmp-99-owner.lock"), "leftover\n");
  assert.equal(holdsRun(dir), false);
  fs.writeFileSync(path.join(dir, ".tmp-1-state.json"), "{}\n");
  assert.equal(holdsRun(dir), true);
});

function claimRace(dir: string, when: "first" | "second"): string {
  return `
    import fs from "node:fs";
    import { holdsRun, ownerLock } from ${JSON.stringify(path.join(import.meta.dirname, "run.ts"))};
    const dir = ${JSON.stringify(dir)};
    const role = process.argv[1];
    const when = ${JSON.stringify(when)};
    const marker = (name) => dir + "-" + name;
    const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    const until = (file) => {
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(file)) {
        if (Date.now() > deadline) throw new Error("timed out waiting for " + file);
        pause();
      }
    };
    const write = (file) => fs.writeFileSync(file, process.pid + "\\n");
    const nativeWrite = fs.writeFileSync;
    const nativeLink = fs.linkSync;
    fs.writeFileSync = (file, body, ...rest) => {
      nativeWrite(file, body, ...rest);
      if (role === "B" && String(file).includes(".tmp-") && String(file).endsWith("-owner.lock")) {
        write(marker("B-tmp"));
        if (when === "second") until(marker("A-done"));
        else until(marker("A-precheck"));
      }
    };
    fs.linkSync = (tmp, target) => {
      if (target !== dir + "/owner.lock") return nativeLink(tmp, target);
      if (role === "A" && when === "second") until(marker("B-tmp"));
      return nativeLink(tmp, target);
    };
    if (role === "A" && when === "first") until(marker("B-tmp"));
    const precheck = holdsRun(dir);
    if (role === "A") write(marker("A-precheck"));
    let winner = false;
    let taken = false;
    if (!precheck) {
      const lock = ownerLock(dir);
      taken = lock.takeover();
      if (taken) {
        const held = holdsRun(dir);
        if (held) lock.unlock();
        else winner = true;
      }
    }
    if (role === "A") write(marker("A-done"));
    process.stdout.write(JSON.stringify({ role, winner, taken, precheck }) + "\\n");
  `;
}

async function runClaimers(dir: string, script: string) {
  const run = (role: string) =>
    new Promise<{ role: string; winner: boolean; taken: boolean; precheck: boolean }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, role], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => {
        if (!stdout.trim()) return reject(new Error(`${role} exit ${code}: ${stderr}`));
        resolve(JSON.parse(stdout));
      });
    });
  const [a, b] = await Promise.all([run("A"), run("B")]);
  const winners = [a, b].filter((r) => r.winner);
  assert.equal(winners.length, 1, JSON.stringify({ a, b, entries: fs.readdirSync(dir) }));
  assert.equal(a.precheck, false, JSON.stringify(a));
  assert.equal(b.precheck, false, JSON.stringify(b));
  assert.equal(fs.existsSync(path.join(dir, "owner.lock")), true);
}

test("two fresh claims: the winner's second holdsRun ignores the loser's lock temp, so exactly one wins", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-claim-race-"));
  await runClaimers(dir, claimRace(dir, "second"));
});

test("two fresh claims: a loser's temp before the first holdsRun still yields exactly one winner", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-claim-first-"));
  await runClaimers(dir, claimRace(dir, "first"));
});

test("a leftover lock temp does not occupy, so a fresh claim still wins", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-claim-leftover-"));
  fs.writeFileSync(path.join(dir, ".tmp-99-owner.lock"), "stale\n");
  assert.equal(holdsRun(dir), false);
  assert.equal(ownerLock(dir).takeover(), true);
  assert.equal(holdsRun(dir), false);
});
