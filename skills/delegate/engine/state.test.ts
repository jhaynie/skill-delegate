import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { earlierTurns, initialState, nextAnswer, reduce, statusLine, type Approval, type EngineEvent, type Finish, type MsgId, type RunId, type RunNonce, type RunSpec, type RunState, type SessionId, type TurnOutput } from "./state.ts";

const spec: RunSpec = {
  id: "/runs/devin-1" as RunId,
  nonce: "n1" as RunNonce,
  cli: "devin",
  target: "/repo",
  cwd: "/runs/devin-1/workspace",
  gitRoot: "/repo",
  preset: "read",
  model: "swe-2-high",
  effort: "medium",
  deadlineAt: 10 * 60_000,
  sandbox: null,
};

const scope: Approval = {
  id: "r1",
  toolCallId: "call_a#1",
  title: "Requested write access to /Users/p",
  scope: "write /Users/p",
  paths: [],
  options: [
    { id: "allow_session", kind: "allow_always" },
    { id: "reject_once", kind: "reject_once" },
  ],
};

const play = (events: EngineEvent[]): RunState =>
  events.reduce(reduce, reduce(initialState(42, 0), { kind: "live", sessionId: "s1" as SessionId }));

test("a turn with tools and an asked approval waits, then runs after a deny", () => {
  const waiting = play([{ kind: "turnStart" }, { kind: "tool" }, { kind: "tool" }, { kind: "approval", approval: scope, decision: "ask" }]);
  assert.equal(
    statusLine(spec, waiting, 0),
    '[devin | waiting | swe-2-high | medium read req=r1 "scope=write /Users/p" answer deny|allow --widen | session=s1 | out=/runs/devin-1]',
  );
  const resumed = reduce(waiting, { kind: "answered", decision: "deny", widened: null, next: null });
  assert.equal(
    statusLine(spec, resumed, 60_000),
    "[devin | running | swe-2-high | medium read turn=1 tools=2 asks=1 waited=1 denied=1 left=9m | session=s1 | out=/runs/devin-1]",
  );
});

test("the waiting line quotes the command, not the title, when the request carries one", () => {
  const exec: Approval = {
    ...scope,
    title: "Ran test.sh",
    command: "sed -i s/a/b/ x && ./test.sh",
    options: [{ id: "allow_once", kind: "allow_once" }],
  };
  const s = play([{ kind: "turnStart" }, { kind: "approval", approval: exec, decision: "ask" }]);
  assert.equal(
    statusLine(spec, s, 0),
    '[devin | waiting | swe-2-high | medium read req=r1 "cmd=sed -i s/a/b/ x && ./test.sh" answer allow|deny | session=s1 | out=/runs/devin-1]',
  );
});

test("an auto-allowed approval counts as an ask but never as waited", () => {
  const s = play([{ kind: "turnStart" }, { kind: "approval", approval: scope, decision: "allow" }]);
  assert.deepEqual([s.phase.kind, s.asks, s.waited], ["running", 1, 0]);
});

test("a queued message shows on the running line until it is delivered", () => {
  const id = "1000-7" as MsgId;
  const queued = play([{ kind: "turnStart" }, { kind: "ack", id, ack: "queued" }]);
  assert.equal(
    statusLine({ ...spec, cli: "grok", model: "grok-4.7", sandbox: "workspace" }, queued, 0),
    "[grok | running | grok-4.7 | medium read sandbox=workspace turn=1 tools=0 sent=queue queued=1 asks=0 waited=0 denied=0 left=10m | session=s1 | out=/runs/devin-1]",
  );
  assert.deepEqual(reduce(queued, { kind: "delivered", ids: [id] }).queued, []);
});

test("a read run with text ends ok whatever changed in the repo, with every count on the line", () => {
  const s = play([
    { kind: "turnStart" },
    { kind: "tool" },
    { kind: "turnEnd", end: "complete", text: true },
    { kind: "finish", at: 123, cause: { kind: "done" }, leftover: 0, dirty: 3 },
  ]);
  assert.equal(
    statusLine(spec, s, 0),
    "[devin | ok | swe-2-high | medium read turns=1 stop=end_turn asks=0 waited=0 denied=0 dirty=3 leftover=0 | session=s1 | out=/runs/devin-1]",
  );
});

test("an empty last turn is fail, even when an earlier turn answered, and names a deny only after one", () => {
  const answeredThenEmpty: EngineEvent[] = [
    { kind: "turnStart" },
    { kind: "turnEnd", end: "cancelled", text: true },
    { kind: "turnStart" },
  ];
  const end: EngineEvent[] = [
    { kind: "turnEnd", end: "complete", text: false },
    { kind: "finish", at: 123, cause: { kind: "done" }, leftover: 1, dirty: null },
  ];
  assert.deepEqual(play([...answeredThenEmpty, ...end]).phase, { kind: "ended", completedAt: 123, outcome: "fail", reason: "empty", leftover: 1, dirty: null });
  const denied: EngineEvent[] = [
    { kind: "approval", approval: scope, decision: "ask" },
    { kind: "answered", decision: "deny", widened: null, next: null },
  ];
  assert.deepEqual(play([...answeredThenEmpty, ...denied, ...end]).phase, {
    kind: "ended", completedAt: 123,
    outcome: "fail",
    reason: "empty-after-deny",
    leftover: 1,
    dirty: null,
  });
});

test("text before a turn's last tool call is not an answer, so a denied last call fails the run", () => {
  const turn: TurnOutput[] = [{ kind: "text", text: "I'll perform the three file operations." }, { kind: "tool" }];
  const answer = turn.reduce(nextAnswer, "");
  assert.equal(answer, "");
  assert.equal(turn.concat({ kind: "text", text: "Done." }).reduce(nextAnswer, ""), "Done.");
  const s = play([
    { kind: "turnStart" },
    { kind: "tool" },
    { kind: "approval", approval: scope, decision: "ask" },
    { kind: "answered", decision: "deny", widened: null, next: null },
    { kind: "turnEnd", end: "complete", text: answer.trim() !== "" },
    { kind: "finish", at: 123, cause: { kind: "done" }, leftover: 0, dirty: null },
  ]);
  assert.deepEqual(s.phase, { kind: "ended", completedAt: 123, outcome: "fail", reason: "empty-after-deny", leftover: 0, dirty: null });
});

test("a stop with answer text is partial, and a cut-off turn is partial", () => {
  const stopped = play([
    { kind: "turnStart" },
    { kind: "turnEnd", end: "cancelled", text: true },
    { kind: "finish", at: 123, cause: { kind: "stopped" }, leftover: 0, dirty: null },
  ]);
  assert.equal(
    statusLine(spec, stopped, 0),
    "[devin | partial | swe-2-high | medium read stopped turns=1 stop=cancelled asks=0 waited=0 denied=0 leftover=0 | session=s1 | out=/runs/devin-1]",
  );
  const cut = play([
    { kind: "turnStart" },
    { kind: "turnEnd", end: "limit", text: true },
    { kind: "finish", at: 123, cause: { kind: "done" }, leftover: 0, dirty: null },
  ]);
  assert.equal(cut.phase.kind === "ended" && cut.phase.outcome, "partial");
  const empty = play([
    { kind: "turnStart" },
    { kind: "turnEnd", end: "cancelled", text: false },
    { kind: "finish", at: 123, cause: { kind: "stopped" }, leftover: 1, dirty: 0 },
  ]);
  assert.deepEqual(empty.phase, { kind: "ended", completedAt: 123, outcome: "fail", reason: "stopped", leftover: 1, dirty: 0 });
});

test("an engine error ends fail with its reason, and later events change nothing", () => {
  const died = play([{ kind: "finish", at: 123, cause: { kind: "error", message: "engine died, no heartbeat 40s" }, leftover: 1, dirty: null }]);
  assert.equal(
    statusLine({ ...spec, cli: "grok", model: "grok-4.7" }, died, 0),
    "[grok | fail | grok-4.7 | medium read engine died, no heartbeat 40s turns=0 stop=- asks=0 waited=0 denied=0 leftover=1 | session=s1 | out=/runs/devin-1]",
  );
  assert.equal(reduce(died, { kind: "turnStart" }), died);
  assert.equal(reduce(died, { kind: "finish", at: 456, cause: { kind: "done" }, leftover: 0, dirty: 0 }), died);
  const rewritten = reduce(reduce(died, { kind: "heartbeat", at: 456 }), { kind: "ack", id: "late" as MsgId, ack: "rejected" });
  assert.equal(rewritten.phase.kind === "ended" && rewritten.phase.completedAt, 123);
});

test("a prompt the agent answered with an error fails with the agent's own message", () => {
  const said = "Internal error: The API deployment for this resource does not exist. If you created the deployment within the last 5 minutes, please wait a moment and try again.";
  const s = play([{ kind: "turnStart" }, { kind: "turnEnd", end: "error", text: false, error: said }, { kind: "finish", at: 123, cause: { kind: "done" }, leftover: 0, dirty: null }]);
  assert.deepEqual(s.phase, { kind: "ended", completedAt: 123, outcome: "fail", reason: `provider error: ${said}`, leftover: 0, dirty: null });
  assert.equal(
    statusLine(spec, s, 0),
    `[devin | fail | swe-2-high | medium read provider error: ${said} turns=1 stop=error asks=0 waited=0 denied=0 leftover=0 | session=s1 | out=/runs/devin-1]`,
  );
  const silent = play([{ kind: "turnStart" }, { kind: "turnEnd", end: "error", text: false }, { kind: "finish", at: 123, cause: { kind: "done" }, leftover: 0, dirty: null }]);
  assert.equal(silent.phase.kind === "ended" && silent.phase.reason, "no answer");
});

test("an ended line keeps a long reason up to 200 characters", () => {
  const died = play([{ kind: "finish", at: 123, cause: { kind: "error", message: "x".repeat(250) }, leftover: 0, dirty: null }]);
  assert.match(statusLine(spec, died, 0), new RegExp(`read ${"x".repeat(199)}… turns=0`));
});

// Every C0 and C1 control, DEL, a CSI sequence, and both Unicode line separators
const NASTY = "a\x1b[2K\x1b[1Gb\x07c\x7fd\x85e\u2028f\u2029g\vh\fi\rj\nk\tl\0m";

// How many lines Python's splitlines reads, which splits on more than \n
function physicalLines(text: string): number {
  return Number(spawnSync("python3", ["-c", "import sys; print(len(sys.stdin.read().splitlines()))"], { input: text, encoding: "utf8" }).stdout);
}

test("a status line keeps no control, escape sequence, or line separator, and a worker's text cannot add a field", () => {
  const ended = play([{ kind: "finish", at: 123, cause: { kind: "error", message: `reason ${NASTY} | out=/victim` }, leftover: 0, dirty: null }]);
  const s = { ...ended, sessionId: `s1 ${NASTY} | out=/victim` as SessionId };
  const line = statusLine({ ...spec, model: `model ${NASTY}` }, s, 0);
  assert.equal(
    line,
    "[devin | fail | model a  b c d e f g h i j k l m | medium read reason a b c d e f g h i j k l m out=/victim turns=0 stop=- asks=0 waited=0 denied=0 leftover=0 " +
      "| session=s1 a b c d e f g h i j k l m out=/victim | out=/runs/devin-1]",
  );
  assert.equal(physicalLines(line), 1);
});

test("a command with pipes and brackets cannot break the line", () => {
  const s = play([{ kind: "turnStart" }, { kind: "approval", approval: { ...scope, command: 'a | b] "c"\nd' }, decision: "ask" }]);
  assert.match(statusLine(spec, s, 0), /req=r1 "cmd=a b c d" answer deny\|allow --widen \|/);
});

test("a request with no command, scope, or path shows its title as the tool name, and a neutral label without one", () => {
  const { scope: _, ...bare } = scope;
  const mcp = play([{ kind: "turnStart" }, { kind: "approval", approval: { ...bare, title: "grep_app__searchGitHub" }, decision: "ask" }]);
  assert.equal(
    statusLine({ ...spec, cli: "grok", model: "grok-4.7", sandbox: "read-only" }, mcp, 0),
    '[grok | waiting | grok-4.7 | medium read sandbox=read-only req=r1 "title=grep_app__searchGitHub" answer deny|allow --widen | session=s1 | out=/runs/devin-1]',
  );
  const untitled = play([{ kind: "turnStart" }, { kind: "approval", approval: { ...bare, title: "" }, decision: "ask" }]);
  assert.match(statusLine(spec, untitled, 0), /req=r1 "\(no command\)" answer/);
});

test("a file-tool request with no command shows its kind and path, relative inside the target", () => {
  const { scope: _, ...bare } = scope;
  const once = [{ id: "allow_once", kind: "allow_once" as const }, { id: "reject_once", kind: "reject_once" as const }];
  const edit = { ...bare, toolKind: "edit", paths: ["/repo/src/a.ts", "/repo/src/a.ts"], options: once };
  const inside = play([{ kind: "turnStart" }, { kind: "approval", approval: edit, decision: "ask" }]);
  assert.equal(
    statusLine(spec, inside, 0),
    '[devin | waiting | swe-2-high | medium read req=r1 "edit src/a.ts" answer allow|deny | session=s1 | out=/runs/devin-1]',
  );
  const read = { ...bare, toolKind: "read", paths: ["/etc/hosts"], options: once };
  const outside = play([{ kind: "turnStart" }, { kind: "approval", approval: read, decision: "ask" }]);
  assert.match(statusLine(spec, outside, 0), /req=r1 "read \/etc\/hosts" answer allow\|deny \|/);
  const repoLike = { ...bare, toolKind: "edit", paths: ["/repository/x"], options: once };
  assert.match(statusLine(spec, play([{ kind: "turnStart" }, { kind: "approval", approval: repoLike, decision: "ask" }]), 0), /"edit \/repository\/x"/);
});

test("a parent's widen grant is counted on the running and final lines", () => {
  const widened = play([
    { kind: "turnStart" },
    { kind: "approval", approval: scope, decision: "ask" },
    { kind: "answered", decision: "widen", widened: "sticky", next: null },
  ]);
  assert.equal(
    statusLine(spec, widened, 0),
    "[devin | running | swe-2-high | medium read turn=1 tools=0 asks=1 waited=1 denied=0 widened=1 left=10m | session=s1 | out=/runs/devin-1]",
  );
  const ended = [
    { kind: "turnEnd", end: "complete", text: true },
    { kind: "finish", at: 123, cause: { kind: "done" }, leftover: 0, dirty: null },
  ] satisfies EngineEvent[];
  assert.equal(
    statusLine(spec, ended.reduce(reduce, widened), 0),
    "[devin | ok | swe-2-high | medium read turns=1 stop=end_turn asks=1 waited=1 denied=0 widened=1 leftover=0 | session=s1 | out=/runs/devin-1]",
  );
});

test("a request with only bypass or global allow options offers deny alone", () => {
  const bypassOnly: Approval = {
    ...scope,
    options: [
      { id: "allow_always_global", kind: "allow_always" },
      { id: "switch_bypass", kind: "allow_always" },
      { id: "reject_once", kind: "reject_once" },
    ],
  };
  const s = play([{ kind: "turnStart" }, { kind: "approval", approval: bypassOnly, decision: "ask" }]);
  assert.match(statusLine(spec, s, 0), /answer deny \|/);
});

test("answer text keeps an engine error or a deny partial", () => {
  const answered: EngineEvent[] = [{ kind: "turnStart" }, { kind: "turnEnd", end: "complete", text: true }];
  const end = (cause: Finish, extra: EngineEvent[] = []) => play([...answered, ...extra, { kind: "finish", at: 123, cause, leftover: 0, dirty: "?" }]).phase;
  assert.deepEqual(end({ kind: "error", message: "engine died, no heartbeat 40s" }), {
    kind: "ended", completedAt: 123,
    outcome: "partial",
    reason: "engine died, no heartbeat 40s",
    leftover: 0,
    dirty: "?",
  });
  const denied = play([
    { kind: "turnStart" },
    { kind: "approval", approval: scope, decision: "ask" },
    { kind: "answered", decision: "deny", widened: null, next: null },
    { kind: "turnEnd", end: "complete", text: true },
    { kind: "finish", at: 123, cause: { kind: "done" }, leftover: 0, dirty: "?" },
  ]);
  assert.equal(
    statusLine(spec, denied, 0),
    "[devin | partial | swe-2-high | medium read denied turns=1 stop=end_turn asks=1 waited=1 denied=1 dirty=? leftover=0 | session=s1 | out=/runs/devin-1]",
  );
});

test("a plain allow that opens a path beyond the policy counts as widened, and one inside does not", () => {
  const once = [{ id: "allow_once", kind: "allow_once" as const }, { id: "reject_once", kind: "reject_once" as const }];
  const outside = { ...scope, scope: undefined, toolKind: "edit", paths: ["/elsewhere/from-worker.txt"], options: once };
  const allowed = (widened: "path" | null) =>
    play([{ kind: "turnStart" }, { kind: "approval", approval: outside, decision: "ask" }, { kind: "answered", decision: "allow", widened, next: null }]);
  assert.match(statusLine(spec, allowed("path"), 0), / denied=0 widened=1 left=/);
  assert.match(statusLine(spec, allowed(null), 0), / denied=0 left=/);
});

test("a run of three turns names the first two transcripts, and a one-turn run names none", () => {
  const turn: EngineEvent[] = [{ kind: "turnStart" }, { kind: "turnEnd", end: "complete", text: true }];
  assert.equal(earlierTurns(play([...turn, ...turn, ...turn]).turns), "earlier turns: turns/1.md turns/2.md");
  assert.equal(earlierTurns(play(turn).turns), "");
});
