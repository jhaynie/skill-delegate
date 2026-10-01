import fs from "node:fs";
import path from "node:path";
import { alive, killTree, mayBeRunning, sameProcess, sleep, startTime, tree } from "./procs.ts";
import { fsDenied, newNonce, outRoot, ownerLock, type OwnerLock } from "./run.ts";
import { clean, statusText, type RunNonce } from "./state.ts";
import { HOST_MARKERS } from "./workers.ts";

export type DirectProvider = "codex" | "cursor";
export type DirectMode = "read" | "write";
export const DIRECT_PROVIDERS = ["codex", "cursor"] as const;

export class DirectRunError extends Error {
  readonly dir: string;

  constructor(dir: string, cause: Error) {
    super(`cannot update run: ${cause.message}`, { cause });
    this.dir = dir;
  }
}

export const CODEX_RUN_FLAGS = {
  positional: 0,
  booleans: ["wait", "answer"],
  valued: ["cli", "cwd", "prompt-file", "mode", "model", "effort", "tier", "resume", "out"],
};

export const CODEX_FLAG_ORDER = [
  "cwd",
  "prompt-file",
  "mode",
  "model",
  "effort",
  "tier",
  "resume",
  "out",
  "answer",
  "cli",
  "wait",
] as const;

export const CURSOR_RUN_FLAGS = {
  positional: 0,
  booleans: ["full-access", "wait", "answer"],
  valued: ["cli", "cwd", "prompt-file", "mode", "model", "resume", "out"],
};

export const CURSOR_FLAG_ORDER = [
  "cwd",
  "prompt-file",
  "mode",
  "full-access",
  "model",
  "resume",
  "out",
  "answer",
  "cli",
  "wait",
] as const;

interface DirectWork {
  readonly out: string;
  readonly target: string;
  readonly gitRoot: string | null;
  readonly mode: DirectMode;
  readonly model: string;
  readonly executable: string;
  readonly resume?: string;
  readonly workspaceSource?: string;
}

export type DirectExecution =
  | (DirectWork & { readonly provider: "codex"; readonly effort: string; readonly tier?: string })
  | (DirectWork & { readonly provider: "cursor"; readonly fullAccess?: boolean });

export type CodexExecution = Extract<DirectExecution, { provider: "codex" }>;

// Group leader the owner records and later signals. start is that process's
// lstart, never a descendant's. null means identity is unknown and must not
// authorize a signal.
export interface DirectStart {
  readonly pid: number;
  readonly pgid: number;
  readonly start: string | null;
}

export type DirectCleanup = { readonly kind: "done"; readonly leftover: number } | { readonly kind: "uncertain"; readonly detail: string };

export type DirectEndedBy = "stop" | "forced" | "owner-died";

export interface DirectResult {
  readonly exitCode: number | null;
  readonly sessionId: string;
  readonly detail: string;
  readonly failed: boolean;
  readonly cleanup: DirectCleanup;
  readonly endedBy?: DirectEndedBy;
}

export type ExecuteDirect = (
  input: DirectExecution,
  signal: AbortSignal,
  onStarted: (start: DirectStart) => void,
) => Promise<DirectResult>;

interface DirectIdentityBase {
  readonly nonce: RunNonce;
  readonly target: string;
  readonly gitRoot: string | null;
  readonly model: string;
  readonly mode: DirectMode;
  readonly resume?: string;
  readonly workspaceSource?: string;
}

export type DirectIdentity =
  | (DirectIdentityBase & { readonly provider: "codex"; readonly effort: string; readonly tier?: string })
  | (DirectIdentityBase & { readonly provider: "cursor"; readonly fullAccess?: boolean });

interface DirectLive {
  readonly completedAt?: number;
  readonly startedAt?: number;
  readonly sessionId?: string;
  readonly workerPgid?: number;
  readonly workerStart?: string;
  readonly heartbeatAt?: number;
  readonly endedBy?: DirectEndedBy;
}

export type DirectMeta = DirectIdentity & DirectLive;

type DirectIdentityDraft =
  | (Omit<Extract<DirectIdentity, { provider: "codex" }>, "nonce"> & { nonce?: RunNonce })
  | (Omit<Extract<DirectIdentity, { provider: "cursor" }>, "nonce"> & { nonce?: RunNonce });

const HEARTBEAT_MS = 5_000;
const POLL_MS = 200;
const STALE_MS = 30_000;
const OWNER_DIED = "owner died";

export function isDirectDir(dir: string): boolean {
  return fs.existsSync(path.join(dir, "run.json")) && !fs.existsSync(path.join(dir, "spec.json"));
}

export function listDirectRuns(): string[] {
  const root = outRoot();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .map((name) => path.join(root, name))
    .filter((dir) => fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() && isDirectDir(dir))
    .sort();
}

export function resolveRunDir(ref: string): string | undefined {
  return [path.resolve(ref), path.join(outRoot(), ref)].find((d) =>
    ["spec.json", "run.json", "status", "prompt.md"].some((name) => fs.existsSync(path.join(d, name))),
  );
}

export function directEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (HOST_MARKERS.includes(name) || name === "DELEGATE_WORKER_PATH") continue;
    env[name] = value;
  }
  if (process.env.DELEGATE_WORKER_PATH !== undefined) env.PATH = process.env.DELEGATE_WORKER_PATH;
  return env;
}

export function createDirect<I extends DirectIdentityDraft>(dir: string, identity: I): I & { nonce: RunNonce } {
  const spec = { ...identity, nonce: identity.nonce ?? newNonce() };
  writeAtomic(path.join(dir, "run.json"), `${JSON.stringify(spec, null, 2)}\n`);
  return spec;
}

export function readDirect(dir: string): DirectMeta {
  return parseDirect(readJson(path.join(dir, "run.json")));
}

export function patchDirect(dir: string, patch: DirectLive): DirectMeta {
  const next = { ...readDirect(dir), ...patch };
  writeAtomic(path.join(dir, "run.json"), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function requestStop(dir: string, nonce: RunNonce): void {
  writeAtomic(path.join(dir, "stop.json"), `${JSON.stringify({ nonce })}\n`);
}

export function stopRequested(dir: string, nonce: RunNonce): boolean {
  let body: string;
  try {
    body = fs.readFileSync(path.join(dir, "stop.json"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
  try {
    const raw: unknown = JSON.parse(body);
    return typeof raw === "object" && raw !== null && "nonce" in raw && raw.nonce === nonce;
  } catch {
    return false;
  }
}

export function readDirectStatus(dir: string): string | null {
  const line = statusText((readIfPresent(path.join(dir, "status")) ?? "").split("\n")[0] ?? "").trim();
  return line || null;
}

export function writeDirectStatus(dir: string, line: string): void {
  if (!line.startsWith("[") || !line.endsWith("]")) throw new Error(`not a status line: ${line}`);
  const tmp = path.join(dir, `.tmp-${process.pid}-status`);
  try {
    fs.writeFileSync(tmp, `${line}\n`);
    fs.renameSync(tmp, path.join(dir, "status"));
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // tmp may sit in a directory that is now unwritable
    }
    process.stderr.write(`cannot write ${dir}/status\n`);
    throw e;
  }
}

export function directLiveLine(dir: string, meta: DirectMeta): string {
  const status = meta.startedAt === undefined ? "starting" : "running";
  return directLine(meta, dir, status, liveDetail(meta));
}

export function directFinalLine(dir: string, meta: DirectMeta, result: DirectResult): string {
  const failed = result.failed || result.cleanup.kind === "uncertain";
  return directLine(meta, dir, failed ? "fail" : "ok", `${result.detail}${cleanupDetail(result.cleanup)}`, result.sessionId);
}

export function cleanupDetail(cleanup: DirectCleanup): string {
  if (cleanup.kind === "uncertain") return ` cleanup uncertain: ${cleanup.detail}`;
  return cleanup.leftover ? ` leftover=${cleanup.leftover}` : "";
}

function liveDetail(meta: DirectMeta): string {
  switch (meta.provider) {
    case "codex": {
      const tier = meta.tier ? ` tier=${meta.tier}` : "";
      return `${meta.effort} ${meta.mode}${tier}`;
    }
    case "cursor":
      return meta.fullAccess ? `${meta.mode} full-access` : meta.mode;
  }
}

function directLine(meta: DirectMeta, dir: string, status: string, detail: string, sessionId = meta.sessionId ?? ""): string {
  return statusText(
    `[${meta.provider} | ${status} | ${meta.model} | ${clean(detail)} | session=${sessionId.trim() || "-"} | out=${dir}]`,
  );
}

export async function ownDirect(dir: string, executable: string, execute: ExecuteDirect): Promise<never> {
  const lock = ownerLock(dir);
  if (!lock.takeover(process.ppid)) process.exit(1);
  const meta = readDirect(dir);
  const ac = new AbortController();
  const beat = () => {
    if (stopRequested(dir, meta.nonce)) ac.abort();
    try {
      patchDirect(dir, { heartbeatAt: Date.now() });
    } catch {
      // a read-only --out still has to honor stop
    }
  };
  beat();
  const heartbeat = setInterval(beat, HEARTBEAT_MS);
  let started: DirectStart | undefined;
  let result: DirectResult | undefined;
  try {
    result = await execute(directInput(dir, executable, meta), ac.signal, (start) => {
      started = start;
      patchDirect(dir, {
        startedAt: Date.now(),
        heartbeatAt: Date.now(),
        workerPgid: start.pgid,
        ...(start.start === null ? {} : { workerStart: start.start }),
      });
    });
    if (result.sessionId || result.endedBy) {
      patchDirect(dir, {
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        ...(result.endedBy === undefined ? {} : { endedBy: result.endedBy }),
      });
    }
  } catch (e) {
    const latest = readDirect(dir);
    const message = clean((e as Error).message || "worker failed");
    if (result === undefined) {
      result = {
        exitCode: 1,
        sessionId: latest.sessionId ?? "",
        detail: message,
        failed: true,
        cleanup: await stopRecordedWorker(started ?? recordedStart(latest), latest.provider),
      };
    } else {
      result = { ...result, failed: true, detail: `${result.detail} ${message}`.trim() };
    }
  }
  clearInterval(heartbeat);
  if (result === undefined) process.exit(1);
  const latest = readDirect(dir);
  try {
    if (latest.completedAt === undefined) patchDirect(dir, { completedAt: Date.now() });
    writeDirectStatus(dir, directFinalLine(dir, latest, result));
  } catch (e) {
    if (!fsDenied(e)) throw e;
  } finally {
    lock.unlock();
  }
  process.exit(result.failed || result.cleanup.kind === "uncertain" || readDirectStatus(dir) === null ? 1 : 0);
}

export async function waitDirectReady(dir: string, ms: number): Promise<"started" | "ended" | "timeout"> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (readDirectStatus(dir)) return "ended";
    try {
      if (readDirect(dir).startedAt !== undefined) return "started";
    } catch {
      // run.json not readable yet
    }
    await sleep(POLL_MS);
  }
  return "timeout";
}

export async function untilDirectEnded(dir: string, until: number): Promise<string | null> {
  for (;;) {
    await reconcileDirect(dir);
    const line = readDirectStatus(dir);
    if (line) return line;
    if (Date.now() >= until) return null;
    const lock = ownerLock(dir);
    const holder = lock.holder();
    const live = holder ? mayBeRunning(holder.pid, holder.start, holder.legacy) : fs.existsSync(path.join(dir, "owner.lock"));
    if (!live) return null;
    await sleep(1_000);
  }
}

export async function reconcileDirect(dir: string): Promise<void> {
  if (readDirectStatus(dir)) return;
  const lock = ownerLock(dir);
  const holder = lock.holder();
  if (holder && mayBeRunning(holder.pid, holder.start, holder.legacy)) return;
  if (holder === null && fs.existsSync(path.join(dir, "owner.lock"))) return;
  try {
    await reapDirect(dir, lock, OWNER_DIED);
  } catch (e) {
    if (!fsDenied(e)) throw e;
    throw new DirectRunError(dir, e);
  }
}

export async function forceDirectStop(dir: string, provider: DirectProvider): Promise<{ forced: boolean }> {
  const lock = ownerLock(dir);
  const holder = lock.holder();
  if (holder && sameProcess(holder.pid, holder.start)) {
    if (provider === "codex") {
      await killTree(holder.pid, tree(holder.pid, [holder.pid]));
    } else {
      try {
        process.kill(holder.pid, "SIGKILL");
      } catch {
        // already gone
      }
      const until = Date.now() + 3_000;
      while (alive(holder.pid) && Date.now() < until) await sleep(50);
    }
  }
  if (readDirectStatus(dir)) return { forced: false };
  try {
    const reaped = await reapDirect(dir, lock, "stop forced");
    return { forced: reaped };
  } catch (e) {
    if (!fsDenied(e)) throw e;
    throw new DirectRunError(dir, e);
  }
}

export function shouldKeepWaitingDirect(dir: string, now: number): boolean {
  if (readDirectStatus(dir)) return false;
  const lock = ownerLock(dir);
  const holder = lock.holder();
  if (holder && mayBeRunning(holder.pid, holder.start, holder.legacy)) {
    let beat = 0;
    try {
      beat = readDirect(dir).heartbeatAt ?? 0;
    } catch {
      beat = now;
    }
    return now - beat < STALE_MS;
  }
  if (holder === null && fs.existsSync(path.join(dir, "owner.lock"))) return true;
  return false;
}

async function reapDirect(dir: string, lock: OwnerLock, reason: string): Promise<boolean> {
  if (!lock.takeover()) return false;
  if (readDirectStatus(dir)) {
    lock.unlock();
    return false;
  }
  let meta: DirectMeta;
  try {
    meta = readDirect(dir);
  } catch {
    lock.unlock();
    return false;
  }
  const cleanup = await stopRecordedWorker(recordedStart(meta), meta.provider);
  const endedBy: DirectEndedBy = reason === "stop forced" ? "forced" : "owner-died";
  patchDirect(dir, { endedBy });
  const result: DirectResult = {
    exitCode: 1,
    sessionId: meta.sessionId ?? "",
    detail: `${liveDetail(meta)} ${reason}`,
    failed: true,
    cleanup,
    endedBy,
  };
  try {
    if (meta.completedAt === undefined) patchDirect(dir, { completedAt: Date.now() });
    writeDirectStatus(dir, directFinalLine(dir, meta, result));
  } catch (e) {
    if (!fsDenied(e)) throw e;
    throw new DirectRunError(dir, e);
  } finally {
    lock.unlock();
  }
  return readDirectStatus(dir) !== null;
}

export function directAnswerText(dir: string, failed: boolean): string {
  const answer = readIfPresent(path.join(dir, "answer.md")) ?? "";
  if (!failed || answer.trim()) return answer.trimEnd();
  return (readIfPresent(path.join(dir, "stderr.log")) ?? "").trimEnd().split("\n").slice(-20).join("\n");
}

export function readIfPresent(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

function writeAtomic(target: string, body: string): void {
  const tmp = path.join(path.dirname(target), `.tmp-${process.pid}-${path.basename(target)}`);
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, target);
}

function readJson(file: string): { file: string; value: unknown } {
  let body: string;
  try {
    body = fs.readFileSync(file, "utf8");
  } catch {
    throw new Error(`missing ${file}`);
  }
  try {
    return { file, value: JSON.parse(body) };
  } catch {
    throw new Error(`${file} is not JSON`);
  }
}

function parseDirect({ file, value }: { file: string; value: unknown }): DirectMeta {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${file}: top level is not an object`);
  const o = value as Record<string, unknown>;
  const fail = (key: string): never => {
    throw new Error(`${file}: bad ${key}`);
  };
  const is = <T>(key: string, ok: (v: unknown) => v is T): T => (ok(o[key]) ? (o[key] as T) : fail(key));
  const maybe = <T>(key: string, ok: (v: unknown) => v is T): T | undefined => (o[key] === undefined ? undefined : is(key, ok));
  const isStr = (v: unknown): v is string => typeof v === "string";
  const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const isBool = (v: unknown): v is boolean => typeof v === "boolean";
  const isPid = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 1;
  const nonce = is("nonce", isStr) as RunNonce;
  const provider = is("provider", (v: unknown): v is DirectProvider => v === "codex" || v === "cursor");
  const gitRoot = o.gitRoot === null ? null : is("gitRoot", isStr);
  const resume = maybe("resume", isStr);
  const workspaceSource = maybe("workspaceSource", isStr);
  const startedAt = maybe("startedAt", isNum);
  const sessionId = maybe("sessionId", isStr);
  const workerPgid = maybe("workerPgid", isPid);
  const workerStart = maybe("workerStart", isStr);
  const heartbeatAt = maybe("heartbeatAt", isNum);
  const completedAt = maybe("completedAt", (v): v is number => isNum(v) && v > 0);
  const endedBy = maybe("endedBy", (v: unknown): v is DirectEndedBy => v === "stop" || v === "forced" || v === "owner-died");
  const live: DirectLive = {
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(workerPgid === undefined ? {} : { workerPgid }),
    ...(workerStart === undefined ? {} : { workerStart }),
    ...(heartbeatAt === undefined ? {} : { heartbeatAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(endedBy === undefined ? {} : { endedBy }),
  };
  const shared = {
    nonce,
    target: is("target", isStr),
    gitRoot,
    model: is("model", isStr),
    mode: is("mode", (v: unknown): v is DirectMode => v === "read" || v === "write"),
    ...(resume === undefined ? {} : { resume }),
    ...(workspaceSource === undefined ? {} : { workspaceSource }),
    ...live,
  };
  if (provider === "codex") {
    if (o.fullAccess !== undefined) fail("fullAccess");
    const tier = maybe("tier", isStr);
    return { ...shared, provider, effort: is("effort", isStr), ...(tier === undefined ? {} : { tier }) };
  }
  if (o.effort !== undefined) fail("effort");
  if (o.tier !== undefined) fail("tier");
  const fullAccess = maybe("fullAccess", isBool);
  return { ...shared, provider, ...(fullAccess === undefined ? {} : { fullAccess }) };
}

function directInput(dir: string, executable: string, meta: DirectMeta): DirectExecution {
  const work = {
    out: dir,
    target: meta.target,
    gitRoot: meta.gitRoot,
    mode: meta.mode,
    model: meta.model,
    executable,
    ...(meta.resume === undefined ? {} : { resume: meta.resume }),
    ...(meta.workspaceSource === undefined ? {} : { workspaceSource: meta.workspaceSource }),
  };
  if (meta.provider === "codex") {
    return { ...work, provider: "codex", effort: meta.effort, ...(meta.tier === undefined ? {} : { tier: meta.tier }) };
  }
  return { ...work, provider: "cursor", ...(meta.fullAccess === undefined ? {} : { fullAccess: meta.fullAccess }) };
}

function recordedStart(meta: DirectMeta): DirectStart | undefined {
  if (meta.workerPgid === undefined) return undefined;
  return { pid: meta.workerPgid, pgid: meta.workerPgid, start: meta.workerStart ?? null };
}

async function stopRecordedWorker(start: DirectStart | undefined, provider: DirectProvider): Promise<DirectCleanup> {
  if (start === undefined) return { kind: "uncertain", detail: "worker identity was not recorded" };
  if (start.start === null) return { kind: "uncertain", detail: "worker start time is unknown" };
  if (!alive(start.pgid)) return { kind: "uncertain", detail: "recorded worker is gone" };
  const now = startTime(start.pgid);
  if (now === null) return { kind: "uncertain", detail: "worker identity could not be confirmed" };
  if (now !== start.start) return { kind: "uncertain", detail: "recorded worker pid now names another process" };
  if (provider === "cursor") {
    try {
      process.kill(start.pgid, "SIGTERM");
    } catch {
      // already gone
    }
    const until = Date.now() + 3_000;
    while (alive(start.pgid) && Date.now() < until) await sleep(100);
    return { kind: "uncertain", detail: "the supervisor did not report cleanup" };
  }
  try {
    const leftover = await killTree(start.pgid, tree(start.pgid, [start.pgid]));
    return { kind: "done", leftover };
  } catch (e) {
    return { kind: "uncertain", detail: (e as Error).message };
  }
}
