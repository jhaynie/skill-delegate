import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { openAcpSession, type PromptEnd, type WorkerEvent, type WorkerSession } from "./acp.ts";
import { decide, widening, type SeenTool } from "./policy.ts";
import { alive, killTree, mayBeRunning, sameProcess, sleep, tree } from "./procs.ts";
import type { Run } from "./run.ts";
import {
  isLive,
  nextAnswer,
  reduce,
  type Approval,
  type Dirty,
  type EngineEvent,
  type Finish,
  type MsgId,
  type ParentCommand,
  type RunState,
  type TurnEnd,
} from "./state.ts";
import { profiles } from "./workers.ts";

const HEARTBEAT_MS = 5_000;
const POLL_MS = 500;
const STALE_MS = 30_000;
const PRIORITY = "Message from the parent agent, which takes priority over earlier instructions:\n\n";

// The detached process that holds the worker session. It is the only writer
// of state.json while it holds owner.lock, which it takes from the run CLI
// that started it. executable is the worker CLI the run CLI checked.
export async function own(run: Run, executable: string): Promise<never> {
  if (!run.takeover(process.ppid)) process.exit(1);
  const { spec } = run;
  // Only a run this version created has a nonce, and only such a run gets an owner
  const { nonce } = spec;
  if (nonce === undefined) process.exit(1);
  let s: RunState = { ...run.state(), supervisorPid: process.pid };
  const apply = (e: EngineEvent) => {
    s = reduce(s, e);
    run.commit(s);
  };
  run.commit(s);
  const heartbeat = setInterval(() => apply({ kind: "heartbeat", at: Date.now() }), HEARTBEAT_MS);
  const before = spec.gitRoot ? snapshot(spec.gitRoot, run.file("git-before.txt")) : null;

  const seen = new Map<string, SeenTool>();
  const asks: Approval[] = [];
  const queued: { id: MsgId; text: string }[] = [];
  let session: WorkerSession | undefined;
  let transcript = "";
  let answer = "";

  const onEvent = (e: WorkerEvent) => {
    switch (e.kind) {
      case "spawned":
        return apply({ kind: "spawned", workerPgid: e.pgid, workerStart: e.start });
      case "opened":
        return apply({ kind: "live", sessionId: e.sessionId });
      case "text":
        answer = nextAnswer(answer, e);
        transcript += e.text;
        return;
      case "tool": {
        const first = !seen.has(e.toolCallId);
        seen.set(e.toolCallId, e.tool);
        if (first) {
          answer = nextAnswer(answer, e);
          apply({ kind: "tool" });
        }
        return;
      }
      case "approval": {
        const decision = decide(spec, e.approval, seen);
        run.event({ approval: e.approval, decision, correlated: seen.has(e.approval.toolCallId ?? "") });
        apply({ kind: "approval", approval: e.approval, decision });
        if (decision === "allow") session?.answer(e.approval.id, "allow");
        else asks.push(e.approval);
        return;
      }
    }
  };

  interface TurnResult {
    end: TurnEnd;
    stop: boolean;
    timedOut: boolean;
    nows: { id: MsgId; text: string }[];
  }

  // One prompt, with the inbox and the time limit serviced while it runs.
  const runTurn = async (current: WorkerSession, prompt: string): Promise<TurnResult> => {
    apply({ kind: "turnStart" });
    transcript = "";
    answer = "";
    const turn = current.prompt(prompt);
    const r: Omit<TurnResult, "end"> = { stop: false, timedOut: false, nows: [] };
    let ended: PromptEnd | null = null;
    // An interrupt throws when the worker ignores the cancel; the turn's
    // text is still written before the run ends on that error
    try {
      while (ended === null) {
        ended = await Promise.race([turn, sleep(POLL_MS).then(() => null)]);
        if (ended !== null) break;
        for (const cmd of run.claim()) await handle(cmd, current, r);
        if (r.stop || r.timedOut || r.nows.length) continue;
        if (Date.now() > spec.deadlineAt) {
          r.timedOut = true;
          await current.interrupt();
        }
      }
    } finally {
      fs.writeFileSync(run.file(`turns/${s.turns.length + 1}.md`), transcript);
      fs.writeFileSync(run.file("answer.md"), answer);
      asks.length = 0;
      const error = ended?.error;
      apply({ kind: "turnEnd", end: ended?.end ?? "error", text: answer.trim() !== "", ...(error === undefined ? {} : { error }) });
    }
    return { ...r, end: ended.end };
  };

  const handle = async (cmd: ParentCommand, current: WorkerSession, r: Omit<TurnResult, "end">) => {
    run.event({ command: cmd });
    switch (cmd.kind) {
      case "stop":
        apply({ kind: "ack", id: cmd.id, ack: "stopped" });
        r.stop = true;
        await current.interrupt();
        return;
      case "answer": {
        const open = asks.findIndex((a) => a.id === cmd.approval);
        const option = open === -1 ? null : current.answer(cmd.approval, cmd.decision);
        if (!option) {
          run.reject(cmd);
          apply({ kind: "ack", id: cmd.id, ack: "rejected" });
          return;
        }
        const [approval] = asks.splice(open, 1);
        // A widen that found allow_once on offer granted nothing sticky
        const decision = cmd.decision === "widen" && option.kind === "allow_once" ? "allow" : cmd.decision;
        const widened = approval ? widening(spec, approval, seen, option) : null;
        run.event({ answered: { approval: cmd.approval, decision, optionId: option.id, ...(widened ? { widened } : {}) } });
        apply({ kind: "answered", decision, widened, next: asks[0] ?? null });
        apply({ kind: "ack", id: cmd.id, ack: "answered" });
        return;
      }
      case "send":
        if (!cmd.now) {
          queued.push({ id: cmd.id, text: cmd.text });
          apply({ kind: "ack", id: cmd.id, ack: "queued" });
          return;
        }
        r.nows.push({ id: cmd.id, text: cmd.text });
        await current.interrupt();
        return;
    }
  };

  const turnLoop = async (current: WorkerSession): Promise<Finish> => {
    let prompt = fs.readFileSync(run.file("prompt.md"), "utf8");
    let nows: { id: MsgId; text: string }[] = [];
    for (;;) {
      if (nows.length) prompt = [prompt, PRIORITY + nows.map((n) => n.text).join("\n\n")].filter(Boolean).join("\n\n");
      const acked = nows;
      nows = [];
      const turnStarting = runTurn(current, prompt);
      for (const n of acked) apply({ kind: "ack", id: n.id, ack: "interrupt" });
      const r = await turnStarting;
      if (r.stop) return { kind: "stopped" };
      if (r.timedOut) return { kind: "deadline" };
      if (r.nows.length) {
        nows = r.nows;
        prompt = "";
        continue;
      }
      // A run ends only on an empty inbox, so drain it once more first
      const drained = { stop: false, timedOut: false, nows: [] as { id: MsgId; text: string }[] };
      for (const cmd of run.claim()) await handle(cmd, current, drained);
      if (drained.stop) return { kind: "stopped" };
      if (drained.nows.length) {
        nows = drained.nows;
        prompt = "";
        continue;
      }
      if (queued.length) {
        const batch = queued.splice(0);
        prompt = batch.map((q) => q.text).join("\n\n");
        apply({ kind: "delivered", ids: batch.map((q) => q.id) });
        continue;
      }
      return { kind: "done" };
    }
  };

  let finish: Finish;
  try {
    session = await openAcpSession(profiles[spec.cli], { ...spec, nonce }, executable, onEvent);
    finish = await turnLoop(session);
  } catch (e) {
    finish = { kind: "error", message: (e as Error).message };
  }

  const leftover = session ? (await session.close()).leftover : 0;
  rejectInbox();
  for (const q of queued) apply({ kind: "ack", id: q.id, ack: "rejected" });
  apply({ kind: "delivered", ids: queued.map((q) => q.id) });
  // The snapshot blocks the heartbeat timer, so it starts on a fresh beat for stop to wait on
  apply({ kind: "heartbeat", at: Date.now() });
  const dirty: Dirty = spec.gitRoot ? diffCount(before, snapshot(spec.gitRoot, run.file("git-after.txt"))) : null;
  clearInterval(heartbeat);
  apply({ kind: "finish", at: Date.now(), cause: finish, leftover, dirty });
  // A send that landed during the final commit gets its answer before the lock goes
  rejectInbox();
  run.unlock();
  process.exit(0);

  function rejectInbox(): void {
    for (const cmd of run.claim()) {
      run.reject(cmd);
      if (cmd.kind !== "stop") apply({ kind: "ack", id: cmd.id, ack: "rejected" });
    }
  }
}

// Ends a live run whose owner is gone: its pid is dead or now names another
// process. A slow heartbeat alone never reaps a live owner.
export async function reconcile(run: Run): Promise<RunState> {
  const s = run.state();
  if (!isLive(s.phase)) return restoreStatus(run, s);
  const holder = run.holder();
  const gone = holder ? !mayBeRunning(holder.pid, holder.start, holder.legacy) : Date.now() - s.heartbeatAt > STALE_MS;
  if (!gone) return s;
  return (await reap(run, (age) => `engine died, no heartbeat ${age}s`)).state;
}

// An owner that died between its ended state.json and status left no
// status. The line follows from the state, so whoever holds the lock writes it.
function restoreStatus(run: Run, s: RunState): RunState {
  if (fs.existsSync(run.file("status")) || !run.takeover()) return s;
  const now = run.state();
  if (!isLive(now.phase) && !fs.existsSync(run.file("status"))) run.commit(now);
  run.unlock();
  return now;
}

// stop waits out the owner's shutdown while its heartbeat stays younger than
// the age at which reconcile would call it dead
export function shouldKeepWaiting(s: RunState, now: number): boolean {
  return isLive(s.phase) && now - s.heartbeatAt < STALE_MS;
}

// stop's fallback when the owner does not end the run in time. forced says
// this call ended it, rather than the owner or another reader.
export async function forceStop(run: Run): Promise<{ state: RunState; forced: boolean }> {
  const holder = run.holder();
  if (holder && sameProcess(holder.pid, holder.start)) {
    await killTree(holder.pid, tree(holder.pid, [holder.pid]));
  }
  const { state, reaped } = await reap(run, () => "stop forced");
  return { state, forced: reaped };
}

async function reap(run: Run, reason: (heartbeatAge: number) => string): Promise<{ state: RunState; reaped: boolean }> {
  if (!run.takeover()) return { state: run.state(), reaped: false };
  const s = run.state();
  if (!isLive(s.phase)) {
    run.unlock();
    return { state: s, reaped: false };
  }
  const pgid = s.workerPgid;
  // A leader pid that is alive but started later is recycled, and its old group is empty
  const ours = pgid !== undefined && (!alive(pgid) || sameProcess(pgid, s.workerStart));
  const leftover = ours ? await killTree(pgid, tree(pgid, [pgid])) : 0;
  const age = Math.round((Date.now() - s.heartbeatAt) / 1000);
  const ended = reduce(s, {
    kind: "finish",
    at: Date.now(),
    cause: { kind: "error", message: reason(age) },
    leftover,
    dirty: null,
  });
  run.commit(ended);
  run.unlock();
  return { state: ended, reaped: true };
}

// One line per path git reports as changed or untracked, with its status and
// a content hash, so a further edit to an already-dirty file still counts
function snapshot(root: string, file: string): Map<string, string> | null {
  let raw: string;
  try {
    raw = execFileSync("git", ["status", "--porcelain", "-z", "--untracked-files=all"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64_000_000,
    });
  } catch {
    return null;
  }
  const entries = new Map<string, string>();
  const fields = raw.split("\0");
  for (let i = 0; i < fields.length - 1; i++) {
    const field = fields[i] ?? "";
    const xy = field.slice(0, 2);
    const rel = field.slice(3);
    if (xy.startsWith("R") || xy.startsWith("C")) i++;
    const full = path.join(root, rel);
    const digest = fs.statSync(full, { throwIfNoEntry: false })?.isFile()
      ? createHash("sha1").update(fs.readFileSync(full)).digest("hex")
      : "-";
    entries.set(rel, `${xy}\t${digest}`);
  }
  fs.writeFileSync(file, [...entries].map(([p, v]) => `${p}\t${v}\n`).join(""));
  return entries;
}

function diffCount(before: Map<string, string> | null, after: Map<string, string> | null): Dirty {
  if (!before || !after) return "?";
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((p) => before.get(p) !== after.get(p)).length;
}
