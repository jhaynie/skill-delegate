import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createRun, findRunBySession, newNonce, ownerLock } from "./run.ts";
import type { RunId, SessionId } from "./state.ts";

const CLI = path.join(import.meta.dirname, "cli.ts");

function delegate(root: string, args: string[], env: NodeJS.ProcessEnv = { ...process.env, DELEGATE_OUT_ROOT: root }, cwd?: string) {
  // A run that blocks, such as on a FIFO, fails its test instead of hanging the suite
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env, cwd, timeout: 30_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function delegateAsync(root: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, DELEGATE_OUT_ROOT: root } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// How many lines Python's splitlines reads, which splits on more than \n
function physicalLines(text: string): number {
  return Number(spawnSync("python3", ["-c", "import sys; print(len(sys.stdin.read().splitlines()))"], { input: text, encoding: "utf8" }).stdout);
}

// A directory outside every temp dir, because the engine refuses a read run there
function scratch(t: { after: (fn: () => void) => void }): string {
  const base = path.join(os.homedir(), ".cache");
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(base, "delegate-engine-test-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A starting grok run under root, named name, live until its heartbeat goes stale
function liveRun(root: string, name: string, target = "/repo") {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return createRun(
    {
      id: dir as RunId,
      nonce: newNonce(),
      cli: "grok",
      target,
      cwd: target,
      gitRoot: null,
      preset: "read",
      model: "grok-4.7",
      effort: "medium",
      deadlineAt: 0,
      sandbox: null,
    },
    "brief",
  );
}

// An ended grok run under root, named name, whose answer is "the answer"
function endedRun(root: string, name: string) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const run = createRun(
    {
      id: dir as RunId,
      nonce: newNonce(),
      cli: "grok",
      target: "/repo",
      cwd: "/repo",
      gitRoot: null,
      preset: "read",
      model: "grok-4.7",
      effort: "medium",
      deadlineAt: 0,
      sandbox: null,
    },
    "brief",
  );
  const s = run.state();
  run.commit({
    ...s,
    turns: [{ n: 1, end: "complete", tools: 0, text: true }],
    phase: { kind: "ended", outcome: "ok", reason: "", leftover: 0, dirty: null },
  });
  fs.writeFileSync(run.file("answer.md"), "the answer\n");
  return run;
}

test("status names up to five skipped runs per kind, counts more, and notes older formats only with --verbose", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-cli-"));
  endedRun(root, "fine");
  const older = endedRun(root, "older");
  fs.writeFileSync(older.file("state.json"), JSON.stringify({ ...older.state(), supervisorPid: "x" }));
  for (let i = 1; i <= 6; i++) fs.writeFileSync(endedRun(root, `broken-${i}`).file("state.json"), "{not json");

  const unreadable = "skipped 6 runs whose spec.json or state.json is missing or not JSON\n";
  assert.deepEqual(delegate(root, ["status"]), { code: 0, stdout: "", stderr: unreadable });
  assert.deepEqual(delegate(root, ["status", "--verbose"]), {
    code: 0,
    stdout: "",
    stderr: `skipped 1 run with an older state format: ${path.join(root, "older")}\n` + unreadable,
  });
});

test("result, send, and answer take their flags before or after the run, and a repeated --wait", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-cli-"));
  const { dir } = endedRun(root, "done");
  const line = `[grok | ok | grok-4.7 | medium read turns=1 stop=end_turn asks=0 waited=0 denied=0 leftover=0 | session=- | out=${dir}]\n`;
  const answered = { code: 0, stdout: `${line}\nthe answer\n`, stderr: "" };
  assert.deepEqual(delegate(root, ["result", dir, "--wait"]), answered);
  assert.deepEqual(delegate(root, ["result", "--wait", dir]), answered);
  assert.deepEqual(delegate(root, ["result", "--wait", dir, "--wait"]), answered);
  assert.deepEqual(delegate(root, ["result", "--timeout", "5", "--wait", "done"]), answered);
  assert.deepEqual(delegate(root, ["send", "--now", dir, "hi"]), {
    code: 1,
    stdout: line,
    stderr: "the run has ended; start a new run with --resume <session>\n",
  });
  assert.deepEqual(delegate(root, ["answer", "--widen", dir, "r1", "allow"]), {
    code: 1,
    stdout: line,
    stderr: "the run has ended, so r1 is not open\n",
  });
  assert.deepEqual(fs.readdirSync(path.join(dir, "inbox")).sort(), ["claimed", "rejected"]);
  assert.equal(delegate(root, ["result", dir, "extra"]).stderr.split("\n")[0], "unexpected argument extra");
});

test("a --cwd that contains the default run root is refused by name, and no run directory is left", (t) => {
  const home = scratch(t);
  fs.writeFileSync(path.join(home, "brief.md"), "brief\n");
  const env = { ...process.env, HOME: home };
  delete env.DELEGATE_OUT_ROOT;
  delete env.XDG_CACHE_HOME;
  const r = delegate("", ["run", "--cli", "grok", "--cwd", home, "--prompt-file", path.join(home, "brief.md")], env);
  const why =
    `--cwd puts the worker in ${home}, which contains ${path.join(home, ".cache", "delegate")}, where run directories go. ` +
    "Pass --cwd the repo or scratch directory the task is about, not a directory above it. Do not add --out to get around this.";
  assert.deepEqual(r, { code: 2, stdout: `[grok | fail | - | usage: ${why} | session=- | out=-]\n`, stderr: `${why}\n` });
  assert.deepEqual(fs.readdirSync(home), ["brief.md"]);
});

// The same directory spelled in upper case, where the filesystem folds case
function upperSpelling(dir: string): string | null {
  const upper = dir.toUpperCase();
  return upper !== dir && fs.existsSync(upper) && fs.statSync(upper).ino === fs.statSync(dir).ino ? upper : null;
}

test("path checks see through a --cwd or --out spelled in another case", (t) => {
  const home = scratch(t);
  const upperHome = upperSpelling(home);
  if (upperHome === null) return t.skip("this filesystem is case-sensitive");
  fs.writeFileSync(path.join(home, "brief.md"), "brief\n");
  const env = { ...process.env, HOME: home };
  delete env.DELEGATE_OUT_ROOT;
  delete env.XDG_CACHE_HOME;
  const r = delegate("", ["run", "--cli", "grok", "--cwd", upperHome, "--prompt-file", path.join(home, "brief.md")], env);
  const why =
    `--cwd puts the worker in ${home}, which contains ${path.join(home, ".cache", "delegate")}, where run directories go. ` +
    "Pass --cwd the repo or scratch directory the task is about, not a directory above it. Do not add --out to get around this.";
  assert.deepEqual(r, { code: 2, stdout: `[grok | fail | - | usage: ${why} | session=- | out=-]\n`, stderr: `${why}\n` });
  assert.deepEqual(fs.readdirSync(home), ["brief.md"]);

  fs.mkdirSync(path.join(home, "repo"));
  const out = path.join(upperHome, "REPO", "run");
  const inRepo = delegate(home, ["run", "--cli", "grok", "--cwd", path.join(home, "repo"), "--prompt-file", path.join(home, "brief.md"), "--out", out]);
  const inside = `--out must be outside ${path.join(home, "repo")}, because the worker can write there`;
  assert.deepEqual(inRepo, { code: 2, stdout: `[grok | fail | - | usage: ${inside} | session=- | out=-]\n`, stderr: `${inside}\n` });
  assert.deepEqual(fs.readdirSync(path.join(home, "repo")), []);
});

test("a refused --out is never created", (t) => {
  const home = scratch(t);
  fs.writeFileSync(path.join(home, "brief.md"), "brief\n");
  const out = path.join(home, "repo", "runs", "one");
  fs.mkdirSync(path.join(home, "repo"));
  const r = delegate(home, ["run", "--cli", "grok", "--cwd", path.join(home, "repo"), "--prompt-file", path.join(home, "brief.md"), "--out", out]);
  const why = `--out must be outside ${path.join(home, "repo")}, because the worker can write there`;
  assert.deepEqual(r, { code: 2, stdout: `[grok | fail | - | usage: ${why} | session=- | out=-]\n`, stderr: `${why}\n` });
  assert.deepEqual(fs.readdirSync(path.join(home, "repo")), []);
});

// A grok on an absolute PATH entry that exits at once, so a run it starts
// ends fail with worker exited, and the directory it was given shows what
// the run cleared and wrote
function exitingGrok(home: string): NodeJS.ProcessEnv {
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "grok"), "#!/bin/sh\n", { mode: 0o755 });
  return { ...process.env, PATH: `${bin}:/usr/bin:/bin`, DELEGATE_OUT_ROOT: path.join(home, "runs") };
}

// A pid that no process holds any more
function deadPid(): number {
  return Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
}

// This process's start time in epoch seconds, as a runner writes it to runner.pid
function ownStartEpoch(): number {
  const lstart = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).trim();
  return Date.parse(`${lstart} UTC`) / 1000;
}

function runInto(home: string, out: string, ...flags: string[]) {
  const target = path.join(home, "target");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(home, "brief.md"), "brief\n");
  return delegate(home, ["run", "--cli", "grok", "--cwd", target, "--prompt-file", path.join(home, "brief.md"), "--out", out, ...flags], exitingGrok(home));
}

const held = (out: string, why = "Pass a new --out.") => ({
  code: 2,
  stdout: `[grok | fail | - | usage: --out already holds a run: ${out}. ${why} | session=- | out=-]\n`,
  stderr: `--out already holds a run: ${out}. ${why}\n`,
});

// Every file under dir with its contents, so a refusal can be shown to change nothing
function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(
    (fs.readdirSync(dir, { recursive: true }) as string[]).sort().map((name) => {
      const full = path.join(dir, name);
      return [name, fs.statSync(full).isDirectory() ? "<dir>" : fs.readFileSync(full, "utf8")];
    }),
  );
}

test("run refuses an --out that holds an engine run, live or ended, and changes nothing", (t) => {
  const home = scratch(t);
  const live = liveRun(home, "live");
  const ended = endedRun(home, "ended");
  for (const run of [live, ended]) {
    assert.equal(run.lock(), true);
    const before = snapshot(run.dir);
    assert.deepEqual(runInto(home, run.dir, "--model", "second-model"), held(run.dir));
    assert.deepEqual(snapshot(run.dir), before);
    run.unlock();
  }
});

test("run refuses an --out that holds a runner run, started, live, ended, or dead, and changes nothing", (t) => {
  const home = scratch(t);
  const cases = { started: null, alive: `${process.pid} ${ownStartEpoch()}\n`, ended: `${deadPid()} 1\n`, died: `${deadPid()} 1\n` };
  for (const [name, pid] of Object.entries(cases)) {
    const out = path.join(home, `runner-${name}`);
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, "prompt.md"), "runner prompt\n");
    if (pid !== null) fs.writeFileSync(path.join(out, "runner.pid"), pid);
    if (name === "ended") fs.writeFileSync(path.join(out, "status"), `[codex | ok | m1 | low read | session=t-1 | out=${out}]\n`);
    const before = snapshot(out);
    assert.deepEqual(runInto(home, out), held(out), name);
    assert.deepEqual(snapshot(out), before, name);
  }
});

test("run refuses an --out that holds only a live or unreadable owner.lock, names its holder, and changes nothing", (t) => {
  const home = scratch(t);
  const live = path.join(home, "live-lock");
  fs.mkdirSync(live);
  assert.equal(ownerLock(live).lock(), true);
  const start = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
  const unreadable = path.join(home, "unreadable-lock");
  fs.mkdirSync(unreadable);
  fs.writeFileSync(path.join(unreadable, "owner.lock"), "");
  const cases = [
    [live, `owner.lock names pid ${process.pid}, started ${start.trim().split(/\s+/).join(" ")} UTC. Pass a new --out, or remove owner.lock once pid ${process.pid} is gone.`],
    [unreadable, "owner.lock cannot be read. Pass a new --out, or remove owner.lock once no run uses the directory."],
  ];
  for (const [out, why] of cases) {
    const before = snapshot(out);
    assert.deepEqual(runInto(home, out), held(out, why));
    assert.deepEqual(snapshot(out), before);
  }
});

test("run over an empty --out it cannot write prints a usage fail line, and writes nothing", (t) => {
  const home = scratch(t);
  const out = path.join(home, "readonly");
  fs.mkdirSync(out, { mode: 0o555 });
  assert.deepEqual(runInto(home, out), {
    code: 2,
    stdout: `[grok | fail | - | usage: cannot create --out ${out}: EACCES | session=- | out=-]\n`,
    stderr: `cannot create --out ${out}: EACCES\n`,
  });
  assert.deepEqual(fs.readdirSync(out), []);
});

test("run --resume refuses its own ended --out, and changes nothing", (t) => {
  const home = scratch(t);
  const run = endedRun(home, "ended");
  run.commit({ ...run.state(), sessionId: "s-old" as SessionId });
  const before = snapshot(run.dir);
  assert.deepEqual(runInto(home, run.dir, "--resume", "s-old", "--wait"), held(run.dir));
  assert.deepEqual(snapshot(run.dir), before);
});

test("run refuses an --out that holds anything but a lock, dotfiles and symlinks included, and changes nothing", (t) => {
  const home = scratch(t);
  const cases: Record<string, (out: string) => void> = {
    workspace: (out) => fs.mkdirSync(path.join(out, "workspace", ".git"), { recursive: true }),
    "runner-pid-temp": (out) => fs.writeFileSync(path.join(out, ".runner.pid-123"), "123 1\n"),
    "state-temp": (out) => fs.writeFileSync(path.join(out, ".tmp-1-state.json"), "{}"),
    "workspace-link": (out) => fs.symlinkSync(home, path.join(out, "workspace")),
    "dangling-answer": (out) => fs.symlinkSync(path.join(home, "nowhere"), path.join(out, "answer.md")),
    "fifo-lock": (out) => execFileSync("mkfifo", [path.join(out, "owner.lock")]),
    "dir-claim": (out) => fs.mkdirSync(path.join(out, `owner.lock.${"a".repeat(40)}.0`)),
  };
  for (const [name, plant] of Object.entries(cases)) {
    const out = path.join(home, name);
    fs.mkdirSync(out);
    plant(out);
    const before = fs.readdirSync(out);
    assert.deepEqual(runInto(home, out), held(out), name);
    assert.deepEqual(fs.readdirSync(out), before, name);
  }
});

test("run takes an --out that is empty, or holds only a dead run's owner.lock", (t) => {
  const home = scratch(t);
  const empty = path.join(home, "empty");
  fs.mkdirSync(empty);
  const crashed = path.join(home, "crashed");
  fs.mkdirSync(crashed);
  fs.writeFileSync(path.join(crashed, "owner.lock"), `${deadPid()}\nThu Jan  1 00:00:00 2026\nold\nutc\n`);
  for (const out of [empty, crashed]) {
    const line = `[grok | fail | grok-4.7 | medium read sandbox=read-only worker exited (0) turns=0 stop=- asks=0 waited=0 denied=0 leftover=0 | session=- | out=${out}]\n`;
    assert.deepEqual(runInto(home, out, "--wait"), { code: 1, stdout: line, stderr: "" }, out);
  }
});

test("a quoted ~/ in --cwd, --prompt-file, and --out means the home directory", (t) => {
  const home = scratch(t);
  fs.mkdirSync(path.join(home, "target"));
  fs.writeFileSync(path.join(home, "brief.md"), "brief\n");
  const env = { ...exitingGrok(home), HOME: home };
  const r = delegate(home, ["run", "--cli", "grok", "--cwd", "~/target", "--prompt-file", "~/brief.md", "--out", "~/runs/tilde", "--wait"], env);
  const out = path.join(home, "runs", "tilde");
  assert.deepEqual(r, {
    code: 1,
    stdout: `[grok | fail | grok-4.7 | medium read sandbox=read-only worker exited (0) turns=0 stop=- asks=0 waited=0 denied=0 leftover=0 | session=- | out=${out}]\n`,
    stderr: "",
  });
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, "spec.json"), "utf8")).target, path.join(home, "target"));
});

test("an --out that is a file, a dangling link, or under a file fails with a usage line, not a stack trace", (t) => {
  const home = scratch(t);
  const file = path.join(home, "a-file");
  fs.writeFileSync(file, "keep\n");
  const dangling = path.join(home, "dangling");
  fs.symlinkSync(path.join(home, "nowhere"), dangling);
  const refused = (why: string) => ({ code: 2, stdout: `[grok | fail | - | usage: ${why} | session=- | out=-]\n`, stderr: `${why}\n` });
  assert.deepEqual(runInto(home, file), refused(`cannot create --out ${file}: EEXIST`));
  assert.deepEqual(runInto(home, dangling), refused(`cannot create --out ${dangling}: ENOENT`));
  assert.deepEqual(runInto(home, path.join(file, "run")), refused(`cannot create --out ${path.join(file, "run")}: ENOTDIR`));
  assert.equal(fs.readFileSync(file, "utf8"), "keep\n");
  assert.equal(fs.existsSync(path.join(home, "nowhere")), false);
});

test("a CLI missing from PATH, or found only through an empty or relative entry, is not installed, and on an absolute entry it runs", (t) => {
  const home = scratch(t);
  const env = exitingGrok(home);
  const bin = path.join(home, "bin");
  const target = path.join(home, "target");
  const out = path.join(home, "run");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(home, "brief.md"), "brief\n");
  const args = ["run", "--cli", "grok", "--cwd", target, "--prompt-file", path.join(home, "brief.md"), "--out", out, "--wait"];
  // Called from bin, so . and an empty entry both hold this grok
  for (const PATH of ["", ".", `:${path.join(home, "empty")}`, "/usr/bin:/bin"]) {
    assert.deepEqual(delegate(home, args, { ...env, PATH }, bin), { code: 1, stdout: "[grok | fail | - | grok is not installed | session=- | out=-]\n", stderr: "" }, JSON.stringify(PATH));
    assert.equal(fs.existsSync(out), false);
  }
  assert.deepEqual(delegate(home, [...args, "--answer"], { ...env, PATH: "/usr/bin:/bin" }, bin), {
    code: 1,
    stdout: "[grok | fail | - | grok is not installed | session=- | out=-]\n\n",
    stderr: "",
  });
  assert.deepEqual(delegate(home, args, env, bin), {
    code: 1,
    stdout: `[grok | fail | grok-4.7 | medium read sandbox=read-only worker exited (0) turns=0 stop=- asks=0 waited=0 denied=0 leftover=0 | session=- | out=${out}]\n`,
    stderr: "",
  });
});

test("a usage fail line keeps no control or line separator, and a path cannot add a field", (t) => {
  const home = scratch(t);
  const cwd = `${home}/nope\x1b[2K\x1b[1G\u2028x\x85y\vz | session=S1 | out=/victim]`;
  const r = delegate(home, ["run", "--cli", "grok", "--cwd", cwd]);
  assert.equal(r.code, 2);
  assert.equal(r.stdout, `[grok | fail | - | usage: --cwd is not a directory: ${home}/nope x y z session=S1 out=/victim | session=- | out=-]\n`);
  assert.equal(physicalLines(r.stdout), 1);
});

test("every usage error prints a fail line on stdout, naming the cli when it is known", (t) => {
  const home = scratch(t);
  const line = (cli: string, why: string) => `[${cli} | fail | - | usage: ${why} | session=- | out=-]\n`;
  assert.deepEqual(delegate(home, ["run", "--cli", "opencode", "--bogus"]).stdout, line("opencode", "unexpected argument --bogus"));
  assert.deepEqual(delegate(home, ["run", "--cli", "nope"]).stdout, line("-", "--cli must be one of devin, grok, opencode, codex, cursor, not nope"));
  // The cli field names only a --cli the parse reached and accepted
  assert.deepEqual(delegate(home, ["run", "grok", "--cwd", home]).stdout, line("-", "unexpected argument grok"));
  assert.deepEqual(delegate(home, ["run", "--model", "--cli", "grok"]).stdout, line("-", "--model needs a value"));
  assert.deepEqual(delegate(home, ["run", "--cli", "grok", "--cwd", home, "--prompt-file", "--cli"]).stdout, line("grok", "--prompt-file needs a value"));
  assert.deepEqual(delegate(home, ["run", "--cli", "grok", "--model", "--wait"]), {
    code: 2,
    stdout: line("grok", "--model needs a value"),
    stderr: "--model needs a value\n",
  });
  const refused = (cli: string, why: string) => ({ code: 2, stdout: line(cli, why), stderr: `${why}\n` });
  assert.deepEqual(delegate(home, ["run", "--cli", "grok", "--out", ""]), refused("grok", "--out needs a value"));
  const quiet = delegate(home, ["run", "--cli", "grok", "--wait", "--quiet"]);
  assert.deepEqual({ code: quiet.code, stdout: quiet.stdout }, { code: 2, stdout: line("grok", "unexpected argument --quiet") });
  assert.deepEqual(delegate(home, ["run", "--cli", "grok", "--mode", "read", "--mode", "write"]), refused("grok", "--mode is given more than once"));
  assert.deepEqual(delegate(home, ["result", "--timeout", "5", "--wait", "--timeout", "9", "run"]), refused("-", "--timeout is given more than once"));
  const r = delegate(home, ["result", path.join(home, "none")]);
  assert.deepEqual(r, {
    code: 2,
    stdout: line("-", `not a run directory: ${path.join(home, "none")}`),
    stderr: `usage: not a run directory: ${path.join(home, "none")}\n`,
  });
});

test("--help prints the usage and the paths of the docs, and no command stays a usage error", (t) => {
  const home = scratch(t);
  const pkg = path.resolve(import.meta.dirname, "..");
  const readme = path.join(pkg, "README.md");
  const runners = path.join(pkg, "docs", "runners.md");
  const help = delegate(home, ["--help"]);
  const short = delegate(home, ["-h"]);
  assert.deepEqual(
    { code: help.code, stderr: help.stderr, first: help.stdout.split("\n")[0], last: help.stdout.split("\n").at(-2) },
    { code: 0, stderr: "", first: "usage:", last: `docs: ${readme} ${runners}` },
  );
  assert.equal(short.stdout, help.stdout);
  assert.deepEqual([fs.existsSync(readme), fs.existsSync(runners)], [true, true]);
  const text = help.stdout;
  const runAt = text.indexOf("delegate run");
  const statusAt = text.indexOf("delegate status");
  const answerAt = text.indexOf("delegate answer");
  const resultAt = text.indexOf("delegate result <run>\n");
  const waitAt = text.indexOf("delegate result <run> --wait");
  assert.ok(runAt >= 0 && statusAt > runAt && answerAt > statusAt && resultAt > answerAt && waitAt > resultAt);
  assert.match(text, /req=<id>/);
  assert.match(text, /may have no answer/);
  assert.match(text, /Waiting does not answer approval requests/);
  assert.match(text, /do not\s+take send or answer/);
  assert.match(text, /Direct Codex and Cursor/);
  assert.match(text, /--print-flags/);
  assert.match(text, /delegate prune --older-than/);
  assert.match(text, /Commands: run, status, send, answer, stop, result, prune/);
  assert.equal(delegate(home, []).code, 2);
});

test("command -h and --help print focused usage, exit 0, and start no run", (t) => {
  const home = scratch(t);
  const before = fs.readdirSync(home);
  for (const command of ["run", "status", "send", "answer", "stop", "result", "prune"]) {
    for (const flag of ["--help", "-h"]) {
      const help = delegate(home, [command, flag]);
      assert.equal(help.code, 0, `${command} ${flag}`);
      assert.equal(help.stderr, "", `${command} ${flag}`);
      assert.match(help.stdout, /^usage: delegate /, `${command} ${flag}`);
      assert.doesNotMatch(help.stdout, /^\[/, `${command} ${flag}`);
    }
  }
  assert.deepEqual(fs.readdirSync(home), before);
  const run = delegate(home, ["run", "--help"]);
  assert.match(run.stdout, /--deadline /);
  assert.match(run.stdout, /--full-access/);
  assert.doesNotMatch(run.stdout, /--tier /);
  const status = delegate(home, ["status", "--help"]);
  assert.match(status.stdout, /req=<id>/);
  const result = delegate(home, ["result", "--help"]);
  assert.match(result.stdout, /saved answer may be empty/);
  assert.match(result.stdout, /Waiting does not answer approval requests/);
  const answer = delegate(home, ["answer", "--help"]);
  assert.match(answer.stdout, /req= /);
  assert.match(answer.stdout, /Unsupported on Codex and Cursor/);
  const send = delegate(home, ["send", "--help"]);
  assert.match(send.stdout, /Unsupported on Codex and Cursor/);
  const prune = delegate(home, ["prune", "--help"]);
  assert.equal(prune.code, 0, prune.stderr);
  assert.match(prune.stdout, /--older-than/);
  assert.match(prune.stdout, /--dry-run/);
  assert.match(prune.stdout, /manual cleanup/);
  assert.match(prune.stdout, /README.md/);
});

test("run --cli selects provider help, and invalid help qualifiers still fail", (t) => {
  const home = scratch(t);
  const before = fs.readdirSync(home);
  const line = (cli: string, why: string) => `[${cli} | fail | - | usage: ${why} | session=- | out=-]\n`;
  const grok = delegate(home, ["run", "--cli", "grok", "--help"]);
  assert.equal(grok.code, 0);
  assert.equal(grok.stderr, "");
  assert.match(grok.stdout, /--cli grok/);
  assert.match(grok.stdout, /--deadline /);
  assert.doesNotMatch(grok.stdout, /--tier /);
  const opencode = delegate(home, ["run", "--cli", "opencode", "--help"]);
  assert.equal(opencode.code, 0);
  assert.match(opencode.stdout, /--cli opencode/);
  assert.doesNotMatch(opencode.stdout, /--full-access/);
  const cursor = delegate(home, ["run", "--help", "--cli", "cursor"]);
  const cursorH = delegate(home, ["run", "--cli", "cursor", "-h"]);
  assert.equal(cursor.stdout, cursorH.stdout);
  assert.match(cursor.stdout, /--cli cursor/);
  assert.match(cursor.stdout, /--full-access/);
  assert.doesNotMatch(cursor.stdout, /--tier /);
  assert.doesNotMatch(cursor.stdout, /--effort /);
  assert.doesNotMatch(cursor.stdout, /--deadline /);
  assert.match(cursor.stdout, /unsupported on Cursor/);
  const codex = delegate(home, ["run", "--cli", "codex", "--help"]);
  assert.equal(codex.code, 0);
  assert.match(codex.stdout, /--cli codex/);
  assert.match(codex.stdout, /--tier /);
  assert.match(codex.stdout, /--effort /);
  assert.doesNotMatch(codex.stdout, /--full-access/);
  assert.doesNotMatch(codex.stdout, /--deadline /);
  assert.match(codex.stdout, /unsupported on Codex/);
  assert.deepEqual(fs.readdirSync(home), before);
  assert.deepEqual(delegate(home, ["run", "--cli", "--help"]), {
    code: 2,
    stdout: line("-", "--cli needs a value"),
    stderr: "--cli needs a value\n",
  });
  assert.deepEqual(delegate(home, ["run", "--cli", "nope", "--help"]), {
    code: 2,
    stdout: line("-", "--cli must be one of devin, grok, opencode, codex, cursor, not nope"),
    stderr: "--cli must be one of devin, grok, opencode, codex, cursor, not nope\n",
  });
  const extra = delegate(home, ["run", "--cwd", home, "--help"]);
  assert.equal(extra.code, 2);
  assert.equal(extra.stdout, line("-", "unexpected argument --cwd"));
  assert.match(extra.stderr, /^unexpected argument --cwd\n/);
  assert.equal(delegate(home, ["nosuch", "--help"]).code, 2);
  assert.equal(delegate(home, ["--help", "run"]).code, 2);
  const printed = delegate(home, ["run", "--print-flags", "--help"]);
  assert.equal(printed.code, 0);
  assert.match(printed.stdout, /--cli value/);
  assert.doesNotMatch(printed.stdout, /^usage:/);
});

test("an exact --help or -h send text is a message, not help", (t) => {
  const home = scratch(t);
  const { dir } = endedRun(home, "done");
  const line = `[grok | ok | grok-4.7 | medium read turns=1 stop=end_turn asks=0 waited=0 denied=0 leftover=0 | session=- | out=${dir}]\n`;
  const ended = "the run has ended; start a new run with --resume <session>\n";
  for (const text of ["--help", "-h", "please use --help"]) {
    const sent = delegate(home, ["send", dir, text]);
    assert.deepEqual(sent, { code: 1, stdout: line, stderr: ended }, text);
  }
  const namedLikeFlag = endedRun(home, "--saved");
  for (const text of ["--help", "-h"]) {
    const sent = delegate(home, ["send", "--saved", text], undefined, home);
    assert.deepEqual(sent, {
      code: 1,
      stdout: line.replace(dir, namedLikeFlag.dir),
      stderr: ended,
    }, text);
  }
  const missing = path.join(home, "none");
  const absent = delegate(home, ["send", missing, "--help"]);
  assert.equal(absent.code, 2);
  assert.match(absent.stderr, /not a run directory: /);
  assert.doesNotMatch(absent.stdout, /^usage: delegate send/);
  const afterDash = delegate(home, ["send", dir, "--", "--help"]);
  assert.equal(afterDash.code, 2);
  assert.match(afterDash.stderr, /^unexpected argument --help\n/);
  assert.doesNotMatch(afterDash.stdout, /^usage: delegate send/);
});

test("--print-flags lists each flag run parses, with the arity run parses it with", (t) => {
  const home = scratch(t);
  const printed = delegate(home, ["--print-flags"]);
  assert.equal(printed.code, 0);
  const flags = printed.stdout.trimEnd().split("\n").map((line) => line.split(" ") as [string, string]);
  assert.deepEqual(
    flags.map(([name]) => name).sort(),
    ["--answer", "--cli", "--cwd", "--deadline", "--effort", "--full-access", "--mode", "--model", "--out", "--prompt-file", "--resume", "--wait"],
  );
  // A flag that parses as printed leaves --cli nope as the first error
  const parsed = "[- | fail | - | usage: --cli must be one of devin, grok, opencode, codex, cursor, not nope | session=- | out=-]\n";
  for (const [name, kind] of flags) {
    assert.ok(kind === "value" || kind === "boolean", `${name} ${kind}`);
    const args = name === "--cli" ? [] : kind === "value" ? [name, "v"] : [name];
    assert.equal(delegate(home, ["run", ...args, "--cli", "nope"]).stdout, parsed, name);
  }
  assert.equal(delegate(home, ["run", "--tier", "v", "--cli", "nope"]).stdout, "[- | fail | - | usage: unexpected argument --tier | session=- | out=-]\n");
});

test("status lists each live run with its target, and --cwd keeps the runs in that directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-cli-"));
  const mine = liveRun(root, "a-mine", "/work/app");
  const nested = liveRun(root, "b-nested", "/work/app/pkg");
  liveRun(root, "c-other", "/work/application");
  endedRun(root, "d-ended");
  const line = (dir: string, target: string) => `[grok | starting | grok-4.7 | medium read | session=- | out=${dir}] cwd=${target}\n`;
  assert.deepEqual(delegate(root, ["status"]), {
    code: 0,
    stdout: line(mine.dir, "/work/app") + line(nested.dir, "/work/app/pkg") + line(path.join(root, "c-other"), "/work/application"),
    stderr: "",
  });
  assert.deepEqual(delegate(root, ["status", "--cwd", "/work/app"]), {
    code: 0,
    stdout: line(mine.dir, "/work/app") + line(nested.dir, "/work/app/pkg"),
    stderr: "",
  });
  assert.deepEqual(delegate(root, ["status", mine.dir]), {
    code: 0,
    stdout: `[grok | starting | grok-4.7 | medium read | session=- | out=${mine.dir}]\n`,
    stderr: "",
  });
  assert.equal(delegate(root, ["status", mine.dir, "--cwd", "/work"]).code, 2);
});

test("answer and send that no owner reads exit 1 after their wait and say so", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-cli-"));
  const run = liveRun(root, "unowned");
  const unread = {
    code: 1,
    stdout: `[grok | starting | grok-4.7 | medium read | session=- | out=${run.dir}]\n`,
    stderr: "not acknowledged yet; check status\n",
  };
  // Concurrent, so the file waits out one ack window, not two
  const [answered, sent] = await Promise.all([
    delegateAsync(root, ["answer", run.dir, "r1", "deny"]),
    delegateAsync(root, ["send", run.dir, "hello"]),
  ]);
  assert.deepEqual(answered, unread);
  assert.deepEqual(sent, unread);
});

test("stop on a run that ended before its owner read the stop prints the ended line and says it was not applied", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-cli-"));
  const ended = endedRun(root, "ended");
  const line = (dir: string) => `[grok | ok | grok-4.7 | medium read turns=1 stop=end_turn asks=0 waited=0 denied=0 leftover=0 | session=- | out=${dir}]\n`;
  const notApplied = "stop not applied: the run had already ended\n";
  assert.deepEqual(delegate(root, ["stop", ended.dir]), { code: 0, stdout: line(ended.dir), stderr: notApplied });
  const run = liveRun(root, "late");
  const stopping = delegateAsync(root, ["stop", run.dir]);
  while (!fs.readdirSync(run.file("inbox")).some((name) => name.endsWith(".stop.json"))) await new Promise((r) => setTimeout(r, 50));
  // The owner's last drain is over, so the stop stays in the inbox unread
  run.commit({ ...run.state(), turns: [{ n: 1, end: "complete", tools: 0, text: true }], phase: { kind: "ended", outcome: "ok", reason: "", leftover: 0, dirty: null } });
  assert.deepEqual(await stopping, { code: 0, stdout: line(run.dir), stderr: notApplied });
});

test("stop that forces a run its owner ended at that moment says the stop was not applied, whatever the reason", async (t) => {
  const root = scratch(t);
  // An owner that ends the run on its own as stop signals it, with the stop unread
  const owner = path.join(root, "owner.ts");
  fs.writeFileSync(
    owner,
    `import { openRun } from ${JSON.stringify(path.join(import.meta.dirname, "run.ts"))};
const run = openRun(process.argv[2]);
if (!run.lock()) process.exit(1);
process.on("SIGTERM", () => {
  const [outcome, reason] = process.argv[3] ? ["partial", process.argv[3]] : ["ok", ""];
  run.commit({ ...run.state(), turns: [{ n: 1, end: "complete", tools: 0, text: true }], phase: { kind: "ended", outcome, reason, leftover: 0, dirty: null } });
  process.exit(0);
});
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);
`,
  );
  const stop = async (name: string, reason: string) => {
    const run = liveRun(root, name);
    // Stale enough that stop soon forces, fresh enough that no reader reaps it first
    run.commit({ ...run.state(), heartbeatAt: Date.now() - 29_000 });
    const child = spawn(process.execPath, [owner, run.dir, reason], { detached: true, stdio: ["ignore", "pipe", "inherit"] });
    t.after(() => child.kill("SIGKILL"));
    await new Promise((resolve) => child.stdout.once("data", resolve));
    return { dir: run.dir, stopped: await delegateAsync(root, ["stop", run.dir]) };
  };
  const [ok, named] = await Promise.all([stop("ok", ""), stop("named", "stop forced")]);
  const notApplied = "stop not applied: the run had already ended\n";
  assert.deepEqual(ok.stopped, {
    code: 0,
    stdout: `[grok | ok | grok-4.7 | medium read turns=1 stop=end_turn asks=0 waited=0 denied=0 leftover=0 | session=- | out=${ok.dir}]\n`,
    stderr: notApplied,
  });
  assert.deepEqual(named.stopped, {
    code: 0,
    stdout: `[grok | partial | grok-4.7 | medium read stop forced turns=1 stop=end_turn asks=0 waited=0 denied=0 leftover=0 | session=- | out=${named.dir}]\n`,
    stderr: notApplied,
  });
});

test("a managed run from before command nonces reads as it did, and refuses commands", async (t) => {
  const root = scratch(t);
  const dir = path.join(root, "main-run");
  fs.mkdirSync(path.join(dir, "inbox"), { recursive: true });
  fs.mkdirSync(path.join(dir, "turns"));
  // spec.json and state.json as the engine wrote them before the nonce
  const spec = { id: dir, cli: "grok", target: "/repo", cwd: "/repo", gitRoot: null, preset: "read", model: "grok-4.7", effort: "medium", maxTurns: null, deadlineAt: 0, sandbox: "read-only" };
  fs.writeFileSync(path.join(dir, "spec.json"), `${JSON.stringify(spec, null, 2)}\n`);
  const phase = { kind: "ended", outcome: "ok", reason: "", leftover: 0, dirty: null };
  const state = { supervisorPid: 86712, sessionId: "s-main", heartbeatAt: 0, phase, queued: [], acks: {}, rejections: {}, turns: [{ n: 1, end: "complete", tools: 0, text: true }], asks: 0, waited: 0, denied: 0, widened: 0 };
  fs.writeFileSync(path.join(dir, "state.json"), `${JSON.stringify(state)}\n`);
  fs.writeFileSync(path.join(dir, "prompt.md"), "brief");
  fs.writeFileSync(path.join(dir, "answer.md"), "Saved result from main.\n");
  const line = `[grok | ok | grok-4.7 | medium read sandbox=read-only turns=1 stop=end_turn asks=0 waited=0 denied=0 leftover=0 | session=s-main | out=${dir}]\n`;
  assert.deepEqual(delegate(root, ["result", dir]), { code: 0, stdout: `${line}\nSaved result from main.\n`, stderr: "" });
  assert.deepEqual(delegate(root, ["status", dir]), { code: 0, stdout: line, stderr: "" });
  assert.deepEqual(delegate(root, ["status", "--verbose"]), { code: 0, stdout: "", stderr: "" });
  const outRoot = process.env.DELEGATE_OUT_ROOT;
  process.env.DELEGATE_OUT_ROOT = root;
  t.after(() => (outRoot === undefined ? delete process.env.DELEGATE_OUT_ROOT : (process.env.DELEGATE_OUT_ROOT = outRoot)));
  assert.equal(findRunBySession("s-main")?.dir, dir);
  const refused = { code: 1, stdout: line, stderr: "this run predates command nonces, so it takes no answer, send, or stop\n" };
  assert.deepEqual(delegate(root, ["answer", dir, "r1", "allow"]), refused);
  assert.deepEqual(delegate(root, ["send", dir, "hello"]), refused);
  assert.deepEqual(delegate(root, ["stop", dir]), refused);
  assert.deepEqual(fs.readdirSync(path.join(dir, "inbox")), []);
});

test("an ended engine run keeps its status line in status, and result --quiet prints only that line", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-cli-"));
  const { dir } = endedRun(root, "done");
  const line = `[grok | ok | grok-4.7 | medium read turns=1 stop=end_turn asks=0 waited=0 denied=0 leftover=0 | session=- | out=${dir}]\n`;
  assert.equal(fs.readFileSync(path.join(dir, "status"), "utf8"), line);
  assert.deepEqual(delegate(root, ["result", dir, "--quiet"]), { code: 0, stdout: line, stderr: "" });
});

test("a reader restores the status an owner died before writing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-cli-"));
  const { dir } = endedRun(root, "no-status");
  const line = `[grok | ok | grok-4.7 | medium read turns=1 stop=end_turn asks=0 waited=0 denied=0 leftover=0 | session=- | out=${dir}]\n`;
  fs.rmSync(path.join(dir, "status"));
  assert.deepEqual(delegate(root, ["result", dir, "--quiet"]), { code: 0, stdout: line, stderr: "" });
  assert.equal(fs.readFileSync(path.join(dir, "status"), "utf8"), line);
  assert.equal(fs.existsSync(path.join(dir, "owner.lock")), false);
});

test("result reads a runner's run directory from its status file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-cli-"));
  const ok = path.join(root, "codex-ok");
  fs.mkdirSync(ok);
  const okLine = `[codex | ok | m1 | low read in=1 out=2 | session=t-1 | out=${ok}]`;
  fs.writeFileSync(path.join(ok, "status"), `${okLine}\n`);
  fs.writeFileSync(path.join(ok, "answer.md"), "hello from codex\n");
  assert.deepEqual(delegate(root, ["result", ok]), { code: 0, stdout: `${okLine}\n\nhello from codex\n`, stderr: "" });
  assert.deepEqual(delegate(root, ["result", ok, "--quiet"]), { code: 0, stdout: `${okLine}\n`, stderr: "" });

  const failed = path.join(root, "cursor-fail");
  fs.mkdirSync(failed);
  const failLine = `[cursor | fail | m1 | read leftover=0 exit=1 is_error=unknown | session=- | out=${failed}]`;
  fs.writeFileSync(path.join(failed, "status"), `${failLine}\n`);
  fs.writeFileSync(path.join(failed, "answer.md"), "");
  fs.writeFileSync(path.join(failed, "stderr.log"), "not signed in\n");
  assert.deepEqual(delegate(root, ["result", failed]), { code: 1, stdout: `${failLine}\n\nnot signed in\n`, stderr: "" });
  // A fail with no answer and no stderr still prints the blank line before its empty answer
  fs.rmSync(path.join(failed, "stderr.log"));
  assert.deepEqual(delegate(root, ["result", failed]), { code: 1, stdout: `${failLine}\n\n`, stderr: "" });
});

test("result on a runner run with no status yet prints running, and --wait waits for its final line", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-cli-"));
  const dir = path.join(root, "codex-live");
  fs.mkdirSync(dir);
  // A runner writes runner.pid, here this live process, before prompt.md
  fs.writeFileSync(path.join(dir, "runner.pid"), `${process.pid} ${ownStartEpoch()}\n`);
  fs.writeFileSync(path.join(dir, "prompt.md"), "brief\n");
  const running = { code: 0, stdout: `[- | running | - | no final line yet | session=- | out=${dir}]\n`, stderr: "" };
  assert.deepEqual(delegate(root, ["result", dir]), running);
  assert.deepEqual(delegate(root, ["result", "codex-live", "--wait", "--timeout", "1"]), running);

  const waited = delegateAsync(root, ["result", dir, "--wait", "--timeout", "30"]);
  const line = `[codex | ok | m1 | low read in=1 out=2 | session=t-1 | out=${dir}]`;
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  fs.writeFileSync(path.join(dir, "answer.md"), "hello from codex\n");
  // The runner renames its status into place, so a reader never sees half a line
  fs.writeFileSync(path.join(dir, ".status"), `${line}\n`);
  fs.renameSync(path.join(dir, ".status"), path.join(dir, "status"));
  assert.deepEqual(await waited, { code: 0, stdout: `${line}\n\nhello from codex\n`, stderr: "" });
});

test("result reports a runner that died before its final line, and --wait stops there", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-cli-"));
  const died = path.join(root, "codex-crashed");
  fs.mkdirSync(died);
  fs.writeFileSync(path.join(died, "prompt.md"), "brief\n");
  fs.writeFileSync(path.join(died, "stderr.log"), "codex: killed\n");
  fs.writeFileSync(path.join(died, "runner.pid"), `${deadPid()} 1\n`);
  const line = `[codex | fail | - | runner died | session=- | out=${died}]\n`;
  assert.deepEqual(delegate(root, ["result", died]), { code: 1, stdout: `${line}\ncodex: killed\n`, stderr: "" });
  assert.deepEqual(await delegateAsync(root, ["result", died, "--wait", "--timeout", "20", "--quiet"]), { code: 1, stdout: line, stderr: "" });

  const live = path.join(root, "custom-live");
  fs.mkdirSync(live);
  fs.writeFileSync(path.join(live, "prompt.md"), "brief\n");
  fs.writeFileSync(path.join(live, "runner.pid"), `${process.pid} ${ownStartEpoch()}\n`);
  assert.deepEqual(await delegateAsync(root, ["result", live, "--wait", "--timeout", "1"]), {
    code: 0,
    stdout: `[- | running | - | no final line yet | session=- | out=${live}]\n`,
    stderr: "",
  });
  fs.writeFileSync(path.join(live, "runner.pid"), `${deadPid()} 1\n`);
  assert.deepEqual(delegate(root, ["result", live, "--quiet"]), { code: 1, stdout: `[- | fail | - | runner died | session=- | out=${live}]\n`, stderr: "" });
});

// A ps that reads only its caller's own start time, as for a pid recycled by
// a process ps cannot describe
function blindPs(home: string): string {
  const bin = path.join(home, "blind-ps");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "ps"), '#!/bin/sh\nfor a; do last=$a; done\n[ "$last" = "$PPID" ] && exec /bin/ps "$@"\nexit 1\n', { mode: 0o755 });
  return bin;
}

test("a runner.pid whose live pid ps cannot read stays running, whether ps fails for it or cannot run", (t) => {
  const home = scratch(t);
  const dir = path.join(home, "codex-unreadable");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "prompt.md"), "brief\n");
  fs.writeFileSync(path.join(dir, "runner.pid"), `${process.pid} 1\n`);
  const env = (PATH: string) => ({ ...process.env, PATH, DELEGATE_OUT_ROOT: home });
  for (const PATH of [`${blindPs(home)}:/usr/bin:/bin`, path.join(home, "no-ps")]) {
    assert.deepEqual(delegate(home, ["result", dir, "--quiet"], env(PATH)), {
      code: 0,
      stdout: `[- | running | - | no final line yet | session=- | out=${dir}]\n`,
      stderr: "",
    });
  }
});

test("a runner.pid whose start is not a positive whole epoch is an unknown start, so its live pid stays running", (t) => {
  const home = scratch(t);
  for (const start of ["Infinity", "-5", "0", "1.5", "1e400"]) {
    const dir = path.join(home, `codex-start-${start}`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "prompt.md"), "brief\n");
    fs.writeFileSync(path.join(dir, "runner.pid"), `${process.pid} ${start}\n`);
    assert.deepEqual(delegate(home, ["result", dir, "--quiet"]), {
      code: 0,
      stdout: `[- | running | - | no final line yet | session=- | out=${dir}]\n`,
      stderr: "",
    }, start);
  }
});

test("a dead pid above ps's range reads as not running, a live one ps cannot read as running, and no ps error reaches result's output", (t) => {
  const home = scratch(t);
  const bin = path.join(home, "noisy-ps");
  fs.mkdirSync(bin);
  // ps as macOS answers a pid above 99999, for any pid but its caller's
  fs.writeFileSync(path.join(bin, "ps"), '#!/bin/sh\nfor a; do last=$a; done\n[ "$last" = "$PPID" ] && exec /bin/ps "$@"\necho "ps: process id too large: $last" >&2\nexit 1\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, DELEGATE_OUT_ROOT: home };
  const died = (dir: string) => ({ code: 1, stdout: `[codex | fail | - | runner died | session=- | out=${dir}]\n`, stderr: "" });
  const running = (dir: string) => ({ code: 0, stdout: `[- | running | - | no final line yet | session=- | out=${dir}]\n`, stderr: "" });
  for (const [pid, want] of [[999999, died], [process.pid, running]] as const) {
    const dir = path.join(home, `codex-${pid}`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "prompt.md"), "brief\n");
    fs.writeFileSync(path.join(dir, "runner.pid"), `${pid} 1\n`);
    assert.deepEqual(delegate(home, ["result", dir, "--quiet"], env), want(dir), String(pid));
  }
});

test("result on a runner directory from before runner.pid prints a fail line and its answer at once", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-cli-"));
  // The files a runner wrote before it wrote runner.pid and status
  const dir = path.join(root, "codex-20260101-000000-old");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "prompt.md"), "brief\n");
  fs.writeFileSync(path.join(dir, "stdout.raw"), "");
  fs.writeFileSync(path.join(dir, "stderr.log"), "");
  fs.writeFileSync(path.join(dir, "answer.md"), "old answer\n");
  fs.writeFileSync(path.join(dir, "session_id"), "t-1\n");
  const line = `[codex | fail | - | older runner wrote no final line | session=- | out=${dir}]\n`;
  const read = { code: 1, stdout: `${line}\nold answer\n`, stderr: "" };
  assert.deepEqual(delegate(root, ["result", dir]), read);
  const started = Date.now();
  assert.deepEqual(delegate(root, ["result", dir, "--wait", "--timeout", "20"]), read);
  assert.ok(Date.now() - started < 10_000, "--wait returns at once");
});

test("result on a runner directory whose runner.pid cannot be read prints running, not ended", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-cli-"));
  const dir = path.join(root, "codex-unreadable");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "runner.pid"), `${process.pid} ${ownStartEpoch()}\n`, { mode: 0o000 });
  t.after(() => fs.chmodSync(path.join(dir, "runner.pid"), 0o600));
  fs.writeFileSync(path.join(dir, "prompt.md"), "brief\n");
  assert.deepEqual(delegate(root, ["result", dir]), { code: 0, stdout: `[- | running | - | no final line yet | session=- | out=${dir}]\n`, stderr: "" });
});

test("result prints only the first line of a runner's status, and an empty status as running", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-cli-"));
  const dir = path.join(root, "codex-two-lines");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "prompt.md"), "brief\n");
  const line = `[codex | ok | m1 | low read in=1 out=2 | session=t-1 | out=${dir}]`;
  fs.writeFileSync(path.join(dir, "status"), `${line}\nINJECTED SECOND LINE\n`);
  assert.deepEqual(delegate(root, ["result", dir, "--quiet"]), { code: 0, stdout: `${line}\n`, stderr: "" });
  fs.writeFileSync(path.join(dir, "status"), "");
  assert.deepEqual(delegate(root, ["result", dir, "--quiet"]), {
    code: 0,
    stdout: `[- | running | - | no final line yet | session=- | out=${dir}]\n`,
    stderr: "",
  });
});
