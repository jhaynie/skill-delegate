import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createDirect, directFinalLine, patchDirect, readDirect } from "./direct.ts";
import type { LiveSnapshot } from "./livescan.ts";
import { reconcile } from "./owner.ts";
import { startTime } from "./procs.ts";
import { admitResume, initScratchSource, pruneRuns, resolvePruneRoot, scratchWorkspace, type PruneReport } from "./prune.ts";
import { createRun, newNonce, ownerLock } from "./run.ts";
import type { RunId, RunNonce, SessionId } from "./state.ts";
import { HOST_MARKERS } from "./workers.ts";

const CLI = path.join(import.meta.dirname, "cli.ts");
const OLD_MS = 8 * 86_400_000;
const KEEP_MS = 2 * 86_400_000;

function delegate(root: string, args: string[], extra: NodeJS.ProcessEnv = {}, timeout = 30_000) {
  const env: NodeJS.ProcessEnv = { ...process.env, DELEGATE_OUT_ROOT: root, ...extra };
  for (const name of HOST_MARKERS) {
    if (!Object.hasOwn(extra, name)) delete env[name];
  }
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env, timeout });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function emptySnapshot(): LiveSnapshot {
  return { kind: "ok", procs: new Map(), paths: new Map() };
}

function prune(root: string, dryRun = false): PruneReport {
  const resolved = resolvePruneRoot(root);
  assert.equal(resolved.kind, "ready");
  if (resolved.kind !== "ready") throw new Error("expected a readable run root");
  return pruneRuns({ root: resolved.root, olderThanMs: 7 * 86_400_000, dryRun, now: Date.now(), snapshot: emptySnapshot });
}

function isolatedRoot(t: { after: (fn: () => void) => void }): string {
  const base = path.join(import.meta.dirname, "..", "..", "..", "tmp", "delegate-prune");
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(base, "root-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runHome(t: { after: (fn: () => void) => void }): string {
  const base = path.join(import.meta.dirname, "..", "..", "..", "tmp", "delegate-prune");
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(base, "home-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function stamp(file: string, when: number): void {
  const date = new Date(when);
  fs.utimesSync(file, date, date);
}

function endedManaged(
  root: string,
  name: string,
  over: { cwd?: string; leftover?: number; workspaceSource?: string; nonce?: string } = {},
) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const run = createRun(
    {
      id: dir as RunId,
      nonce: (over.nonce ?? newNonce()) as RunNonce,
      cli: "grok",
      target: "/repo",
      cwd: over.cwd ?? "/repo",
      gitRoot: null,
      preset: "read",
      model: "grok-4.7",
      effort: "medium",
      deadlineAt: 0,
      sandbox: null,
      ...(over.workspaceSource === undefined ? {} : { workspaceSource: over.workspaceSource }),
    },
    "brief",
  );
  run.commit({
    ...run.state(),
    sessionId: `sess-${name}` as SessionId,
    turns: [{ n: 1, end: "complete", tools: 0, text: true }],
    phase: { kind: "ended", outcome: "ok", reason: "", leftover: over.leftover ?? 0, dirty: null },
  });
  return run;
}

function endedDirect(
  root: string,
  name: string,
  over: { status?: string | null; workspaceSource?: string; provider?: "codex" | "cursor" } = {},
) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const provider = over.provider ?? "codex";
  if (provider === "codex") {
    createDirect(dir, {
      provider: "codex",
      target: "/repo",
      gitRoot: null,
      model: "gpt-6-sol",
      mode: "read",
      effort: "medium",
      ...(over.workspaceSource === undefined ? {} : { workspaceSource: over.workspaceSource }),
    });
  } else {
    createDirect(dir, {
      provider: "cursor",
      target: "/repo",
      gitRoot: null,
      model: "auto",
      mode: "read",
      ...(over.workspaceSource === undefined ? {} : { workspaceSource: over.workspaceSource }),
    });
  }
  fs.writeFileSync(path.join(dir, "prompt.md"), "brief\n");
  if (over.status !== null) {
    const cli = provider === "codex" ? "codex" : "cursor";
    const model = provider === "codex" ? "gpt-6-sol" : "auto";
    fs.writeFileSync(path.join(dir, "status"), over.status ?? `[${cli} | ok | ${model} | read | session=- | out=${dir}]\n`);
  }
  return dir;
}

function oldEnough(dir: string): void {
  storedTime(dir, Date.now() - OLD_MS);
  const status = path.join(dir, "status");
  stamp(fs.existsSync(status) ? status : path.join(dir, "state.json"), Date.now() - OLD_MS);
}

function storedTime(dir: string, when: number): void {
  const file = path.join(dir, fs.existsSync(path.join(dir, "state.json")) ? "state.json" : "run.json");
  if (!fs.existsSync(file)) return;
  const meta = JSON.parse(fs.readFileSync(file, "utf8"));
  meta.heartbeatAt = when;
  if (meta.phase?.completedAt !== undefined) meta.phase.completedAt = when;
  if (meta.completedAt !== undefined) meta.completedAt = when;
  fs.writeFileSync(file, JSON.stringify(meta));
}

function tooNew(dir: string): void {
  storedTime(dir, Date.now() - KEEP_MS);
  stamp(path.join(dir, "status"), Date.now() - KEEP_MS);
}

function decisionOf(report: PruneReport, dir: string) {
  return report.decisions.find((decision) => decision.dir === dir);
}

function protocolSource(root: string, name: string) {
  const nonce = newNonce();
  const workspace = scratchWorkspace(path.join(root, name), nonce);
  const run = endedManaged(root, name, { cwd: workspace, nonce });
  fs.mkdirSync(workspace, { recursive: true });
  initScratchSource(run.dir);
  return { run, workspace, nonce };
}

test("prune requires a positive whole duration with a unit", (t) => {
  const root = isolatedRoot(t);
  assert.equal(delegate(root, ["prune"]).code, 2);
  assert.match(delegate(root, ["prune"]).stderr, /--older-than takes a positive duration/);
  assert.equal(delegate(root, ["prune", "--older-than", "7"]).code, 2);
  assert.equal(delegate(root, ["prune", "--older-than", "0d"]).code, 2);
  assert.equal(delegate(root, ["prune", "--older-than", "-1d"]).code, 2);
  assert.equal(delegate(root, ["prune", "--older-than", "7w"]).code, 2);
  assert.equal(delegate(root, ["prune", "--older-than", "999999999999999d"]).code, 2);
});

test("the real prune CLI prints exact keep and would-delete lines", (t) => {
  if ((spawnSync("lsof", ["-v"], { stdio: "ignore" }).error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    t.skip("lsof is not on PATH");
    return;
  }
  const root = isolatedRoot(t);
  const old = endedManaged(root, "old");
  const recent = endedManaged(root, "recent");
  oldEnough(old.dir);
  tooNew(recent.dir);
  const env: NodeJS.ProcessEnv = { ...process.env, DELEGATE_OUT_ROOT: root };
  for (const name of HOST_MARKERS) delete env[name];
  const result = spawnSync(path.join(import.meta.dirname, "..", "bin", "delegate"), ["prune", "--older-than", "7d", "--dry-run"], {
    encoding: "utf8", env, timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, `would delete ${old.dir}\nkeep ${recent.dir} not older than cutoff\nwould_delete=1 deleted=0 kept=1 failed=0\n`);
  assert.equal(fs.existsSync(old.dir), true);
  assert.equal(fs.existsSync(recent.dir), true);
});

test("preview and apply delete old completed managed and direct runs, keep recent ones, and repeat is a no-op", (t) => {
  const root = isolatedRoot(t);
  const oldManaged = endedManaged(root, "old-managed");
  const oldDirect = endedDirect(root, "old-direct");
  const recent = endedManaged(root, "recent-managed");
  oldEnough(oldManaged.dir);
  oldEnough(oldDirect);
  tooNew(recent.dir);
  const before = fs.readdirSync(root).sort().join("\n");
  const preview = prune(root, true);
  assert.equal(preview.failed, 0);
  assert.equal(fs.readdirSync(root).sort().join("\n"), before);
  assert.equal(decisionOf(preview, oldDirect)?.kind, "delete");
  assert.equal(decisionOf(preview, oldManaged.dir)?.kind, "delete");
  assert.deepEqual(decisionOf(preview, recent.dir), { kind: "keep", dir: recent.dir, reason: "not older than cutoff" });
  assert.equal(preview.decisions.filter((d) => d.kind === "delete").length, 2);
  assert.equal(preview.deleted, 0);
  assert.equal(preview.kept, 1);
  const apply = prune(root);
  assert.equal(apply.failed, 0);
  assert.equal(fs.existsSync(oldManaged.dir), false);
  assert.equal(fs.existsSync(oldDirect), false);
  assert.equal(fs.existsSync(recent.dir), true);
  assert.equal(apply.deleted, 2);
  assert.equal(apply.kept, 1);
  const again = prune(root);
  assert.equal(again.failed, 0);
  assert.equal(fs.existsSync(recent.dir), true);
  assert.deepEqual(decisionOf(again, recent.dir), { kind: "keep", dir: recent.dir, reason: "not older than cutoff" });
  assert.equal(again.deleted, 0);
  assert.equal(again.kept, 1);
});

test("a completion time equal to the cutoff is kept, and one millisecond older is deleted", (t) => {
  const root = isolatedRoot(t);
  const run = endedManaged(root, "edge");
  const got = Date.now() - 60_000;
  run.commit({ ...run.state(), heartbeatAt: got });
  const olderThanMs = 10_000;
  const equal = pruneRuns({ root, olderThanMs, dryRun: true, now: got + olderThanMs, snapshot: emptySnapshot });
  const older = pruneRuns({ root, olderThanMs, dryRun: true, now: got + olderThanMs + 1, snapshot: emptySnapshot });
  assert.deepEqual(equal.decisions[0], { kind: "keep", dir: run.dir, reason: "not older than cutoff" });
  assert.equal(older.decisions[0]?.kind, "delete");
  assert.equal(fs.existsSync(run.dir), true);
});

test("legacy runner directories with a final status are eligible, and older completed results still read", (t) => {
  const root = isolatedRoot(t);
  const dir = path.join(root, "codex-legacy");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "prompt.md"), "brief\n");
  fs.writeFileSync(path.join(dir, "status"), `[codex | ok | - | done | session=- | out=${dir}]\n`);
  fs.writeFileSync(path.join(dir, "answer.md"), "legacy answer\n");
  oldEnough(dir);
  const read = delegate(root, ["result", dir]);
  assert.equal(read.code, 0, read.stderr);
  assert.match(read.stdout, /legacy answer/);
  const applied = prune(root);
  assert.equal(applied.failed, 0);
  assert.equal(decisionOf(applied, dir)?.kind, "delete");
  assert.equal(fs.existsSync(dir), false);
});

test("active locks, unknown workers, unfinished runs, and cleanup uncertainty stay while numeric cleanup counts allow deletion", (t) => {
  const root = isolatedRoot(t);
  const live = endedManaged(root, "live-lock");
  oldEnough(live.dir);
  assert.equal(ownerLock(live.dir).lock(), true);
  const unfinished = endedManaged(root, "unfinished");
  unfinished.commit({ ...unfinished.state(), phase: { kind: "starting" } });
  oldEnough(unfinished.dir);
  const leftover = endedManaged(root, "leftover", { leftover: 2 });
  oldEnough(leftover.dir);
  const unknown = endedManaged(root, "unknown-worker");
  unknown.commit({ ...unknown.state(), workerPgid: 4242, phase: unknown.state().phase });
  oldEnough(unknown.dir);
  const uncertain = endedDirect(root, "uncertain", {
    status: `[codex | fail | gpt-6-sol | medium read cleanup uncertain: worker identity was not recorded | session=- | out=${path.join(root, "uncertain")}]\n`,
  });
  oldEnough(uncertain);
  const applied = prune(root);
  assert.equal(applied.failed, 0);
  assert.equal(fs.existsSync(live.dir), true);
  assert.equal(fs.existsSync(unfinished.dir), true);
  assert.equal(fs.existsSync(leftover.dir), false);
  assert.equal(fs.existsSync(unknown.dir), true);
  assert.equal(fs.existsSync(uncertain), true);
  assert.deepEqual(decisionOf(applied, live.dir), { kind: "keep", dir: live.dir, reason: "owner.lock is held" });
  assert.deepEqual(decisionOf(applied, unfinished.dir), { kind: "keep", dir: unfinished.dir, reason: "not completed" });
  assert.equal(decisionOf(applied, leftover.dir)?.kind, "delete");
  assert.deepEqual(decisionOf(applied, unknown.dir), { kind: "keep", dir: unknown.dir, reason: "worker identity is unknown" });
  assert.deepEqual(decisionOf(applied, uncertain), { kind: "keep", dir: uncertain, reason: "cleanup is uncertain" });
});

test("a live recorded worker keeps its run", (t) => {
  const root = isolatedRoot(t);
  const start = startTime(process.pid) ?? "Thu Jan  1 00:00:00 2026";
  const run = endedManaged(root, "live-worker");
  run.commit({ ...run.state(), workerPgid: process.pid, workerStart: start, phase: run.state().phase });
  oldEnough(run.dir);
  const applied = prune(root);
  assert.equal(applied.failed, 0);
  assert.equal(fs.existsSync(run.dir), true);
  assert.deepEqual(decisionOf(applied, run.dir), { kind: "keep", dir: run.dir, reason: "worker may still be running" });
});

test("symlink children are kept and their targets are not followed", (t) => {
  const root = isolatedRoot(t);
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(root), "outside-")));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const target = endedManaged(outside, "real");
  oldEnough(target.dir);
  const link = path.join(root, "link");
  fs.symlinkSync(target.dir, link);
  const applied = prune(root);
  assert.equal(applied.failed, 0);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.existsSync(target.dir), true);
  assert.deepEqual(decisionOf(applied, link), { kind: "keep", dir: link, reason: "symlink" });
});

test("a pre-run.json Cursor scratch directory with workspace/ is kept", (t) => {
  const root = isolatedRoot(t);
  const dir = path.join(root, "cursor-20240101-120000-abcd");
  fs.mkdirSync(path.join(dir, "workspace"), { recursive: true });
  fs.writeFileSync(path.join(dir, "prompt.md"), "brief\n");
  fs.writeFileSync(path.join(dir, "status"), `[cursor | ok | auto | read leftover=0 | session=c-1 | out=${dir}]\n`);
  oldEnough(dir);
  const applied = prune(root);
  assert.equal(applied.failed, 0);
  assert.equal(fs.existsSync(dir), true);
  assert.equal(fs.existsSync(path.join(dir, "workspace")), true);
  assert.deepEqual(decisionOf(applied, dir), { kind: "keep", dir: dir, reason: "legacy workspace has no pin protocol" });
});

test("direct and legacy status must be a terminal line of the final shape", (t) => {
  const root = isolatedRoot(t);
  const running = endedDirect(root, "running", {
    status: `[codex | running | gpt-6-sol | medium read | session=- | out=${path.join(root, "running")}]\n`,
  });
  oldEnough(running);
  const leftoverQ = endedDirect(root, "leftover-q", {
    status: `[codex | ok | gpt-6-sol | read leftover=? | session=- | out=${path.join(root, "leftover-q")}]\n`,
  });
  oldEnough(leftoverQ);
  const leftoverN = endedDirect(root, "leftover-n", {
    status: `[codex | ok | gpt-6-sol | read leftover=2 | session=- | out=${path.join(root, "leftover-n")}]\n`,
  });
  oldEnough(leftoverN);
  const malformed = endedDirect(root, "malformed", { status: "not a status line\n" });
  oldEnough(malformed);
  const clean = endedDirect(root, "clean");
  oldEnough(clean);
  const applied = prune(root);
  assert.equal(applied.failed, 0);
  assert.equal(fs.existsSync(running), true);
  assert.equal(fs.existsSync(leftoverQ), true);
  assert.equal(fs.existsSync(leftoverN), false);
  assert.equal(fs.existsSync(malformed), true);
  assert.equal(fs.existsSync(clean), false);
  assert.deepEqual(decisionOf(applied, running), { kind: "keep", dir: running, reason: "not completed" });
  assert.deepEqual(decisionOf(applied, leftoverQ), { kind: "keep", dir: leftoverQ, reason: "leftover processes" });
  assert.equal(decisionOf(applied, leftoverN)?.kind, "delete");
  assert.deepEqual(decisionOf(applied, malformed), { kind: "keep", dir: malformed, reason: "malformed identity" });
  assert.equal(decisionOf(applied, clean)?.kind, "delete");
});

test("direct final cleanup is parsed without a zero token and rejects leftover ambiguity", (t) => {
  const root = isolatedRoot(t);
  const finalLine = (dir: string, leftover: number) => directFinalLine(dir, readDirect(dir), {
    exitCode: 0,
    sessionId: "",
    detail: "read",
    failed: false,
    cleanup: { kind: "done", leftover },
  });
  const clean = endedDirect(root, "clean-final", { status: null });
  const zero = finalLine(clean, 0);
  assert.equal(zero.includes("leftover="), false);
  fs.writeFileSync(path.join(clean, "status"), `${zero}\n`);
  oldEnough(clean);

  const leftover = endedDirect(root, "leftover-final", { status: null });
  fs.writeFileSync(path.join(leftover, "status"), `${finalLine(leftover, 3)}\n`);
  oldEnough(leftover);

  const duplicate = endedDirect(root, "duplicate-leftover", { status: null });
  const malformed = endedDirect(root, "malformed-leftover", { status: null });
  const unknown = endedDirect(root, "unknown-provider", { status: null });
  fs.writeFileSync(path.join(duplicate, "status"), `${finalLine(duplicate, 0).replace(" | session=", " leftover=0 leftover=3 | session=")}\n`);
  fs.writeFileSync(path.join(malformed, "status"), `${finalLine(malformed, 0).replace(" | session=", " leftover=garbled | session=")}\n`);
  fs.writeFileSync(path.join(unknown, "status"), `${finalLine(unknown, 0).replace("[codex |", "[unknown |")}\n`);
  for (const dir of [duplicate, malformed, unknown]) oldEnough(dir);

  const applied = prune(root);
  assert.equal(applied.failed, 0);
  assert.equal(decisionOf(applied, clean)?.kind, "delete");
  assert.equal(decisionOf(applied, leftover)?.kind, "delete");
  for (const dir of [duplicate, malformed, unknown]) {
    assert.deepEqual(decisionOf(applied, dir), { kind: "keep", dir: dir, reason: "malformed identity" });
    assert.equal(fs.existsSync(dir), true);
  }
});

test("a leftover .prune-* path, an active run with that name, and an unrelated matching dir stay", (t) => {
  const root = isolatedRoot(t);
  const leftover = path.join(root, ".prune-once-1-deadbeef");
  fs.mkdirSync(leftover);
  fs.writeFileSync(path.join(leftover, "junk"), "partial\n");
  const liveName = path.join(root, `.prune-live-${process.pid}-abcdabcd`);
  const live = endedManaged(root, path.basename(liveName));
  live.commit({ ...live.state(), phase: { kind: "starting" } });
  oldEnough(live.dir);
  const unrelated = path.join(root, ".prune-notes-9-ffffffff");
  fs.mkdirSync(unrelated);
  fs.writeFileSync(path.join(unrelated, "notes.txt"), "not a run\n");
  const eligible = endedManaged(root, "old-ok");
  oldEnough(eligible.dir);
  const preview = prune(root, true);
  assert.equal(preview.failed, 0);
  assert.deepEqual(decisionOf(preview, leftover), { kind: "keep", dir: leftover, reason: "needs manual cleanup" });
  assert.deepEqual(decisionOf(preview, live.dir), { kind: "keep", dir: live.dir, reason: "needs manual cleanup" });
  assert.deepEqual(decisionOf(preview, unrelated), { kind: "keep", dir: unrelated, reason: "needs manual cleanup" });
  assert.equal(decisionOf(preview, eligible.dir)?.kind, "delete");
  const applied = prune(root);
  assert.equal(applied.failed, 0);
  assert.equal(fs.existsSync(leftover), true);
  assert.equal(fs.existsSync(live.dir), true);
  assert.equal(fs.existsSync(unrelated), true);
  assert.equal(fs.existsSync(eligible.dir), false);
  assert.deepEqual(decisionOf(applied, leftover), { kind: "keep", dir: leftover, reason: "needs manual cleanup" });
  assert.deepEqual(decisionOf(applied, live.dir), { kind: "keep", dir: live.dir, reason: "needs manual cleanup" });
  assert.deepEqual(decisionOf(applied, unrelated), { kind: "keep", dir: unrelated, reason: "needs manual cleanup" });
  assert.equal(decisionOf(applied, eligible.dir)?.kind, "delete");
});

test("a failed recursive removal leaves a named tombstone for manual cleanup", (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root can remove directories despite mode 000");
    return;
  }
  const root = isolatedRoot(t);
  const run = endedManaged(root, "remove-failure");
  oldEnough(run.dir);
  const privateDir = path.join(run.dir, "private");
  fs.mkdirSync(privateDir);
  fs.writeFileSync(path.join(privateDir, "keep.txt"), "keep\n");
  fs.chmodSync(privateDir, 0o000);
  try {
    const applied = prune(root);
    assert.equal(applied.failed, 1);
    const tombstones = fs.readdirSync(root).filter((name) => name.startsWith(".prune-remove-failure-"));
    assert.equal(tombstones.length, 1);
    const name = tombstones[0];
    assert.ok(name);
    const tombstone = path.join(root, name);
    assert.deepEqual(decisionOf(applied, tombstone), { kind: "keep", dir: tombstone, reason: "remove failed" });
    const again = prune(root);
    assert.equal(again.failed, 0);
    assert.deepEqual(decisionOf(again, tombstone), { kind: "keep", dir: tombstone, reason: "needs manual cleanup" });
  } finally {
    const current = fs.readdirSync(root).find((name) => name === "remove-failure" || name.startsWith(".prune-remove-failure-"));
    if (current) fs.chmodSync(path.join(root, current, "private"), 0o700);
  }
});

test("symlink identity files are not followed", (t) => {
  const root = isolatedRoot(t);
  const real = endedManaged(root, "real-spec");
  oldEnough(real.dir);
  const decoy = endedManaged(root, "decoy");
  oldEnough(decoy.dir);
  fs.rmSync(real.file("spec.json"));
  fs.symlinkSync(decoy.file("spec.json"), real.file("spec.json"));
  const applied = prune(root);
  assert.equal(applied.failed, 0);
  assert.equal(fs.lstatSync(real.file("spec.json")).isSymbolicLink(), true);
  assert.equal(fs.existsSync(real.dir), true);
  assert.equal(fs.existsSync(decoy.dir), false);
  assert.deepEqual(decisionOf(applied, real.dir), { kind: "keep", dir: real.dir, reason: "symlink metadata" });
});

test("a legacy scratch workspace without workspace-pins stays, and resume does not add the marker", (t) => {
  const root = isolatedRoot(t);
  const workspace = path.join(root, "legacy-scratch", "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const run = endedManaged(root, "legacy-scratch", { cwd: workspace });
  oldEnough(run.dir);
  const applied = prune(root);
  assert.equal(applied.failed, 0);
  assert.equal(fs.existsSync(run.dir), true);
  assert.equal(fs.existsSync(path.join(run.dir, "workspace-pins")), false);
  assert.deepEqual(decisionOf(applied, run.dir), { kind: "keep", dir: run.dir, reason: "legacy workspace has no pin protocol" });
  const admitted = admitResume({
    sourceWorkspace: workspace,
    dependent: { dir: path.join(root, "dependent"), nonce: "abcdabcdabcdabcd" },
    writeDependent: () => fs.mkdirSync(path.join(root, "dependent")),
  });
  assert.equal(admitted.kind, "legacy");
  assert.equal(fs.existsSync(path.join(run.dir, "workspace-pins")), false);
});

test("a custom --out pin keeps its source while the dependent is live or recently completed", (t) => {
  const root = isolatedRoot(t);
  const source = protocolSource(root, "source");
  oldEnough(source.run.dir);
  const custom = fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(root), "custom-")));
  t.after(() => fs.rmSync(custom, { recursive: true, force: true }));
  const live = endedManaged(custom, "live-dep", { cwd: source.workspace, workspaceSource: source.workspace });
  live.commit({ ...live.state(), phase: { kind: "starting" } });
  const nonce = live.spec.nonce ?? newNonce();
  const pinned = admitResume({
    sourceWorkspace: source.workspace,
    dependent: { dir: live.dir, nonce },
    writeDependent: () => {},
  });
  assert.equal(pinned.kind, "pinned");
  const kept = prune(root);
  assert.equal(kept.failed, 0);
  assert.equal(fs.existsSync(source.run.dir), true);
  assert.equal(fs.existsSync(live.dir), true);
  assert.deepEqual(decisionOf(kept, source.run.dir), { kind: "keep", dir: source.run.dir, reason: "pin names a live run" });
  live.commit({
    ...live.state(),
    turns: [{ n: 1, end: "complete", tools: 0, text: true }],
    phase: { kind: "ended", outcome: "ok", reason: "", leftover: 0, dirty: null },
  });
  const recent = prune(root);
  assert.equal(recent.failed, 0);
  assert.equal(fs.existsSync(source.run.dir), true);
  assert.deepEqual(decisionOf(recent, source.run.dir), { kind: "keep", dir: source.run.dir, reason: "pin target: not older than cutoff" });
  oldEnough(live.dir);
  const gone = prune(root);
  assert.equal(gone.failed, 0);
  assert.equal(fs.existsSync(source.run.dir), false);
  assert.equal(fs.existsSync(live.dir), true);
});

test("an uncertain completed dependent pins its old source", (t) => {
  const root = isolatedRoot(t);
  const source = protocolSource(root, "uncertain-source");
  oldEnough(source.run.dir);
  const custom = fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(root), "uncertain-dep-")));
  t.after(() => fs.rmSync(custom, { recursive: true, force: true }));
  const dependent = endedDirect(custom, "run", { workspaceSource: source.workspace, status: null });
  fs.writeFileSync(path.join(dependent, "status"), `${directFinalLine(dependent, readDirect(dependent), {
    exitCode: 1,
    sessionId: "",
    detail: "read",
    failed: true,
    cleanup: { kind: "uncertain", detail: "worker identity was not recorded" },
  })}\n`);
  oldEnough(dependent);
  assert.equal(admitResume({
    sourceWorkspace: source.workspace,
    dependent: { dir: dependent, nonce: readDirect(dependent).nonce },
    writeDependent: () => {},
  }).kind, "pinned");
  const applied = prune(root);
  assert.equal(applied.failed, 0);
  assert.equal(fs.existsSync(source.run.dir), true);
  assert.deepEqual(decisionOf(applied, source.run.dir), { kind: "keep", dir: source.run.dir, reason: "pin names a live run" });
});

test("removing an inactive dependent also removes its source pin so the source can expire later", (t) => {
  const root = isolatedRoot(t);
  const source = protocolSource(root, "src");
  tooNew(source.run.dir);
  const dep = endedManaged(root, "dep", { cwd: source.workspace, workspaceSource: source.workspace });
  oldEnough(dep.dir);
  const nonce = dep.spec.nonce ?? "deadbeefdeadbeef";
  assert.equal(
    admitResume({
      sourceWorkspace: source.workspace,
      dependent: { dir: dep.dir, nonce },
      writeDependent: () => {},
    }).kind,
    "pinned",
  );
  assert.equal(fs.existsSync(path.join(source.run.dir, "workspace-pins", nonce)), true);
  const applied = prune(root);
  assert.equal(applied.failed, 0);
  assert.equal(fs.existsSync(dep.dir), false);
  assert.equal(fs.existsSync(source.run.dir), true);
  assert.equal(fs.existsSync(path.join(source.run.dir, "workspace-pins", nonce)), false);
});

test("two pruners serialize on owner.lock so exactly one reports delete", (t) => {
  const root = isolatedRoot(t);
  const run = endedManaged(root, "once");
  oldEnough(run.dir);
  const env: NodeJS.ProcessEnv = { ...process.env, DELEGATE_OUT_ROOT: root };
  for (const name of HOST_MARKERS) delete env[name];
  const code = `
    const { pruneRuns } = await import(${JSON.stringify(path.join(import.meta.dirname, "prune.ts"))});
    const report = pruneRuns({ root: ${JSON.stringify(root)}, olderThanMs: 7 * 86_400_000,
      dryRun: false, now: Date.now(), snapshot: () => ({ kind: "ok", procs: new Map(), paths: new Map() }) });
    for (const d of report.decisions) if (d.kind === "delete") console.log("delete " + d.dir);
  `;
  const a = spawn(process.execPath, ["--input-type=module", "-e", code], { env });
  const b = spawn(process.execPath, ["--input-type=module", "-e", code], { env });
  const wait = (child: ReturnType<typeof spawn>) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d) => (stdout += d));
      child.stderr?.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  return Promise.all([wait(a), wait(b)]).then(([left, right]) => {
    assert.equal(left.code, 0, left.stderr);
    assert.equal(right.code, 0, right.stderr);
    assert.equal(fs.existsSync(run.dir), false);
    const deleted = [left, right].filter((r) => r.stdout.includes(`delete ${run.dir}`)).length;
    assert.equal(deleted, 1);
  });
});

test("holding the pin lock keeps prune from renaming, then releasing it lets prune finish", (t) => {
  const root = isolatedRoot(t);
  const source = protocolSource(root, "locked-source");
  oldEnough(source.run.dir);
  const lock = ownerLock(path.join(source.run.dir, "workspace-pins"));
  assert.equal(lock.takeover(), true);
  const blocked = prune(root);
  assert.equal(blocked.failed, 0);
  assert.equal(fs.existsSync(source.run.dir), true);
  assert.deepEqual(decisionOf(blocked, source.run.dir), { kind: "keep", dir: source.run.dir, reason: "cannot lock workspace-pins" });
  lock.unlock();
  const applied = prune(root);
  assert.equal(applied.failed, 0);
  assert.equal(fs.existsSync(source.run.dir), false);
});

test("prune then resume refuses a Cursor map whose workspace was deleted", (t) => {
  const home = runHome(t);
  const root = path.join(home, "runs");
  fs.mkdirSync(root);
  const target = path.join(home, "target");
  fs.mkdirSync(target);
  execFileSync("git", ["-C", target, "init", "-q"]);
  fs.writeFileSync(path.join(home, "brief.md"), "brief\n");
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "cursor-agent"), `#!/bin/sh\nexit 0\n`, { mode: 0o755 });
  const sessions = path.join(home, ".config", "delegate", "cursor-sessions");
  fs.mkdirSync(sessions, { recursive: true });
  const source = endedDirect(root, "cursor-source", { provider: "cursor" });
  const nonce = readDirect(source).nonce;
  const workspace = scratchWorkspace(source, nonce);
  fs.mkdirSync(workspace, { recursive: true });
  initScratchSource(source);
  fs.writeFileSync(path.join(sessions, "c-1"), `${workspace}\n`);
  oldEnough(source);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    DELEGATE_OUT_ROOT: root,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
  };
  for (const name of HOST_MARKERS) delete env[name];
  const pruned = prune(root);
  assert.equal(pruned.failed, 0);
  assert.equal(fs.existsSync(source), false);
  const resumed = spawnSync(
    process.execPath,
    [CLI, "run", "--cli", "cursor", "--cwd", target, "--prompt-file", path.join(home, "brief.md"), "--resume", "c-1"],
    { encoding: "utf8", env, timeout: 15_000 },
  );
  assert.equal(resumed.status, 2, resumed.stderr);
  assert.match(resumed.stderr, /session workspace expired/);
  assert.equal(fs.existsSync(workspace), false);
});

test("resume then prune keeps a source that has a live pin", (t) => {
  const root = isolatedRoot(t);
  const source = protocolSource(root, "live-source");
  oldEnough(source.run.dir);
  const depDir = path.join(root, "pinned-dep");
  fs.mkdirSync(depDir);
  const nonce = newNonce();
  assert.equal(
    admitResume({
      sourceWorkspace: source.workspace,
      dependent: { dir: depDir, nonce },
      writeDependent: () => {
        createRun(
          {
            id: depDir as RunId,
            nonce,
            cli: "devin",
            target: "/repo",
            cwd: source.workspace,
            gitRoot: null,
            preset: "read",
            model: "swe-2-high",
            effort: "medium",
            deadlineAt: 0,
            sandbox: null,
            workspaceSource: source.workspace,
          },
          "brief",
        );
      },
    }).kind,
    "pinned",
  );
  const kept = prune(root);
  assert.equal(kept.failed, 0);
  assert.equal(fs.existsSync(source.run.dir), true);
  assert.deepEqual(decisionOf(kept, source.run.dir), { kind: "keep", dir: source.run.dir, reason: "pin names a live run" });
});

test("a missing managed workspace on resume is refused and is not created again", (t) => {
  const home = runHome(t);
  const root = path.join(home, "runs");
  fs.mkdirSync(root);
  const target = path.join(home, "target");
  fs.mkdirSync(target);
  execFileSync("git", ["-C", target, "init", "-q"]);
  fs.writeFileSync(path.join(home, "brief.md"), "brief\n");
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "devin"), `#!/bin/sh\nexit 0\n`, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    DELEGATE_OUT_ROOT: root,
    HOME: home,
  };
  for (const name of HOST_MARKERS) delete env[name];
  const source = protocolSource(root, "gone-ws");
  fs.rmSync(source.workspace, { recursive: true, force: true });
  const resumed = spawnSync(
    process.execPath,
    [CLI, "run", "--cli", "devin", "--cwd", target, "--prompt-file", path.join(home, "brief.md"), "--resume", "sess-gone-ws"],
    { encoding: "utf8", env, timeout: 15_000 },
  );
  assert.equal(resumed.status, 2, resumed.stderr);
  assert.match(resumed.stderr, /session workspace expired/);
  assert.equal(fs.existsSync(source.workspace), false);
});

function waitFile(file: string, ms = 8_000): Promise<void> {
  const until = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (fs.existsSync(file)) return resolve();
      if (Date.now() > until) return reject(new Error(`timed out waiting for ${file}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

function waitChild(child: ReturnType<typeof spawn>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function fakeCursorAgent(home: string): string {
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, "cursor-agent"),
    `#!${process.execPath}
import fs from "node:fs";
import path from "node:path";
const env = process.env;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (env.FAKE_PIN_SOURCE && env.FAKE_PIN_DEPENDENT && env.FAKE_PIN_OBSERVED) {
  const nonce = JSON.parse(fs.readFileSync(path.join(env.FAKE_PIN_DEPENDENT, "run.json"), "utf8")).nonce;
  const pin = JSON.parse(fs.readFileSync(path.join(env.FAKE_PIN_SOURCE, nonce), "utf8"));
  fs.writeFileSync(env.FAKE_PIN_OBSERVED, JSON.stringify(pin));
}
if (env.FAKE_HOLD) while (!fs.existsSync(env.FAKE_HOLD)) await sleep(20);
if (env.FAKE_STARTED) fs.writeFileSync(env.FAKE_STARTED, "started\\n");
for await (const _ of process.stdin);
process.stdout.write(env.FAKE_OUTPUT ?? '{"is_error":false,"session_id":"c-1","result":"ok"}\\n');
`,
    { mode: 0o755 },
  );
  return `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`;
}

function fakeDevin(home: string): string {
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const worker = path.join(bin, "devin-worker.mjs");
  fs.writeFileSync(
    worker,
    `import fs from "node:fs";
import readline from "node:readline";
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\\n");
if (process.env.FAKE_HOLD) {
  const until = Date.now() + 30_000;
  while (!fs.existsSync(process.env.FAKE_HOLD) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
if (process.env.FAKE_STARTED) fs.writeFileSync(process.env.FAKE_STARTED, "started\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  switch (msg.method) {
    case "initialize":
      return send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
    case "session/new":
      return send({ id: msg.id, result: { sessionId: process.env.FAKE_SESSION ?? "fake-1", configOptions: [] } });
    case "session/load":
      return send({ id: msg.id, result: { configOptions: [] } });
    case "session/set_config_option":
      return send({ id: msg.id, result: { configOptions: [] } });
    case "session/prompt":
      send({ method: "session/update", params: { sessionId: "fake-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } } });
      return send({ id: msg.id, result: { stopReason: "end_turn" } });
    case "session/cancel":
      return;
  }
}).on("close", () => process.exit(0));
`,
  );
  fs.writeFileSync(path.join(bin, "devin"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(worker)} "$@"\n`, { mode: 0o755 });
  return `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`;
}

function cliEnv(home: string, root: string, PATH: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    DELEGATE_OUT_ROOT: root,
    ...extra,
  };
  for (const name of HOST_MARKERS) {
    if (!Object.hasOwn(extra, name)) delete env[name];
  }
  return env;
}

test("a missing run root is empty, and an unreadable or non-directory root is an error", (t) => {
  const missing = path.join(isolatedRoot(t), "no-such-root");
  const empty = delegate(missing, ["prune", "--older-than", "7d"]);
  assert.equal(empty.code, 0, empty.stderr);
  assert.equal(empty.stdout, "deleted=0 kept=0 failed=0\n");
  const preview = delegate(missing, ["prune", "--older-than", "7d", "--dry-run"]);
  assert.equal(preview.stdout, "would_delete=0 deleted=0 kept=0 failed=0\n");
  const home = isolatedRoot(t);
  const fileRoot = path.join(home, "file-root");
  fs.writeFileSync(fileRoot, "not a dir\n");
  const bad = delegate(fileRoot, ["prune", "--older-than", "7d"]);
  assert.equal(bad.code, 2, bad.stderr);
  assert.match(bad.stderr, /run root is not a directory/);
});

test("an inaccessible run root is an error instead of an empty result", (t) => {
  const home = isolatedRoot(t);
  const privateParent = path.join(home, "private");
  const root = path.join(privateParent, "runs");
  fs.mkdirSync(root, { recursive: true });
  fs.chmodSync(privateParent, 0o000);
  try {
    const resolved = resolvePruneRoot(root);
    assert.equal(resolved.kind, "error");
    if (resolved.kind === "error") assert.match(resolved.message, /cannot read the run root.*EACCES/);
  } finally {
    fs.chmodSync(privateParent, 0o700);
  }
});

test("a symlink run root is canonicalized, and a child symlink is not followed", (t) => {
  const real = isolatedRoot(t);
  const run = endedManaged(real, "old");
  oldEnough(run.dir);
  const parent = isolatedRoot(t);
  const link = path.join(parent, "root-link");
  fs.symlinkSync(real, link);
  const applied = prune(link);
  assert.equal(applied.failed, 0);
  assert.equal(fs.existsSync(run.dir), false);
  assert.equal(decisionOf(applied, run.dir)?.kind, "delete");
});

test("a symlink root keeps an unpinned legacy workspace recorded through the alias", (t) => {
  const real = isolatedRoot(t);
  const parent = isolatedRoot(t);
  const alias = path.join(parent, "runs-link");
  fs.symlinkSync(real, alias);
  const workspace = path.join(real, "legacy", "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const run = endedManaged(real, "legacy", { cwd: path.join(alias, "legacy", "workspace") });
  oldEnough(run.dir);

  const applied = prune(alias);
  assert.equal(applied.failed, 0);
  assert.equal(fs.existsSync(workspace), true);
  assert.deepEqual(decisionOf(applied, run.dir), { kind: "keep", dir: run.dir, reason: "legacy workspace has no pin protocol" });
});

test("a symlink or malformed workspace-pins directory keeps the source", (t) => {
  const root = isolatedRoot(t);
  const linked = protocolSource(root, "pin-link");
  oldEnough(linked.run.dir);
  const pins = path.join(linked.run.dir, "workspace-pins");
  fs.rmSync(pins, { recursive: true, force: true });
  fs.symlinkSync(root, pins);
  const broken = protocolSource(root, "pin-bad");
  oldEnough(broken.run.dir);
  fs.writeFileSync(path.join(broken.run.dir, "workspace-pins", "not-a-pin"), "nope\n");
  const applied = prune(root);
  assert.equal(applied.failed, 0);
  assert.equal(fs.existsSync(linked.run.dir), true);
  assert.equal(fs.existsSync(broken.run.dir), true);
  assert.deepEqual(decisionOf(applied, linked.run.dir), { kind: "keep", dir: linked.run.dir, reason: "pin is unreadable" });
  assert.deepEqual(decisionOf(applied, broken.run.dir), { kind: "keep", dir: broken.run.dir, reason: "pin is unreadable" });
});

test("holding owner.lock keeps prune from renaming, and claimOut cannot take the path until it is gone", (t) => {
  const root = isolatedRoot(t);
  const run = endedManaged(root, "held");
  oldEnough(run.dir);
  const lock = ownerLock(run.dir);
  assert.equal(lock.takeover(), true);
  const blocked = prune(root);
  assert.equal(blocked.failed, 0);
  assert.equal(fs.existsSync(run.dir), true);
  assert.ok(blocked.decisions.some((d) => d.dir === run.dir && d.kind === "keep" && /owner.lock is held|cannot lock/.test(d.reason)));
  lock.unlock();
  const applied = prune(root);
  assert.equal(applied.failed, 0);
  assert.equal(fs.existsSync(run.dir), false);
});

test("pin retention lock serializes resume and prune in both orders", async (t) => {
  const root = isolatedRoot(t);
  const source = protocolSource(root, "barrier-source");
  oldEnough(source.run.dir);
  const pins = path.join(source.run.dir, "workspace-pins");
  const held = ownerLock(pins);
  assert.equal(held.takeover(), true);
  const busy = admitResume({
    sourceWorkspace: source.workspace,
    dependent: { dir: path.join(root, "busy-dep"), nonce: newNonce() },
    writeDependent: () => {
      throw new Error("writeDependent must not run while the pin lock is held");
    },
  });
  assert.equal(busy.kind, "busy");
  const blocked = prune(root);
  assert.equal(fs.existsSync(source.run.dir), true);
  assert.deepEqual(decisionOf(blocked, source.run.dir), { kind: "keep", dir: source.run.dir, reason: "cannot lock workspace-pins" });
  held.unlock();

  const ready = path.join(root, "admit.ready");
  const go = path.join(root, "admit.go");
  const resultFile = path.join(root, "admit.result");
  const depDir = path.join(root, "barrier-dep");
  fs.mkdirSync(depDir);
  const nonce = newNonce();
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import fs from "node:fs";
       const { admitResume } = await import(${JSON.stringify(path.join(import.meta.dirname, "prune.ts"))});
       const admitted = admitResume({
         sourceWorkspace: ${JSON.stringify(source.workspace)},
         dependent: { dir: ${JSON.stringify(depDir)}, nonce: ${JSON.stringify(nonce)} },
         writeDependent: () => {
           fs.writeFileSync(${JSON.stringify(ready)}, "");
           const until = Date.now() + 10_000;
           while (!fs.existsSync(${JSON.stringify(go)}) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
         },
       });
       fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(admitted));`,
    ],
    { env: { ...process.env, DELEGATE_OUT_ROOT: root } },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  });
  await waitFile(ready);
  const during = prune(root);
  assert.equal(fs.existsSync(source.run.dir), true);
  assert.deepEqual(decisionOf(during, source.run.dir), { kind: "keep", dir: source.run.dir, reason: "cannot lock workspace-pins" });
  fs.writeFileSync(go, "");
  const finished = await waitChild(child);
  assert.equal(finished.code, 0, finished.stderr);
  assert.equal(JSON.parse(fs.readFileSync(resultFile, "utf8")).kind, "pinned");
});

test("live Cursor resume to custom --out pins before the worker starts and keeps the source", async (t) => {
  const base = path.join(import.meta.dirname, "..", "..", "..", "tmp", "delegate-prune");
  fs.mkdirSync(base, { recursive: true });
  const home = fs.realpathSync(fs.mkdtempSync(path.join(base, "home-")));
  const root = path.join(home, "runs");
  fs.mkdirSync(root);
  const target = path.join(home, "target");
  fs.mkdirSync(target);
  execFileSync("git", ["-C", target, "init", "-q"]);
  fs.writeFileSync(path.join(home, "brief.md"), "brief\n");
  const PATH = fakeCursorAgent(home);
  const env = cliEnv(home, root, PATH);
  const hold = path.join(home, "resume.hold");
  const started = path.join(home, "resume.started");
  const observed = path.join(home, "resume.pin-observed");
  const custom = path.join(home, "outside", "cursor-b");
  let childDone: ReturnType<typeof waitChild> | undefined;
  t.after(async () => {
    try {
      fs.writeFileSync(hold, "");
      if (childDone) await childDone;
      if (fs.existsSync(path.join(custom, "run.json"))) {
        spawnSync(process.execPath, [CLI, "stop", custom], { env, timeout: 8_000 });
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
  const firstOut = path.join(root, "cursor-a");
  const first = spawnSync(
    process.execPath,
    [CLI, "run", "--cli", "cursor", "--cwd", target, "--prompt-file", path.join(home, "brief.md"), "--out", firstOut, "--wait"],
    { encoding: "utf8", env, timeout: 20_000 },
  );
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  assert.equal(fs.existsSync(path.join(firstOut, "run.json")), true, `${first.stdout}\n${first.stderr}`);
  assert.match(fs.readFileSync(path.join(firstOut, "status"), "utf8"), /^\[cursor \| ok \|/);
  const meta = readDirect(firstOut);
  const workspace = meta.workspaceSource ?? scratchWorkspace(firstOut, meta.nonce);
  assert.equal(path.basename(workspace), `workspace-${meta.nonce}`);
  assert.equal(fs.existsSync(path.join(firstOut, "workspace-pins")), true);
  oldEnough(firstOut);
  fs.mkdirSync(path.dirname(custom), { recursive: true });
  const child = spawn(
    process.execPath,
    [CLI, "run", "--cli", "cursor", "--cwd", target, "--prompt-file", path.join(home, "brief.md"), "--out", custom, "--resume", "c-1"],
    { env: cliEnv(home, root, PATH, {
      FAKE_HOLD: hold,
      FAKE_STARTED: started,
      FAKE_PIN_SOURCE: path.join(firstOut, "workspace-pins"),
      FAKE_PIN_DEPENDENT: custom,
      FAKE_PIN_OBSERVED: observed,
    }) },
  );
  childDone = waitChild(child);
  const until = Date.now() + 10_000;
  while (Date.now() < until && !fs.existsSync(path.join(custom, "run.json"))) await new Promise((r) => setTimeout(r, 20));
  const resumeMeta = readDirect(custom);
  await waitFile(path.join(firstOut, "workspace-pins", resumeMeta.nonce));
  await waitFile(observed);
  assert.deepEqual(JSON.parse(fs.readFileSync(observed, "utf8")), { out: custom, nonce: resumeMeta.nonce });
  assert.equal(fs.existsSync(started), false);
  const kept = prune(root);
  assert.equal(fs.existsSync(firstOut), true);
  assert.deepEqual(decisionOf(kept, firstOut), { kind: "keep", dir: firstOut, reason: "pin names a live run" });
  fs.writeFileSync(hold, "");
  const resumed = await childDone;
  assert.equal(resumed.code, 0, resumed.stderr);
  await waitFile(started);
  const completed = delegate(root, ["result", custom, "--wait", "--timeout", "10"], env);
  assert.equal(completed.code, 0, completed.stderr);
  assert.match(completed.stdout, /^\[cursor \| ok \|/);
});

test("expired whole-folder managed resume is refused, and --out reuse cannot redirect the old session", (t) => {
  const home = runHome(t);
  const root = path.join(home, "runs");
  fs.mkdirSync(root);
  const target = path.join(home, "target");
  fs.mkdirSync(target);
  execFileSync("git", ["-C", target, "init", "-q"]);
  fs.writeFileSync(path.join(home, "brief.md"), "brief\n");
  const PATH = fakeDevin(home);
  const env = cliEnv(home, root, PATH);
  const firstOut = path.join(root, "devin-a");
  const first = spawnSync(
    process.execPath,
    [CLI, "run", "--cli", "devin", "--cwd", target, "--prompt-file", path.join(home, "brief.md"), "--out", firstOut, "--wait"],
    { encoding: "utf8", env: cliEnv(home, root, PATH, { FAKE_SESSION: "s-old" }), timeout: 30_000 },
  );
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  assert.equal(fs.existsSync(path.join(firstOut, "spec.json")), true, `${first.stdout}\n${first.stderr}`);
  assert.match(fs.readFileSync(path.join(firstOut, "status"), "utf8"), /^\[devin \| ok \|/);
  const spec = JSON.parse(fs.readFileSync(path.join(firstOut, "spec.json"), "utf8")) as { nonce: string; cwd: string };
  assert.equal(spec.cwd, scratchWorkspace(firstOut, spec.nonce));
  assert.equal(fs.existsSync(path.join(firstOut, "workspace-pins")), true);
  oldEnough(firstOut);
  const pruned = prune(root);
  assert.equal(pruned.failed, 0);
  assert.equal(fs.existsSync(firstOut), false);
  const expired = spawnSync(
    process.execPath,
    [CLI, "run", "--cli", "devin", "--cwd", target, "--prompt-file", path.join(home, "brief.md"), "--resume", "s-old", "--wait"],
    { encoding: "utf8", env, timeout: 15_000 },
  );
  assert.equal(expired.status, 2, expired.stderr);
  assert.match(expired.stderr, /session workspace expired/);
  const reused = spawnSync(
    process.execPath,
    [CLI, "run", "--cli", "devin", "--cwd", target, "--prompt-file", path.join(home, "brief.md"), "--out", firstOut, "--wait"],
    { encoding: "utf8", env: cliEnv(home, root, PATH, { FAKE_SESSION: "s-new" }), timeout: 30_000 },
  );
  assert.equal(reused.status, 0, `${reused.stdout}\n${reused.stderr}`);
  assert.equal(fs.existsSync(path.join(firstOut, "spec.json")), true, `${reused.stdout}\n${reused.stderr}`);
  const reusedSpec = JSON.parse(fs.readFileSync(path.join(firstOut, "spec.json"), "utf8")) as { nonce: string; cwd: string };
  assert.equal(reusedSpec.cwd, scratchWorkspace(firstOut, reusedSpec.nonce));
  assert.notEqual(reusedSpec.nonce, spec.nonce);
  const redirect = spawnSync(
    process.execPath,
    [CLI, "run", "--cli", "devin", "--cwd", target, "--prompt-file", path.join(home, "brief.md"), "--out", path.join(root, "devin-b"), "--resume", "s-old", "--wait"],
    { encoding: "utf8", env, timeout: 15_000 },
  );
  assert.equal(redirect.status, 2, redirect.stderr);
  assert.match(redirect.stderr, /session workspace expired/);
  assert.equal(fs.existsSync(spec.cwd), false);
});

test("Cursor --out reuse after prune cannot attach the saved session to the new workspace", (t) => {
  const home = runHome(t);
  const root = path.join(home, "runs");
  fs.mkdirSync(root);
  const target = path.join(home, "target");
  fs.mkdirSync(target);
  execFileSync("git", ["-C", target, "init", "-q"]);
  fs.writeFileSync(path.join(home, "brief.md"), "brief\n");
  const PATH = fakeCursorAgent(home);
  const env = cliEnv(home, root, PATH);
  const firstOut = path.join(root, "cursor-reuse");
  const first = spawnSync(
    process.execPath,
    [CLI, "run", "--cli", "cursor", "--cwd", target, "--prompt-file", path.join(home, "brief.md"), "--out", firstOut, "--wait"],
    { encoding: "utf8", env, timeout: 20_000 },
  );
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  assert.equal(fs.existsSync(path.join(firstOut, "run.json")), true, `${first.stdout}\n${first.stderr}`);
  assert.match(fs.readFileSync(path.join(firstOut, "status"), "utf8"), /^\[cursor \| ok \|/);
  const oldMeta = readDirect(firstOut);
  const oldWorkspace = oldMeta.workspaceSource ?? scratchWorkspace(firstOut, oldMeta.nonce);
  oldEnough(firstOut);
  const pruned = prune(root);
  assert.equal(pruned.failed, 0);
  assert.equal(decisionOf(pruned, firstOut)?.kind, "delete");
  assert.equal(fs.existsSync(oldWorkspace), false);
  const second = spawnSync(
    process.execPath,
    [CLI, "run", "--cli", "cursor", "--cwd", target, "--prompt-file", path.join(home, "brief.md"), "--out", firstOut, "--wait"],
    {
      encoding: "utf8",
      env: cliEnv(home, root, PATH, { FAKE_OUTPUT: '{"is_error":false,"session_id":"c-2","result":"ok"}\n' }),
      timeout: 20_000,
    },
  );
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.equal(fs.existsSync(path.join(firstOut, "run.json")), true, `${second.stdout}\n${second.stderr}`);
  const newMeta = readDirect(firstOut);
  assert.notEqual(newMeta.nonce, oldMeta.nonce);
  assert.equal(newMeta.workspaceSource, scratchWorkspace(firstOut, newMeta.nonce));
  const resume = spawnSync(
    process.execPath,
    [CLI, "run", "--cli", "cursor", "--cwd", target, "--prompt-file", path.join(home, "brief.md"), "--out", path.join(root, "cursor-resume"), "--resume", "c-1"],
    { encoding: "utf8", env, timeout: 15_000 },
  );
  assert.equal(resume.status, 2, resume.stderr);
  assert.match(resume.stderr, /session workspace expired/);
  assert.equal(fs.existsSync(oldWorkspace), false);
});

test("managed completion age survives restoreStatus rewrites, including old heartbeat-only runs", async (t) => {
  for (const stored of [true, false]) {
    const root = isolatedRoot(t);
    const run = endedManaged(root, stored ? "stored" : "heartbeat");
    const now = Date.now();
    const completedAt = now - OLD_MS;
    const state = run.state();
    assert.equal(state.phase.kind, "ended");
    if (state.phase.kind !== "ended") continue;
    run.commit({ ...state, heartbeatAt: stored ? now : completedAt,
      phase: { ...state.phase, ...(stored ? { completedAt } : {}) } });
    fs.rmSync(run.file("status"));
    stamp(run.file("state.json"), completedAt);
    const input = { root, olderThanMs: 7 * 86_400_000, dryRun: true, now, snapshot: emptySnapshot };
    const before = pruneRuns(input);
    await reconcile(run);
    assert.ok(fs.statSync(run.file("state.json")).mtimeMs > completedAt);
    assert.equal(fs.existsSync(run.file("status")), true);
    assert.deepEqual(pruneRuns(input).decisions, before.decisions);
    assert.deepEqual(before.decisions, [{ kind: "delete", dir: run.dir, ageMs: OLD_MS }]);
    const restored = run.state();
    assert.equal(restored.phase.kind === "ended" && restored.phase.completedAt, stored ? completedAt : undefined);
  }
});

test("direct completion and heartbeat beat recent status mtime", (t) => {
  const root = isolatedRoot(t);
  const now = Date.now();
  const completedAt = now - OLD_MS;
  const stored = endedDirect(root, "stored");
  patchDirect(stored, { completedAt, heartbeatAt: now });
  const heartbeat = endedDirect(root, "heartbeat");
  patchDirect(heartbeat, { heartbeatAt: completedAt });
  const report = pruneRuns({ root, olderThanMs: 7 * 86_400_000, dryRun: true, now, snapshot: emptySnapshot });
  assert.deepEqual(report.decisions, [heartbeat, stored].map((dir) => ({ kind: "delete", dir, ageMs: OLD_MS })));
});

test("runs without positive stored times retain the status and state mtime fallbacks", (t) => {
  const root = isolatedRoot(t);
  const managed = endedManaged(root, "managed-status");
  managed.commit({ ...managed.state(), heartbeatAt: 0 });
  stamp(managed.file("status"), Date.now() - OLD_MS);
  const missing = endedManaged(root, "managed-state");
  missing.commit({ ...missing.state(), heartbeatAt: 0 });
  fs.rmSync(missing.file("status"));
  stamp(missing.file("state.json"), Date.now() - OLD_MS);
  const absent = endedDirect(root, "direct-absent");
  oldEnough(absent);
  const meta = readDirect(absent);
  const { heartbeatAt, ...withoutHeartbeat } = meta;
  fs.writeFileSync(path.join(absent, "run.json"), JSON.stringify(withoutHeartbeat));
  const zero = endedDirect(root, "direct-zero");
  oldEnough(zero);
  patchDirect(zero, { heartbeatAt: 0 });
  const negative = endedDirect(root, "direct-negative");
  oldEnough(negative);
  patchDirect(negative, { heartbeatAt: -1 });
  const report = pruneRuns({ root, olderThanMs: 7 * 86_400_000, dryRun: true, now: Date.now(), snapshot: emptySnapshot });
  assert.equal(report.decisions.length, 5);
  assert.ok(report.decisions.every((d) => d.kind === "delete" && Math.abs(d.ageMs - OLD_MS) < 1_000));
});

test("future stored completion and heartbeat times cannot fall back to old mtimes", (t) => {
  const root = isolatedRoot(t);
  const now = Date.now();
  for (const stored of [true, false]) {
    const run = endedManaged(root, `managed-${stored}`);
    oldEnough(run.dir);
    const state = run.state();
    if (state.phase.kind !== "ended") throw new Error("expected ended");
    run.commit({ ...state, heartbeatAt: stored ? now - OLD_MS : now + 1_001,
      phase: { ...state.phase, ...(stored ? { completedAt: now + 1_001 } : {}) } });
    stamp(run.file("status"), now - OLD_MS);
    const dir = endedDirect(root, `direct-${stored}`);
    oldEnough(dir);
    patchDirect(dir, stored ? { completedAt: now + 1_001 } : { heartbeatAt: now + 1_001 });
  }
  const report = pruneRuns({ root, olderThanMs: 7 * 86_400_000, dryRun: true, now, snapshot: emptySnapshot });
  assert.equal(report.kept, 4);
  assert.ok(report.decisions.every((d) => d.kind === "keep" && d.reason === "completion time is invalid"));
});

test("a numeric legacy cleanup count is historical, while ambiguity still keeps the run", (t) => {
  const root = isolatedRoot(t);
  for (const leftover of ["2", "?"]) {
    const dir = path.join(root, leftover === "2" ? "numeric" : "unknown");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "prompt.md"), "brief\n");
    fs.writeFileSync(path.join(dir, "status"), `[codex | ok | - | read leftover=${leftover} | session=- | out=${dir}]\n`);
    oldEnough(dir);
  }
  const report = pruneRuns({ root, olderThanMs: 7 * 86_400_000, dryRun: false, now: Date.now(), snapshot: emptySnapshot });
  assert.equal(report.deleted, 1);
  assert.deepEqual(report.decisions[1], { kind: "keep", dir: path.join(root, "unknown"), reason: "leftover processes" });
});

test("paths and worker group members keep finished managed and direct runs", (t) => {
  for (const direct of [true, false]) {
    const root = isolatedRoot(t);
    const dir = direct ? endedDirect(root, "run") : endedManaged(root, "run", { leftover: 2 }).dir;
    oldEnough(dir);
    const input = { root, olderThanMs: 7 * 86_400_000, dryRun: true, now: Date.now() };
    for (const held of [dir, path.join(dir, "stdout.raw")]) {
      const report = pruneRuns({ ...input, snapshot: () => ({ ...emptySnapshot(), paths: new Map([[41022, [held]]]) }) });
      assert.deepEqual(report.decisions, [{ kind: "keep", dir, reason: "process 41022 is using the run" }]);
    }
    if (direct) patchDirect(dir, { workerPgid: 27288, workerStart: "Thu Jan  1 00:00:00 2026" });
    else {
      const file = path.join(dir, "state.json");
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), workerPgid: 27288,
        workerStart: "Thu Jan  1 00:00:00 2026" }));
    }
    const report = pruneRuns({ ...input, snapshot: () => ({ ...emptySnapshot(), procs: new Map([[27300, { pid: 27300, pgid: 27288 }]]) }) });
    assert.deepEqual(report.decisions, [{ kind: "keep", dir, reason: "process 27300 is in the worker group" }]);
  }
});

test("run paths lsof may escape are kept, including special characters in a parent path", (t) => {
  for (const char of ["\t", "\n", "\x1f", "\x7f", "é", "\\"]) {
    const root = path.join(isolatedRoot(t), `root${char}`);
    fs.mkdirSync(root);
    const managed = endedManaged(root, "managed");
    const direct = endedDirect(root, "direct", { status: "[codex | ok | - | read | session=- | out=/run]\n" });
    oldEnough(managed.dir);
    oldEnough(direct);
    for (const dryRun of [true, false]) {
      const report = pruneRuns({ root, olderThanMs: 7 * 86_400_000, dryRun, now: Date.now(), snapshot: emptySnapshot });
      assert.deepEqual(report.decisions, [direct, managed.dir].map((dir) => ({ kind: "keep", dir, reason: "run path cannot be matched against lsof" })));
      assert.equal(report.deleted, 0);
      assert.equal(fs.existsSync(managed.dir), true);
      assert.equal(fs.existsSync(direct), true);
    }
  }
});

test("printable ASCII run paths remain eligible through a root alias", (t) => {
  const root = isolatedRoot(t);
  const run = endedManaged(root, "run space~");
  oldEnough(run.dir);
  const alias = path.join(isolatedRoot(t), "alias");
  fs.symlinkSync(root, alias);
  assert.equal(prune(alias).deleted, 1);
});

test("prune takes one preview snapshot and refreshes each candidate under its locks", (t) => {
  const root = isolatedRoot(t);
  const a = protocolSource(root, "a").run;
  const b = endedDirect(root, "b");
  initScratchSource(b);
  oldEnough(a.dir);
  oldEnough(b);
  let scans = 0;
  const input = { root, olderThanMs: 7 * 86_400_000, now: Date.now() };
  const before = fs.readdirSync(a.dir).map((name) => [name, fs.statSync(a.file(name)).mtimeMs]);
  const preview = pruneRuns({ ...input, dryRun: true, snapshot: () => { scans += 1; return emptySnapshot(); } });
  assert.equal(scans, 1);
  assert.equal(preview.decisions.filter((d) => d.kind === "delete").length, 2);
  assert.deepEqual(fs.readdirSync(a.dir).map((name) => [name, fs.statSync(a.file(name)).mtimeMs]), before);
  scans = 0;
  const applied = pruneRuns({ ...input, dryRun: false, snapshot: () => {
    scans += 1;
    if (scans === 1) {
      for (const dir of [a.dir, b]) {
        assert.equal(fs.existsSync(path.join(dir, "owner.lock")), false);
        assert.equal(fs.existsSync(path.join(dir, "workspace-pins", "owner.lock")), false);
      }
      return emptySnapshot();
    }
    const dir = scans === 2 ? a.dir : b;
    assert.equal(ownerLock(dir).holder()?.pid, process.pid);
    assert.equal(ownerLock(path.join(dir, "workspace-pins")).holder()?.pid, process.pid);
    if (scans === 2) return emptySnapshot();
    assert.equal(fs.existsSync(a.dir), false);
    return { ...emptySnapshot(), paths: new Map([[41022, [path.join(b, "log")]]]) };
  } });
  assert.equal(scans, 3);
  assert.equal(applied.deleted, 1);
  assert.deepEqual(applied.decisions[1], { kind: "keep", dir: b, reason: "process 41022 is using the run" });
  assert.equal(fs.existsSync(a.dir), false);
  assert.equal(fs.existsSync(b), true);
  assert.equal(fs.existsSync(path.join(b, "owner.lock")), false);
  assert.equal(fs.existsSync(path.join(b, "workspace-pins", "owner.lock")), false);
});

test("dependent pin release refreshes each candidate under the source pin lock", (t) => {
  const root = isolatedRoot(t);
  const source = protocolSource(root, "source");
  tooNew(source.run.dir);
  const a = endedManaged(root, "a", { workspaceSource: source.workspace });
  const b = endedDirect(root, "b", { workspaceSource: source.workspace });
  const pins = path.join(source.run.dir, "workspace-pins");
  const aNonce = a.spec.nonce ?? newNonce();
  const bNonce = readDirect(b).nonce;
  for (const [dir, nonce] of [[a.dir, aNonce], [b, bNonce]]) {
    oldEnough(dir);
    assert.equal(admitResume({ sourceWorkspace: source.workspace, dependent: { dir, nonce }, writeDependent: () => {} }).kind, "pinned");
  }
  let scans = 0;
  const applied = pruneRuns({ root, olderThanMs: 7 * 86_400_000, dryRun: false, now: Date.now(), snapshot: () => {
    scans += 1;
    if (scans === 1) {
      assert.equal(fs.existsSync(path.join(pins, "owner.lock")), false);
      return emptySnapshot();
    }
    if (scans === 3) {
      assert.equal(ownerLock(a.dir).holder()?.pid, process.pid);
      assert.equal(fs.existsSync(path.join(pins, "owner.lock")), false);
      assert.equal(fs.existsSync(path.join(pins, aNonce)), false);
      return emptySnapshot();
    }
    assert.equal(ownerLock(pins).holder()?.pid, process.pid);
    const dir = scans === 2 ? a.dir : b;
    assert.equal(fs.existsSync(path.join(dir, "owner.lock")), false);
    if (scans === 2) return emptySnapshot();
    assert.equal(scans, 4);
    assert.equal(fs.existsSync(a.dir), false);
    return { ...emptySnapshot(), paths: new Map([[41022, [path.join(b, "log")]]]) };
  } });
  assert.equal(scans, 4);
  assert.equal(applied.deleted, 1);
  assert.deepEqual(decisionOf(applied, b), { kind: "keep", dir: b, reason: "process 41022 is using the run" });
  assert.equal(fs.existsSync(path.join(pins, aNonce)), false);
  assert.equal(fs.existsSync(path.join(pins, bNonce)), true);
  assert.equal(fs.existsSync(path.join(pins, "owner.lock")), false);
});

test("a failed preview or apply scan keeps finished runs and leaves dependent pins intact", (t) => {
  const root = isolatedRoot(t);
  const source = protocolSource(root, "source");
  const dep = endedManaged(root, "dependent", { workspaceSource: source.workspace });
  oldEnough(source.run.dir);
  oldEnough(dep.dir);
  const nonce = dep.spec.nonce ?? newNonce();
  assert.equal(admitResume({ sourceWorkspace: source.workspace, dependent: { dir: dep.dir, nonce }, writeDependent: () => {} }).kind, "pinned");
  const input = { root, olderThanMs: 7 * 86_400_000, now: Date.now() };
  const failed = { kind: "failed" as const, detail: "lsof is missing" };
  const preview = pruneRuns({ ...input, dryRun: true, snapshot: () => failed });
  assert.ok(preview.decisions.every((d) => d.kind === "keep" && d.reason === "process scan failed: lsof is missing"));
  let scans = 0;
  const applied = pruneRuns({ ...input, dryRun: false, snapshot: () => ++scans === 1 ? emptySnapshot() : failed });
  assert.equal(scans, 3);
  assert.equal(applied.deleted, 0);
  assert.ok(applied.decisions.every((d) => d.kind === "keep" && d.reason === "process scan failed: lsof is missing"));
  assert.equal(fs.existsSync(path.join(source.run.dir, "workspace-pins", nonce)), true);
});

test("a path occupant of an ended dependent keeps its source pinned", (t) => {
  const root = isolatedRoot(t);
  const custom = isolatedRoot(t);
  const source = protocolSource(root, "source");
  const dep = endedDirect(custom, "dependent", { workspaceSource: source.workspace });
  oldEnough(source.run.dir);
  oldEnough(dep);
  assert.equal(admitResume({ sourceWorkspace: source.workspace,
    dependent: { dir: dep, nonce: readDirect(dep).nonce }, writeDependent: () => {} }).kind, "pinned");
  const report = pruneRuns({ root, olderThanMs: 7 * 86_400_000, dryRun: false, now: Date.now(),
    snapshot: () => ({ ...emptySnapshot(), paths: new Map([[41022, [path.join(dep, "log")]]]) }) });
  assert.deepEqual(report.decisions, [{ kind: "keep", dir: source.run.dir, reason: "pin names a live run" }]);
});

test("a real sleep with cwd inside a run keeps it", async (t) => {
  if ((spawnSync("lsof", ["-v"], { stdio: "ignore" }).error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    t.skip("lsof is not on PATH");
    return;
  }
  const root = isolatedRoot(t);
  const run = endedManaged(root, "occupied", { leftover: 2 });
  oldEnough(run.dir);
  const child = spawn("sleep", ["60"], { cwd: run.dir, stdio: "ignore" });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  t.after(async () => { child.kill(); await closed; });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  const report = pruneRuns({ root, olderThanMs: 7 * 86_400_000, dryRun: false, now: Date.now() });
  assert.equal(report.deleted, 0);
  assert.equal(fs.existsSync(run.dir), true);
  assert.deepEqual(report.decisions, [{ kind: "keep", dir: run.dir, reason: `process ${child.pid} is using the run` }]);
});
