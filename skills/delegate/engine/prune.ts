import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDirectDir, readDirect, type DirectMeta } from "./direct.ts";
import { occupantOf, takeSnapshot, type LiveScan } from "./livescan.ts";
import { mayBeRunning } from "./procs.ts";
import { ownerLock, outRoot, readRun, runnerAlive, type Run } from "./run.ts";
import { CLIS, isLive } from "./state.ts";

export type PruneDecision =
  | { kind: "delete"; dir: string; ageMs: number }
  | { kind: "keep"; dir: string; reason: string };

export type PruneReport = {
  decisions: PruneDecision[];
  deleted: number;
  kept: number;
  failed: number;
};

export type AdmitResult =
  | { kind: "pinned" }
  | { kind: "legacy" }
  | { kind: "expired"; message: string }
  | { kind: "busy"; message: string };

export type PruneRoot =
  | { kind: "missing" }
  | { kind: "ready"; root: string }
  | { kind: "error"; message: string };

type Pin = { readonly out: string; readonly nonce: string };

const PINS_NAME = "workspace-pins";
const PIN_NAME = /^[0-9a-f]+$/;
const SCRATCH_NAME = /^workspace(-[0-9a-f]+)?$/;
const IDENTITY_FILES = ["spec.json", "state.json", "run.json", "status", "prompt.md", "runner.pid"] as const;
const TERMINAL_STATUS = new Set(["ok", "partial", "fail"]);
const LIVE_STATUS = new Set(["starting", "running", "waiting"]);
const STATUS_CLIS = new Set<string>([...CLIS, "codex", "cursor"]);
const EXPIRED = (workspace: string) => `session workspace expired: ${workspace}. Start a new run.`;
const BUSY = "cannot pin the session workspace because another prune or resume holds it";

export function resolvePruneRoot(root = outRoot()): PruneRoot {
  let real: string;
  try {
    real = fs.realpathSync.native(root);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    const code = (e as NodeJS.ErrnoException).code ?? (e as Error).message;
    return { kind: "error", message: `cannot read the run root ${root}: ${code}` };
  }
  if (lkind(real) !== "dir") return { kind: "error", message: `run root is not a directory: ${root}` };
  try {
    fs.readdirSync(real);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? (e as Error).message;
    return { kind: "error", message: `cannot read the run root ${root}: ${code}` };
  }
  return { kind: "ready", root: real };
}

export function pruneRuns(input: {
  root: string;
  olderThanMs: number;
  dryRun: boolean;
  now: number;
  snapshot?: () => LiveScan;
}): PruneReport {
  const cutoff = input.now - input.olderThanMs;
  const snapshot = input.snapshot ?? takeSnapshot;
  const scanned = scan(input.root, cutoff, input.now, snapshot());
  const kept = scanned.filter((d) => d.kind === "keep").length;
  if (input.dryRun) {
    return { decisions: scanned, deleted: 0, kept, failed: 0 };
  }
  const decisions: PruneDecision[] = [];
  let deleted = 0;
  let keptApply = 0;
  let failed = 0;
  for (const first of scanned) {
    if (first.kind === "keep") {
      decisions.push(first);
      keptApply += 1;
      continue;
    }
    const applied = apply(input.root, first.dir, cutoff, input.now, snapshot);
    decisions.push(applied);
    if (applied.kind === "delete") deleted += 1;
    else if (applied.reason === "remove failed") failed += 1;
    else keptApply += 1;
  }
  decisions.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  return { decisions, deleted, kept: keptApply, failed };
}

export function initScratchSource(runDir: string): void {
  fs.mkdirSync(path.join(runDir, PINS_NAME), { recursive: true });
}

export function scratchWorkspace(runDir: string, nonce: string): string {
  return path.join(runDir, `workspace-${nonce}`);
}

export function admitResume(input: {
  sourceWorkspace: string;
  dependent: { dir: string; nonce: string };
  writeDependent: () => void;
  stillValid?: () => boolean;
}): AdmitResult {
  if (!realDir(input.sourceWorkspace)) return { kind: "expired", message: EXPIRED(input.sourceWorkspace) };
  const pins = pinsBeside(input.sourceWorkspace);
  const pinsKind = lkind(pins);
  if (pinsKind === "missing") {
    return path.basename(input.sourceWorkspace) === "workspace"
      ? { kind: "legacy" }
      : { kind: "expired", message: EXPIRED(input.sourceWorkspace) };
  }
  if (pinsKind !== "dir") return { kind: "expired", message: EXPIRED(input.sourceWorkspace) };
  // Resume and prune serialize here so a pin cannot appear after the last check
  const lock = ownerLock(pins);
  if (!takeLock(lock)) return { kind: "busy", message: BUSY };
  try {
    if (!realDir(input.sourceWorkspace) || lkind(pins) !== "dir") {
      return { kind: "expired", message: EXPIRED(input.sourceWorkspace) };
    }
    if (!protocolWorkspace(input.sourceWorkspace)) {
      return { kind: "expired", message: EXPIRED(input.sourceWorkspace) };
    }
    if (input.stillValid && !input.stillValid()) return { kind: "expired", message: EXPIRED(input.sourceWorkspace) };
    input.writeDependent();
    writePin(pins, { out: input.dependent.dir, nonce: input.dependent.nonce });
    return { kind: "pinned" };
  } finally {
    lock.unlock();
  }
}

function scan(root: string, cutoff: number, now: number, snap: LiveScan): PruneDecision[] {
  const decisions: PruneDecision[] = [];
  for (const dir of children(root)) {
    const kind = lkind(dir);
    if (kind === "symlink") {
      decisions.push({ kind: "keep", dir, reason: "symlink" });
      continue;
    }
    if (kind !== "dir") continue;
    if (path.basename(dir).startsWith(".prune-")) {
      decisions.push({ kind: "keep", dir, reason: "needs manual cleanup" });
      continue;
    }
    decisions.push(classify(dir, cutoff, now, false, snap));
  }
  decisions.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  return decisions;
}

function apply(root: string, dir: string, cutoff: number, now: number, snapshot: () => LiveScan): PruneDecision {
  if (path.basename(dir).startsWith(".prune-")) return { kind: "keep", dir, reason: "needs manual cleanup" };
  if (whySymlinkMeta(dir) !== undefined) return { kind: "keep", dir, reason: "symlink metadata" };
  if (!realDir(dir)) return { kind: "keep", dir, reason: "directory is gone or changed" };
  const source = sourceWorkspaceOf(dir);
  if (source !== undefined && pinsBeside(source) !== runPins(dir)) {
    const released = releaseDependentPin(source, dir, snapshot);
    if (released !== undefined) return released;
  }
  const pins = runPins(dir);
  const pinsKind = lkind(pins);
  if (pinsKind !== "missing" && pinsKind !== "dir") return { kind: "keep", dir, reason: "pin is unreadable" };
  const pinLock = pinsKind === "dir" ? ownerLock(pins) : undefined;
  if (pinLock !== undefined && !takeLock(pinLock)) {
    return { kind: "keep", dir, reason: "cannot lock workspace-pins" };
  }
  const runLock = ownerLock(dir);
  try {
    if (!takeLock(runLock)) {
      return { kind: "keep", dir, reason: whyLock(dir, false) ?? "owner.lock is held" };
    }
    try {
      return finish(root, dir, cutoff, now, snapshot);
    } finally {
      runLock.unlock();
    }
  } finally {
    pinLock?.unlock();
  }
}

function finish(root: string, dir: string, cutoff: number, now: number, snapshot: () => LiveScan): PruneDecision {
  if (!realDir(dir)) return { kind: "keep", dir, reason: "directory is gone or changed" };
  const decision = classify(dir, cutoff, now, true, snapshot());
  if (decision.kind === "keep") return decision;
  const tombstone = tombstonePath(root, dir);
  try {
    fs.renameSync(dir, tombstone);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "keep", dir, reason: "directory is gone" };
    return { kind: "keep", dir, reason: "remove failed" };
  }
  try {
    fs.rmSync(tombstone, { recursive: true, force: true });
  } catch {
    return { kind: "keep", dir: tombstone, reason: "remove failed" };
  }
  if (exists(tombstone)) return { kind: "keep", dir: tombstone, reason: "remove failed" };
  return { kind: "delete", dir, ageMs: decision.ageMs };
}

function tombstonePath(root: string, dir: string): string {
  return path.join(root, `.prune-${path.basename(dir)}-${process.pid}-${randomBytes(4).toString("hex")}`);
}

function releaseDependentPin(sourceWorkspace: string, dependent: string, snapshot: () => LiveScan): PruneDecision | undefined {
  const pins = pinsBeside(sourceWorkspace);
  if (!realDir(pins)) return undefined;
  const lock = ownerLock(pins);
  if (!takeLock(lock)) return { kind: "keep", dir: dependent, reason: "cannot lock workspace-pins" };
  try {
    const block = whyNotInactive(dependent, false, snapshot());
    if (block !== undefined) return { kind: "keep", dir: dependent, reason: block };
    const nonce = nonceOf(dependent);
    if (nonce !== undefined) fs.rmSync(path.join(pins, nonce), { force: true });
    return undefined;
  } finally {
    lock.unlock();
  }
}

function classify(dir: string, cutoff: number, now: number, ignoreOwnLock: boolean, snap: LiveScan): PruneDecision {
  const blocked = whyNotInactive(dir, ignoreOwnLock, snap) ?? whyNotOld(dir, cutoff, now) ?? whyPinned(dir, cutoff, now, snap);
  if (blocked !== undefined) return { kind: "keep", dir, reason: blocked };
  const completedAt = completionMs(dir);
  return { kind: "delete", dir, ageMs: now - (completedAt ?? cutoff) };
}

function whyNotInactive(dir: string, ignoreOwnLock: boolean, snap: LiveScan): string | undefined {
  const linked = whySymlinkMeta(dir);
  if (linked !== undefined) return linked;
  const spec = lkind(path.join(dir, "spec.json"));
  const run = lkind(path.join(dir, "run.json"));
  if (spec === "file" && run === "file") return "malformed identity";
  if (spec === "file") return whyNotInactiveManaged(dir, ignoreOwnLock, snap);
  if (run === "file") return whyNotInactiveDirect(dir, ignoreOwnLock, snap);
  if (lkind(path.join(dir, "prompt.md")) === "file") return whyNotInactiveLegacy(dir, ignoreOwnLock, snap);
  return "unreadable identity";
}

function whySymlinkMeta(dir: string): string | undefined {
  for (const name of IDENTITY_FILES) {
    if (lkind(path.join(dir, name)) === "symlink") return "symlink metadata";
  }
  return undefined;
}

function whyNotInactiveManaged(dir: string, ignoreOwnLock: boolean, snap: LiveScan): string | undefined {
  const read = readRun(dir);
  if (read.kind === "unreadable") return "unreadable identity";
  if (read.kind === "older-format") return "malformed identity";
  const { run, state } = read;
  const lock = whyLock(dir, ignoreOwnLock);
  if (lock !== undefined) return lock;
  if (isLive(state.phase)) return "not completed";
  const occupied = whyOccupied(dir, state.workerPgid, snap);
  if (occupied !== undefined) return occupied;
  const worker = whyWorker(state.workerPgid, state.workerStart);
  if (worker !== undefined) return worker;
  return whyLegacyScratch(run);
}

function whyNotInactiveDirect(dir: string, ignoreOwnLock: boolean, snap: LiveScan): string | undefined {
  if (!isDirectDir(dir)) return "malformed identity";
  let meta: DirectMeta;
  try {
    meta = readDirect(dir);
  } catch {
    return "unreadable identity";
  }
  const lock = whyLock(dir, ignoreOwnLock);
  if (lock !== undefined) return lock;
  const ended = whyNotEnded(dir);
  if (ended !== undefined) return ended;
  const occupied = whyOccupied(dir, meta.workerPgid, snap);
  if (occupied !== undefined) return occupied;
  const worker = whyWorker(meta.workerPgid, meta.workerStart);
  if (worker !== undefined) return worker;
  return whyDirectScratch(dir, meta);
}

function whyNotInactiveLegacy(dir: string, ignoreOwnLock: boolean, snap: LiveScan): string | undefined {
  const lock = whyLock(dir, ignoreOwnLock);
  if (lock !== undefined) return lock;
  const runner = runnerAlive(dir);
  if (runner === true) return "runner.pid may still be live";
  if (hasScratchShape(dir)) return "legacy workspace has no pin protocol";
  const ended = whyNotEnded(dir);
  if (ended !== undefined) return ended;
  if (runner !== false && readTerminalStatus(dir) === "missing") return "not completed";
  return whyOccupied(dir, undefined, snap);
}

function whyNotEnded(dir: string): string | undefined {
  const parsed = readTerminalStatus(dir);
  if (parsed === "missing" || parsed === "live") return "not completed";
  if (parsed === "malformed") return "malformed identity";
  if (parsed.uncertain) return "cleanup is uncertain";
  if (parsed.leftover === "?") return "leftover processes";
  return undefined;
}

function whyLock(dir: string, ignoreOwnLock: boolean): string | undefined {
  const file = path.join(dir, "owner.lock");
  const kind = lkind(file);
  if (kind === "missing") return undefined;
  if (kind !== "file") return "owner.lock cannot be read";
  if (ignoreOwnLock) return undefined;
  const holder = ownerLock(dir).holder();
  if (!holder) return "owner.lock cannot be read";
  if (mayBeRunning(holder.pid, holder.start, holder.legacy)) return "owner.lock is held";
  return undefined;
}

function whyWorker(pgid: number | undefined, start: string | undefined): string | undefined {
  if (pgid === undefined) return undefined;
  if (start === undefined) return "worker identity is unknown";
  if (mayBeRunning(pgid, start, false)) return "worker may still be running";
  return undefined;
}

function whyLegacyScratch(run: Run): string | undefined {
  if (!hasScratchShape(run.dir)) return undefined;
  const pins = runPins(run.dir);
  const kind = lkind(pins);
  if (kind === "missing") return "legacy workspace has no pin protocol";
  if (kind !== "dir") return "pin is unreadable";
  return undefined;
}

function whyDirectScratch(dir: string, meta: DirectMeta): string | undefined {
  if (meta.mode !== "read" || !hasScratchShape(dir)) return undefined;
  const pins = runPins(dir);
  const kind = lkind(pins);
  if (kind === "missing") return "legacy workspace has no pin protocol";
  if (kind !== "dir") return "pin is unreadable";
  return undefined;
}

function whyNotOld(dir: string, cutoff: number, now: number): string | undefined {
  const completedAt = completionMs(dir);
  if (completedAt === null) return "completion time is missing";
  if (!Number.isFinite(completedAt) || completedAt > now + 1_000) return "completion time is invalid";
  if (completedAt >= cutoff) return "not older than cutoff";
  return undefined;
}

function whyPinned(dir: string, cutoff: number, now: number, snap: LiveScan): string | undefined {
  const pins = runPins(dir);
  const kind = lkind(pins);
  if (kind === "missing") return undefined;
  if (kind !== "dir") return "pin is unreadable";
  let names: string[];
  try {
    names = fs.readdirSync(pins);
  } catch {
    return "pin is unreadable";
  }
  for (const name of names) {
    if (name === "owner.lock" || name.startsWith("owner.lock.") || name.startsWith(".tmp-")) continue;
    if (!PIN_NAME.test(name)) return "pin is unreadable";
    const file = path.join(pins, name);
    if (lkind(file) !== "file") return "pin is unreadable";
    const pin = readPin(file);
    if (pin === null || pin.nonce !== name) return "pin is unreadable";
    if (lkind(pin.out) === "missing") return "pin target is missing";
    if (lkind(pin.out) !== "dir") return "pin is unreadable";
    if (nonceOf(pin.out) !== pin.nonce) return "pin nonce does not match";
    const live = whyNotInactive(pin.out, false, snap);
    if (live === "unreadable identity" || live === "malformed identity") return "pin is unreadable";
    if (live !== undefined && live !== "legacy workspace has no pin protocol") return "pin names a live run";
    const age = whyNotOld(pin.out, cutoff, now);
    if (age !== undefined) return `pin target: ${age}`;
  }
  return undefined;
}

function whyOccupied(dir: string, workerPgid: number | undefined, snap: LiveScan): string | undefined {
  if (snap.kind === "failed") return `process scan failed: ${snap.detail}`;
  let real: string;
  try {
    real = fs.realpathSync.native(dir);
  } catch {
    return "directory is gone or changed";
  }
  if (/[^\x20-\x7e]|\\/.test(real)) return "run path cannot be matched against lsof";
  const occupant = occupantOf(snap, { dir: real, workerPgid });
  if (occupant === null) return undefined;
  return occupant.kind === "path"
    ? `process ${occupant.pid} is using the run`
    : `process ${occupant.pid} is in the worker group`;
}

function completionMs(dir: string): number | null {
  const read = readRun(dir);
  if (read.kind === "ok" && read.state.phase.kind === "ended") {
    if (read.state.phase.completedAt !== undefined) return read.state.phase.completedAt;
    if (read.state.heartbeatAt > 0) return read.state.heartbeatAt;
    return readStatusMtime(dir) ?? mtimeMs(path.join(dir, "state.json"));
  }
  if (isDirectDir(dir)) {
    let meta: DirectMeta;
    try {
      meta = readDirect(dir);
    } catch {
      return null;
    }
    if (meta.completedAt !== undefined) return meta.completedAt;
    if (meta.heartbeatAt !== undefined && meta.heartbeatAt > 0) return meta.heartbeatAt;
  }
  const parsed = readTerminalStatus(dir);
  return typeof parsed === "object" ? readStatusMtime(dir) : null;
}

function readTerminalStatus(dir: string): { leftover: number | "?"; uncertain: boolean } | "missing" | "live" | "malformed" {
  const file = path.join(dir, "status");
  const kind = lkind(file);
  if (kind === "missing") return "missing";
  if (kind !== "file") return "malformed";
  let body: string;
  try {
    body = fs.readFileSync(file, "utf8");
  } catch {
    return "malformed";
  }
  const line = (body.split("\n")[0] ?? "").trim();
  if (!line) return "missing";
  const parsed = parseStatusLine(line);
  if (parsed === null) return "malformed";
  if (LIVE_STATUS.has(parsed.status)) return "live";
  if (!TERMINAL_STATUS.has(parsed.status)) return "malformed";
  const leftoverTokens = [...parsed.detail.matchAll(/(?:^|\s)leftover=(\S*)/g)];
  if (leftoverTokens.length > 1) return "malformed";
  const leftoverToken = leftoverTokens[0]?.[1];
  if (leftoverToken !== undefined && !/^(\?|\d+)$/.test(leftoverToken)) return "malformed";
  const leftover: number | "?" = leftoverToken === undefined ? 0 : leftoverToken === "?" ? "?" : Number(leftoverToken);
  if (leftover !== "?" && !Number.isSafeInteger(leftover)) return "malformed";
  return { leftover, uncertain: /(?:^|\s)cleanup uncertain(?::|\s|$)/.test(parsed.detail) };
}

function parseStatusLine(line: string): { status: string; detail: string } | null {
  if (!line.startsWith("[") || !line.endsWith("]")) return null;
  const parts = line.slice(1, -1).split(" | ");
  if (parts.length < 6) return null;
  if (!STATUS_CLIS.has(parts[0] ?? "")) return null;
  const status = parts[1];
  const session = parts[parts.length - 2];
  const out = parts[parts.length - 1];
  if (status === undefined || !session?.startsWith("session=") || !out?.startsWith("out=")) return null;
  return { status, detail: parts.slice(3, -2).join(" | ") };
}

function readStatusMtime(dir: string): number | null {
  const file = path.join(dir, "status");
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile()) return null;
    const body = fs.readFileSync(file, "utf8").trim();
    if (!body) return null;
    return st.mtimeMs;
  } catch {
    return null;
  }
}

function sourceWorkspaceOf(dir: string): string | undefined {
  if (lkind(path.join(dir, "spec.json")) === "file") {
    const read = readRun(dir);
    if (read.kind === "ok") return read.run.spec.workspaceSource;
    return undefined;
  }
  if (lkind(path.join(dir, "run.json")) !== "file" || !isDirectDir(dir)) return undefined;
  try {
    return readDirect(dir).workspaceSource;
  } catch {
    return undefined;
  }
}

function nonceOf(dir: string): string | undefined {
  if (lkind(path.join(dir, "spec.json")) === "file") {
    const read = readRun(dir);
    return read.kind === "ok" ? read.run.spec.nonce : undefined;
  }
  if (lkind(path.join(dir, "run.json")) !== "file" || !isDirectDir(dir)) return undefined;
  try {
    return readDirect(dir).nonce;
  } catch {
    return undefined;
  }
}

function protocolWorkspace(workspace: string): boolean {
  if (!realDir(workspace)) return false;
  const source = path.dirname(workspace);
  const nonce = nonceOf(source);
  return nonce !== undefined && path.basename(workspace) === `workspace-${nonce}`;
}

function hasScratchShape(dir: string): boolean {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return true;
  }
  return names.some((name) => SCRATCH_NAME.test(name) && exists(path.join(dir, name)));
}

function children(root: string): string[] {
  return fs
    .readdirSync(root)
    .map((name) => path.join(root, name))
    .sort();
}

function runPins(dir: string): string {
  return path.join(dir, PINS_NAME);
}

function pinsBeside(workspace: string): string {
  return path.join(path.dirname(workspace), PINS_NAME);
}

function writePin(pins: string, pin: Pin): void {
  const body = `${JSON.stringify({ out: pin.out, nonce: pin.nonce })}\n`;
  const tmp = path.join(pins, `.tmp-${process.pid}-pin`);
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, path.join(pins, pin.nonce));
}

function readPin(file: string): Pin | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.out !== "string" || !path.isAbsolute(o.out)) return null;
  if (typeof o.nonce !== "string" || !PIN_NAME.test(o.nonce)) return null;
  return { out: o.out, nonce: o.nonce };
}

function takeLock(lock: ReturnType<typeof ownerLock>): boolean {
  try {
    return lock.takeover();
  } catch {
    return false;
  }
}

function lkind(p: string): "dir" | "file" | "symlink" | "other" | "missing" {
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return "symlink";
    if (st.isDirectory()) return "dir";
    if (st.isFile()) return "file";
    return "other";
  } catch {
    return "missing";
  }
}

function realDir(p: string): boolean {
  return lkind(p) === "dir";
}

function exists(p: string): boolean {
  return lkind(p) !== "missing";
}

function mtimeMs(file: string): number | null {
  try {
    return fs.lstatSync(file).mtimeMs;
  } catch {
    return null;
  }
}
