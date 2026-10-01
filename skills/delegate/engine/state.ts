import path from "node:path";
import { pickOption } from "./policy.ts";

export type RunId = string & { readonly __brand: "RunId" };
export type SessionId = string & { readonly __brand: "SessionId" };
export type MsgId = string & { readonly __brand: "MsgId" };
export type RunNonce = string & { readonly __brand: "RunNonce" };
export const CLIS = ["devin", "grok", "opencode"] as const;
export const PRESETS = ["read", "write", "full"] as const;
export const TURN_ENDS = ["complete", "cancelled", "limit", "refused", "error"] as const;
export const OUTCOMES = ["ok", "partial", "fail"] as const;
export const OPTION_KINDS = ["allow_once", "allow_always", "reject_once", "reject_always"] as const;
export const ACKS = ["queued", "interrupt", "answered", "stopped", "rejected"] as const;
export type Cli = (typeof CLIS)[number];
export type Preset = (typeof PRESETS)[number];
export type TurnEnd = (typeof TURN_ENDS)[number];
export type Outcome = (typeof OUTCOMES)[number];
export type OptionKind = (typeof OPTION_KINDS)[number];

// id is the run directory's absolute path. cwd is where the worker runs:
// the target, except a scratch workspace in a Devin read run. nonce is
// unique to the run, so a command or request ID names the run it belongs to.
// Every run this version creates has one; a run from before it has none and
// takes no commands.
export interface RunSpec {
  id: RunId;
  nonce?: RunNonce;
  cli: Cli;
  target: string;
  cwd: string;
  gitRoot: string | null;
  preset: Preset;
  model: string;
  effort: string;
  deadlineAt: number;
  sandbox: string | null;
  resume?: SessionId;
  // Absolute scratch workspace this run reuses; execution and prune keep this path
  workspaceSource?: string;
}

// The spec of a run this version creates
export type NewRunSpec = RunSpec & { nonce: RunNonce };

export interface Approval {
  id: string;
  toolCallId?: string;
  title: string;
  toolKind?: string;
  command?: string;
  scope?: string;
  paths: string[];
  options: { id: string; kind: OptionKind }[];
}

export type Phase =
  | { kind: "starting" }
  | { kind: "running"; turn: number; tools: number }
  | { kind: "waiting"; turn: number; tools: number; approval: Approval }
  | { kind: "ended"; outcome: Outcome; reason: string; leftover: number; dirty: Dirty; completedAt?: number };

// widen is the parent's explicit grant of a sticky allow option
export type Answer = "allow" | "deny" | "widen";

// Why a parent's allow counts as widening the sandbox
export type Widening = "sticky" | "path";

// Paths changed in the git root during the run, by the worker or any other
// writer; "?" when a snapshot failed, null when the target is not in a git repo
export type Dirty = number | "?" | null;

export type Ack = (typeof ACKS)[number];

// error is the agent's message when it answered the prompt with an error,
// such as a provider rejecting the model
export interface Turn {
  n: number;
  end: TurnEnd;
  tools: number;
  text: boolean;
  error?: string;
}

export interface RunState {
  supervisorPid: number;
  workerPgid?: number;
  workerStart?: string;
  sessionId?: SessionId;
  heartbeatAt: number;
  phase: Phase;
  queued: MsgId[];
  acks: Record<MsgId, Ack>;
  turns: Turn[];
  asks: number;
  waited: number;
  denied: number;
  widened: number;
}

export type ParentCommand = { id: MsgId } & (
  | { kind: "send"; text: string; now: boolean }
  | { kind: "answer"; approval: string; decision: Answer }
  | { kind: "stop" }
);

export type Finish =
  | { kind: "done" }
  | { kind: "deadline" }
  | { kind: "stopped" }
  | { kind: "error"; message: string };

export type EngineEvent =
  | { kind: "spawned"; workerPgid: number; workerStart: string | null }
  | { kind: "live"; sessionId: SessionId }
  | { kind: "heartbeat"; at: number }
  | { kind: "turnStart" }
  | { kind: "tool" }
  | { kind: "approval"; approval: Approval; decision: "allow" | "ask" }
  | { kind: "answered"; decision: Answer; widened: Widening | null; next: Approval | null }
  | { kind: "turnEnd"; end: TurnEnd; text: boolean; error?: string }
  | { kind: "ack"; id: MsgId; ack: Ack }
  | { kind: "delivered"; ids: MsgId[] }
  | { kind: "finish"; at: number; cause: Finish; leftover: number; dirty: Dirty };

export function initialState(supervisorPid: number, now: number): RunState {
  return {
    supervisorPid,
    heartbeatAt: now,
    phase: { kind: "starting" },
    queued: [],
    acks: {},
    turns: [],
    asks: 0,
    waited: 0,
    denied: 0,
    widened: 0,
  };
}

export function isLive(phase: Phase): boolean {
  return phase.kind !== "ended";
}

export function reduce(s: RunState, e: EngineEvent): RunState {
  const { phase } = s;
  switch (e.kind) {
    case "spawned":
      return { ...s, workerPgid: e.workerPgid, workerStart: e.workerStart ?? undefined };
    case "live":
      return { ...s, sessionId: e.sessionId };
    case "heartbeat":
      return { ...s, heartbeatAt: e.at };
    case "turnStart":
      if (phase.kind === "ended") return s;
      return { ...s, phase: { kind: "running", turn: s.turns.length + 1, tools: 0 } };
    case "tool":
      if (phase.kind !== "running" && phase.kind !== "waiting") return s;
      return { ...s, phase: { ...phase, tools: phase.tools + 1 } };
    case "approval": {
      const counted = { ...s, asks: s.asks + 1 };
      if (e.decision === "allow") return counted;
      const waited = { ...counted, waited: s.waited + 1 };
      if (phase.kind !== "running") return waited;
      return { ...waited, phase: { kind: "waiting", turn: phase.turn, tools: phase.tools, approval: e.approval } };
    }
    case "answered":
      if (phase.kind !== "waiting") return s;
      return {
        ...s,
        denied: s.denied + (e.decision === "deny" ? 1 : 0),
        widened: s.widened + (e.widened ? 1 : 0),
        phase: e.next
          ? { ...phase, approval: e.next }
          : { kind: "running", turn: phase.turn, tools: phase.tools },
      };
    case "turnEnd":
      if (phase.kind !== "running" && phase.kind !== "waiting") return s;
      return {
        ...s,
        phase: { kind: "running", turn: phase.turn, tools: phase.tools },
        turns: [...s.turns, { n: phase.turn, end: e.end, tools: phase.tools, text: e.text, ...(e.error === undefined ? {} : { error: e.error }) }],
      };
    case "ack":
      return {
        ...s,
        acks: { ...s.acks, [e.id]: e.ack },
        queued: e.ack === "queued" ? [...s.queued, e.id] : s.queued,
      };
    case "delivered":
      return { ...s, queued: s.queued.filter((id) => !e.ids.includes(id)) };
    case "finish":
      if (phase.kind === "ended") return s;
      return { ...s, phase: { kind: "ended", ...settle(s, e.cause), leftover: e.leftover, dirty: e.dirty, completedAt: e.at } };
  }
}

// Runner meanings: answer.md is the last turn's text, and an empty one is
// fail. Text plus an engine error, a provider error, a cut-off turn, a stop,
// a deadline, or a denied request is partial. dirty never changes the
// outcome: another writer in the same repo counts too.
function settle(s: RunState, cause: Finish): { outcome: Outcome; reason: string } {
  const last = s.turns.at(-1);
  const cut = cause.kind === "done" ? "" : cause.kind === "error" ? cause.message : cause.kind;
  const provider = last?.error === undefined ? "" : `provider error: ${last.error || "(empty)"}`;
  if (!last?.text) {
    const empty = provider || (last?.end !== "complete" ? "no answer" : s.denied > 0 ? "empty-after-deny" : "empty");
    return { outcome: "fail", reason: cut || empty };
  }
  if (cut || provider) return { outcome: "partial", reason: cut || provider };
  if (last.end !== "complete") return { outcome: "partial", reason: "" };
  if (s.denied > 0) return { outcome: "partial", reason: "denied" };
  return { outcome: "ok", reason: "" };
}

const WIRE_STOP: Record<TurnEnd, string> = {
  complete: "end_turn",
  cancelled: "cancelled",
  limit: "limit",
  refused: "refusal",
  error: "error",
};

const SENT: Partial<Record<Ack, string>> = { queued: "queue", interrupt: "interrupt" };

export function statusLine(spec: RunSpec, s: RunState, now: number): string {
  const { phase } = s;
  const label = `${spec.effort} ${spec.preset}${spec.sandbox ? ` sandbox=${spec.sandbox}` : ""}`;
  const counts = `asks=${s.asks} waited=${s.waited} denied=${s.denied}${s.widened ? ` widened=${s.widened}` : ""}`;
  let status: string;
  let detail: string;
  switch (phase.kind) {
    case "starting":
      status = "starting";
      detail = label;
      break;
    case "running": {
      status = "running";
      const lastSent = Object.values(s.acks).findLast((ack) => SENT[ack] !== undefined);
      const sent = lastSent ? ` sent=${SENT[lastSent]}` : "";
      const queued = s.queued.length ? ` queued=${s.queued.length}` : "";
      const left = Math.max(0, Math.round((spec.deadlineAt - now) / 60_000));
      detail = `${label} turn=${phase.turn} tools=${phase.tools}${sent}${queued} ${counts} left=${left}m`;
      break;
    }
    case "waiting": {
      status = "waiting";
      const { approval } = phase;
      const allow = pickOption(approval.options, "allow")
        ? "allow|deny"
        : pickOption(approval.options, "widen")
          ? "deny|allow --widen"
          : "deny";
      // The title only when nothing else names the call, marked as the worker's
      // own words: Devin titles hide writes ("Ran test.sh" was a sed -i)
      const what =
        approval.command !== undefined
          ? `cmd=${clean(approval.command, 80)}`
          : approval.scope !== undefined
            ? `scope=${clean(approval.scope, 80)}`
            : approval.paths.length
              ? clean(`${approval.toolKind ?? "path"} ${[...new Set(approval.paths)].map((p) => shown(p, spec.target)).join(" ")}`, 80)
              : approval.title
                ? `title=${clean(approval.title, 80)}`
                : "(no command)";
      detail = `${label} req=${approval.id} "${what}" answer ${allow}`;
      break;
    }
    case "ended": {
      status = phase.outcome;
      const last = s.turns.at(-1);
      // Long enough for three suggested models or a provider's sentence
      const reason = phase.reason ? `${clean(phase.reason, 200)} ` : "";
      const dirty = phase.dirty === null ? "" : ` dirty=${phase.dirty}`;
      detail =
        `${label} ${reason}turns=${s.turns.length} stop=${last ? WIRE_STOP[last.end] : "-"} ` +
        `${counts}${dirty} leftover=${phase.leftover}`;
      break;
    }
  }
  return statusText(`[${spec.cli} | ${status} | ${spec.model} | ${detail} | session=${s.sessionId === undefined ? "-" : clean(s.sessionId)} | out=${spec.id}]`);
}

export type TurnOutput = { kind: "text"; text: string } | { kind: "tool" };

// The answer is the text after the turn's last tool call, as print mode
// reports it, so narration before a tool call never counts as one
export function nextAnswer(answer: string, out: TurnOutput): string {
  return out.kind === "tool" ? "" : answer + out.text;
}

// The answer is the last turn's text, so a parent that sent a follow-up
// needs the transcripts of the turns before it
export function earlierTurns(turns: readonly Turn[]): string {
  return turns.length > 1 ? `earlier turns: ${turns.slice(0, -1).map((t) => `turns/${t.n}.md`).join(" ")}` : "";
}

// Relative to the target when inside it, so the parent reads the same path it passed as --cwd
function shown(p: string, target: string): string {
  const rel = path.relative(target, p);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : p;
}

// Keeps free text, the worker's or the caller's, from adding a field to the
// bracketed, pipe-separated line
export function clean(text: string, max = Number.POSITIVE_INFINITY): string {
  const flat = statusText(text).replace(/[\s|\]"]+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// A terminal escape sequence, then any C0 or C1 control, DEL, or Unicode line
// or paragraph separator. Each becomes a space, so the line stays one line
// that a terminal prints as written.
const UNPRINTABLE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]?|[\p{Cc}\u2028\u2029]/gu;

// For every status line. The line is for reading, not parsing, so a field
// that clean does not cover, such as the model or out=, may still hold | or ]
export function statusText(text: string): string {
  return text.replace(UNPRINTABLE, " ");
}
