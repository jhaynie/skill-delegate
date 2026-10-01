import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mayBeRunning, mayBeRunningSince, startTime } from "./procs.ts";
import {
  ACKS,
  CLIS,
  initialState,
  OPTION_KINDS,
  OUTCOMES,
  PRESETS,
  statusLine,
  TURN_ENDS,
  type Approval,
  type Dirty,
  type MsgId,
  type NewRunSpec,
  type ParentCommand,
  type Phase,
  type RunId,
  type RunNonce,
  type RunSpec,
  type RunState,
  type SessionId,
} from "./state.ts";

export interface Run extends OwnerLock {
  readonly dir: string;
  readonly spec: RunSpec;
  file(name: string): string;
  state(): RunState;
  commit(s: RunState): void;
  post(cmd: ParentCommand): void;
  claim(): ParentCommand[];
  reject(cmd: ParentCommand): void;
  event(e: Record<string, unknown>): void;
}

// owner.lock names the one process that may write the run. The run CLI
// takes it before it touches --out and hands it to the owner it starts.
export interface OwnerLock {
  lock(): boolean;
  holder(): Holder | null;
  // Takes the lock from a holder that is gone, or from parent, the run CLI
  // that started this owner
  takeover(parent?: number): boolean;
  unlock(): void;
}

// legacy marks a token from before start times were read in C and UTC
export interface Holder {
  pid: number;
  start: string;
  legacy: boolean;
}

const INBOX_NAME = /^(\d+)-(\d+)\.(queue|now|answer|stop)\.json$/;
const EVENTS_CAP_BYTES = 5_000_000;

export function outRoot(): string {
  const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return process.env.DELEGATE_OUT_ROOT || path.join(cache, "delegate");
}

export function newMsgId(): MsgId {
  return `${Date.now()}-${process.pid}` as MsgId;
}

export function newNonce(): RunNonce {
  return randomBytes(8).toString("hex") as RunNonce;
}

// A competing claimer can leave its exclusive-link temp during either
// occupancy check. Only regular lock files and that exact temp name are
// bookkeeping; every other entry belongs to a run.
const LOCK_ENTRY = /^(owner\.lock(\.[0-9a-f]{40}\.\d+)?|\.tmp-\d+-owner\.lock)$/;

export function holdsRun(dir: string): boolean {
  return fs.readdirSync(dir, { withFileTypes: true }).some((entry) => !(entry.isFile() && LOCK_ENTRY.test(entry.name)));
}

// Whether the runner named in runner.pid, "<pid> <start-epoch>", may still
// be running, or null when the runner wrote none. It follows owner.lock's
// rule, so only a gone pid or another start time ends it, and a file that
// cannot be read or parsed, or a start that is no whole epoch, counts as
// alive.
export function runnerAlive(dir: string): boolean | null {
  let body: string;
  try {
    body = fs.readFileSync(path.join(dir, "runner.pid"), "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : true;
  }
  const [pid = Number.NaN, start = Number.NaN] = body.trim().split(/\s+/).map(Number);
  if (!Number.isInteger(pid) || pid < 2) return true;
  return mayBeRunningSince(pid, Number.isSafeInteger(start) && start > 0 ? start : null);
}

// In a directory whose owner.lock the caller holds and that holds no run.
// state.json and spec.json are each written whole by rename.
export function createRun(spec: NewRunSpec, prompt: string): Run {
  const run = handle(spec.id, spec);
  run.commit(initialState(process.pid, Date.now()));
  const specTmp = run.file(`.tmp-${process.pid}-spec.json`);
  fs.writeFileSync(specTmp, `${JSON.stringify(spec, null, 2)}\n`);
  fs.renameSync(specTmp, run.file("spec.json"));
  for (const dir of ["inbox/claimed", "inbox/rejected", "turns"]) fs.mkdirSync(run.file(dir), { recursive: true });
  fs.writeFileSync(run.file("prompt.md"), prompt);
  return run;
}

// ref is a run directory, or its basename under the out root
export function openRun(ref: string): Run {
  const dir = [path.resolve(ref), path.join(outRoot(), ref)].find((d) => fs.existsSync(path.join(d, "spec.json")));
  if (!dir) throw new Error(`no run at ${ref}`);
  return handle(dir, parseSpec(readJson(path.join(dir, "spec.json"))));
}

export function listRuns(): string[] {
  const root = outRoot();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .map((name) => path.join(root, name))
    .filter((dir) => fs.existsSync(path.join(dir, "state.json")))
    .sort();
}

export type RunRead =
  | { kind: "ok"; run: Run; state: RunState }
  | { kind: "older-format"; dir: string }
  | { kind: "unreadable"; dir: string };
export type RunFileProblem = Exclude<RunRead["kind"], "ok">;

// A run directory whose spec.json and state.json both parse; a file that is
// missing or not JSON is unreadable, and one of the wrong shape is older
export function readRun(dir: string): RunRead {
  try {
    const run = handle(dir, parseSpec(readJson(path.join(dir, "spec.json"))));
    return { kind: "ok", run, state: run.state() };
  } catch (e) {
    if (!(e instanceof RunFileError)) throw e;
    return { kind: e.kind, dir };
  }
}

export function findRunBySession(sessionId: string): Run | null {
  for (const dir of listRuns()) {
    const read = readRun(dir);
    if (read.kind === "ok" && read.state.sessionId === sessionId) return read.run;
  }
  return null;
}

export function fsDenied(e: unknown): e is Error & { code: "EACCES" | "EPERM" } {
  return e instanceof Error && "code" in e && (e.code === "EACCES" || e.code === "EPERM");
}

export function ownerLock(dir: string): OwnerLock {
  const file = (name: string) => path.join(dir, name);
  const lockFile = file("owner.lock");
  // The body this handle wrote to owner.lock; unlock removes only that
  let token: string | null = null;
  // A lock or claim is linked from a full file, so none is ever seen half
  // written, and a write that fails publishes nothing
  const linked = <T>(body: string, publish: (tmp: string) => T): T => {
    const tmp = file(`.tmp-${process.pid}-owner.lock`);
    try {
      fs.writeFileSync(tmp, body);
      return publish(tmp);
    } finally {
      try {
        fs.rmSync(tmp, { force: true });
      } catch (e) {
        if (!fsDenied(e)) throw e;
      }
    }
  };
  const lock = (): boolean => {
    const body = newToken();
    const made = linked(body, (tmp) => {
      try {
        fs.linkSync(tmp, lockFile);
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw e;
      }
    });
    if (made) token = body;
    return made;
  };
  // The first free claim number, or null while a live reaper holds one
  const claimNext = (prefix: string, body: string): string | null =>
    linked(body, (tmp) => {
      for (let n = 0; ; n++) {
        const claim = file(`${prefix}${n}`);
        try {
          fs.linkSync(tmp, claim);
          return claim;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
          const other = readHolder(readLock(claim));
          if (!other || mayBeRunning(other.pid, other.start, other.legacy)) return null;
        }
      }
    });
  return {
    lock,
    holder: () => readHolder(readLock(lockFile)),
    // Only for a holder that is gone: its pid is dead or now names another
    // process. A lock that names no holder holds, like a live one. Reapers
    // that read the same dead lock race to create one claim file named for
    // it, and the exclusive create lets exactly one win. A
    // claim whose reaper died is never deleted, since a live one could have
    // replaced it; the next reaper claims the next number instead. The
    // winner checks the lock is still the one it read, then renames its
    // claim over it, so the lock is never missing, and clears the dead
    // claims. A later reaper finds a lock it did not read and backs off.
    takeover: (parent) => {
      const before = readLock(lockFile);
      if (before === null) return lock();
      const held = readHolder(before);
      if (!held || (held.pid !== parent && mayBeRunning(held.pid, held.start, held.legacy))) return false;
      const body = newToken();
      const prefix = `owner.lock.${createHash("sha1").update(before).digest("hex")}.`;
      const claim = claimNext(prefix, body);
      if (claim === null) return false;
      if (readLock(lockFile) !== before) {
        fs.rmSync(claim, { force: true });
        return false;
      }
      fs.renameSync(claim, lockFile);
      for (const name of fs.readdirSync(dir)) if (name.startsWith(prefix)) fs.rmSync(file(name), { force: true });
      if (readLock(lockFile) !== body) return false;
      token = body;
      return true;
    },
    unlock: () => {
      if (token !== null && readLock(lockFile) === token) {
        try {
          fs.rmSync(lockFile, { force: true });
        } catch (e) {
          if (!fsDenied(e)) throw e;
          process.stderr.write(`cannot remove ${lockFile}\n`);
        }
      }
      token = null;
    },
  };
}

function handle(dir: string, spec: RunSpec): Run {
  const file = (name: string) => path.join(dir, name);
  const inbox = file("inbox");
  const writeAtomic = (target: string, body: string) => {
    const tmp = path.join(path.dirname(target), `.tmp-${process.pid}-${path.basename(target)}`);
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, target);
  };
  return {
    dir,
    spec,
    file,
    state: () => parseState(readJson(file("state.json"))),
    // An ended run keeps its final line in status, the file a runner writes
    // too. status follows state.json, so it never announces a run whose state
    // is still live, and a reader restores one an owner died before writing.
    commit: (s) => {
      writeAtomic(file("state.json"), `${JSON.stringify(s)}\n`);
      if (s.phase.kind === "ended") writeAtomic(file("status"), `${statusLine(spec, s, Date.now())}\n`);
    },
    post: (cmd) => {
      const kind = cmd.kind === "send" ? (cmd.now ? "now" : "queue") : cmd.kind;
      writeAtomic(path.join(inbox, `${cmd.id}.${kind}.json`), JSON.stringify({ ...cmd, nonce: spec.nonce }));
    },
    claim: () => {
      const names = fs
        .readdirSync(inbox)
        .flatMap((name) => {
          const m = INBOX_NAME.exec(name);
          return m ? [{ name, ms: Number(m[1]), pid: Number(m[2]) }] : [];
        })
        .sort((a, b) => a.ms - b.ms || a.pid - b.pid);
      const claimed: ParentCommand[] = [];
      for (const { name } of names) {
        const taken = path.join(inbox, "claimed", name);
        // The rename is the claim, so each command is acted on at most once
        fs.renameSync(path.join(inbox, name), taken);
        const cmd = parseCommand(fs.readFileSync(taken, "utf8"), spec.nonce);
        if (cmd) claimed.push(cmd);
        else fs.renameSync(taken, path.join(inbox, "rejected", name));
      }
      return claimed;
    },
    reject: (cmd) => {
      for (const name of fs.readdirSync(path.join(inbox, "claimed"))) {
        if (name.startsWith(`${cmd.id}.`)) fs.renameSync(path.join(inbox, "claimed", name), path.join(inbox, "rejected", name));
      }
    },
    event: (e) => {
      const target = file("events.jsonl");
      if (fs.existsSync(target) && fs.statSync(target).size > EVENTS_CAP_BYTES) return;
      fs.appendFileSync(target, `${JSON.stringify({ t: Date.now(), ...e })}\n`);
    },
    ...ownerLock(dir),
  };
}

// A command posted through a handle on another run in this directory is not this run's
function parseCommand(body: string, nonce: RunNonce | undefined): ParentCommand | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || !("nonce" in raw) || raw.nonce !== nonce) return null;
  if (!("id" in raw) || typeof raw.id !== "string") return null;
  const id = raw.id as MsgId;
  if (!("kind" in raw)) return null;
  switch (raw.kind) {
    case "send":
      return "text" in raw && typeof raw.text === "string" && "now" in raw && typeof raw.now === "boolean"
        ? { id, kind: "send", text: raw.text, now: raw.now }
        : null;
    case "answer":
      return "approval" in raw &&
        typeof raw.approval === "string" &&
        "decision" in raw &&
        (raw.decision === "allow" || raw.decision === "deny" || raw.decision === "widen")
        ? { id, kind: "answer", approval: raw.approval, decision: raw.decision }
        : null;
    case "stop":
      return { id, kind: "stop" };
    default:
      return null;
  }
}

// pid, start time, a nonce, and "utc", which says the start is in C and UTC
function newToken(): string {
  return `${process.pid}\n${startTime(process.pid) ?? "-"}\n${randomBytes(8).toString("hex")}\nutc\n`;
}

function readLock(target: string): string | null {
  try {
    return fs.readFileSync(target, "utf8");
  } catch {
    return null;
  }
}

function readHolder(body: string | null): Holder | null {
  const [pidLine, start, , format] = (body ?? "").split("\n");
  const pid = Number(pidLine);
  return Number.isInteger(pid) && pid > 0 && start ? { pid, start, legacy: format !== "utc" } : null;
}

// A spec.json or state.json that does not parse; the CLI reports it as a usage error
export class RunFileError extends Error {
  readonly kind: RunFileProblem;
  constructor(kind: RunFileProblem, message: string) {
    super(message);
    this.kind = kind;
  }
}

type Json = Record<string, unknown>;

function readJson(file: string): { file: string; value: unknown } {
  let body: string;
  try {
    body = fs.readFileSync(file, "utf8");
  } catch {
    throw new RunFileError("unreadable", `missing ${file}`);
  }
  try {
    return { file, value: JSON.parse(body) };
  } catch {
    throw new RunFileError("unreadable", `${file} is not JSON`);
  }
}

// Field readers that name the file and field they reject
function reader(file: string, value: unknown, where = "") {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RunFileError("older-format", `${file}: ${where || "top level"} is not an object`);
  }
  const o = value as Json;
  const fail = (key: string): never => {
    throw new RunFileError("older-format", `${file}: bad ${where}${key}`);
  };
  const is = <T>(key: string, ok: (v: unknown) => v is T): T => (ok(o[key]) ? (o[key] as T) : fail(key));
  const maybe = <T>(key: string, ok: (v: unknown) => v is T): T | undefined => (o[key] === undefined ? undefined : is(key, ok));
  return { o, is, maybe, fail };
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isPid = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 1;
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const oneOf =
  <T extends string>(values: readonly T[]) =>
  (v: unknown): v is T =>
    values.some((x) => x === v);
const orNull =
  <T>(ok: (v: unknown) => v is T) =>
  (v: unknown): v is T | null =>
    v === null || ok(v);
const isStrs = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const isDirty = (v: unknown): v is Dirty => v === null || v === "?" || isCount(v);

function parseSpec({ file, value }: { file: string; value: unknown }): RunSpec {
  const { is, maybe } = reader(file, value);
  const resume = maybe("resume", isStr);
  const nonce = maybe("nonce", isStr);
  const workspaceSource = maybe("workspaceSource", isStr);
  return {
    id: is("id", isStr) as RunId,
    ...(nonce === undefined ? {} : { nonce: nonce as RunNonce }),
    cli: is("cli", oneOf(CLIS)),
    target: is("target", isStr),
    cwd: is("cwd", isStr),
    gitRoot: is("gitRoot", orNull(isStr)),
    preset: is("preset", oneOf(PRESETS)),
    model: is("model", isStr),
    effort: is("effort", isStr),
    deadlineAt: is("deadlineAt", isNum),
    sandbox: is("sandbox", orNull(isStr)),
    ...(resume === undefined ? {} : { resume: resume as SessionId }),
    ...(workspaceSource === undefined ? {} : { workspaceSource }),
  };
}

function parseState({ file, value }: { file: string; value: unknown }): RunState {
  const { is, maybe, fail } = reader(file, value);
  const record = <T>(key: string, ok: (v: unknown) => v is T): Record<MsgId, T> => {
    const { o } = reader(file, is(key, (v): v is Json => typeof v === "object" && v !== null), `${key}.`);
    if (!Object.values(o).every(ok)) fail(key);
    return o as Record<MsgId, T>;
  };
  const turns = is("turns", Array.isArray).map((t, i) => {
    const r = reader(file, t, `turns[${i}].`);
    const error = r.maybe("error", isStr);
    return {
      n: r.is("n", isCount),
      end: r.is("end", oneOf(TURN_ENDS)),
      tools: r.is("tools", isCount),
      text: r.is("text", isBool),
      ...(error === undefined ? {} : { error }),
    };
  });
  const workerPgid = maybe("workerPgid", isPid);
  const workerStart = maybe("workerStart", isStr);
  const sessionId = maybe("sessionId", isStr);
  return {
    supervisorPid: is("supervisorPid", isPid),
    ...(workerPgid === undefined ? {} : { workerPgid }),
    ...(workerStart === undefined ? {} : { workerStart }),
    ...(sessionId === undefined ? {} : { sessionId: sessionId as SessionId }),
    heartbeatAt: is("heartbeatAt", isNum),
    phase: parsePhase(file, is("phase", (v): v is unknown => v !== undefined)),
    queued: is("queued", isStrs) as MsgId[],
    acks: record("acks", oneOf(ACKS)),
    turns,
    asks: is("asks", isCount),
    waited: is("waited", isCount),
    denied: is("denied", isCount),
    widened: is("widened", isCount),
  };
}

function parsePhase(file: string, value: unknown): Phase {
  const { is, maybe } = reader(file, value, "phase.");
  const kind = is("kind", oneOf(["starting", "running", "waiting", "ended"] as const));
  switch (kind) {
    case "starting":
      return { kind };
    case "running":
      return { kind, turn: is("turn", isCount), tools: is("tools", isCount) };
    case "waiting":
      return { kind, turn: is("turn", isCount), tools: is("tools", isCount), approval: parseApproval(file, is("approval", (v): v is unknown => true)) };
    case "ended": {
      const completedAt = maybe("completedAt", (v): v is number => isNum(v) && v > 0);
      return {
        kind,
        outcome: is("outcome", oneOf(OUTCOMES)),
        reason: is("reason", isStr),
        leftover: is("leftover", isCount),
        dirty: is("dirty", isDirty),
        ...(completedAt === undefined ? {} : { completedAt }),
      };
    }
  }
}

function parseApproval(file: string, value: unknown): Approval {
  const { is, maybe } = reader(file, value, "phase.approval.");
  const toolCallId = maybe("toolCallId", isStr);
  const toolKind = maybe("toolKind", isStr);
  const command = maybe("command", isStr);
  const scope = maybe("scope", isStr);
  return {
    id: is("id", isStr),
    title: is("title", isStr),
    paths: is("paths", isStrs),
    options: is("options", Array.isArray).map((o, i) => {
      const r = reader(file, o, `phase.approval.options[${i}].`);
      return { id: r.is("id", isStr), kind: r.is("kind", oneOf(OPTION_KINDS)) };
    }),
    ...(toolCallId === undefined ? {} : { toolCallId }),
    ...(toolKind === undefined ? {} : { toolKind }),
    ...(command === undefined ? {} : { command }),
    ...(scope === undefined ? {} : { scope }),
  };
}
