import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { alive, describe, killTree, sameProcess, sleep, spawnDetached, startTime, tree } from "./procs.ts";
import { pickOption, type SeenTool } from "./policy.ts";
import { OPTION_KINDS, type Answer, type Approval, type NewRunSpec, type SessionId, type TurnEnd } from "./state.ts";
import { baseEnv, type Lockdown, type WorkerProfile } from "./workers.ts";

type Json = Record<string, unknown>;

const HANDSHAKE_MS = 60_000;
export const CANCEL_MS = 15_000;
const EXIT_GRACE_MS = 3_000;
const RAW_CAP_BYTES = 20_000_000;

const STOP: Record<string, TurnEnd> = {
  end_turn: "complete",
  cancelled: "cancelled",
  max_tokens: "limit",
  max_turn_requests: "limit",
  refusal: "refused",
};

const obj = (v: unknown): Json | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// A JSON-RPC error reply, which keeps its code so the handshake can tell
// auth_required, and the agent's own message for the status line
class RpcError extends Error {
  readonly code: unknown;
  readonly agentMessage: string;
  constructor(error: Json) {
    // An agent may send an object or no message at all; either still shows
    const said = error.message === undefined ? "" : (str(error.message) ?? JSON.stringify(error.message));
    super(`${said} ${JSON.stringify(error.data ?? "")}`.trim());
    this.code = error.code;
    this.agentMessage = said;
  }
}

// ACP's auth_required code, or an agent's message that says so under another code
export function authRequired(code: unknown, message: string): boolean {
  return code === -32000 || /auth(entication)? (is )?required/i.test(message);
}

type SessionReply = { kind: "ok"; result: Json } | { kind: "auth-required"; message: string };

// error is the agent's own message when it answered the prompt with an error
export interface PromptEnd {
  end: TurnEnd;
  error?: string;
}

export interface WorkerSession {
  readonly sessionId: SessionId;
  readonly pgid: number;
  prompt(text: string): Promise<PromptEnd>;
  // Cancels the turn, settles open approvals, and waits at most 15 s
  interrupt(): Promise<void>;
  // The option sent, or null when the request is gone or offers none that fits
  answer(approvalId: string, a: Answer): Approval["options"][number] | null;
  close(): Promise<{ leftover: number }>;
}

export type WorkerEvent =
  | { kind: "spawned"; pgid: number; start: string | null }
  | { kind: "opened"; sessionId: SessionId }
  | { kind: "text"; text: string }
  | { kind: "tool"; toolCallId: string; tool: SeenTool }
  | { kind: "approval"; approval: Approval };

// executable is the absolute path of the worker CLI, which stands in for
// the command name the profile's argv starts with
export async function openAcpSession(
  profile: WorkerProfile,
  spec: NewRunSpec,
  executable: string,
  onEvent: (e: WorkerEvent) => void,
): Promise<WorkerSession> {
  const base = baseEnv();
  const launch = profile.launch(spec, base, executable);
  const stderr = fs.openSync(path.join(spec.id, "stderr.log"), "a");
  const child = spawnDetached([executable, ...profile.argv(spec.preset).slice(1)], {
    cwd: spec.cwd,
    env: { ...base, ...launch.env },
    stdio: ["pipe", "pipe", stderr],
  });
  const { pid, stdin, stdout } = child;
  if (pid === undefined || !stdin || !stdout) throw new Error(`${executable} did not start`);
  // A write after the worker exits must not crash the owner; the exit handler reports it
  stdin.on("error", () => {});
  const start = startTime(pid);
  onEvent({ kind: "spawned", pgid: pid, start });
  const note = (line: string) => fs.appendFileSync(path.join(spec.id, "stderr.log"), `delegate: ${line}\n`);

  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const approvals = new Map<string, { rpcId: unknown; options: Approval["options"] }>();
  const seen = new Map<string, SeenTool & { title?: string }>();
  let approvalCount = 0;
  // Set by a cancel until its prompt settles; a request that arrives then is answered cancelled
  let cancelling = false;
  let replaying = false;
  let rawBytes = 0;
  let exited: string | null = null;

  const write = (msg: Json) => {
    if (exited === null) stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
  };
  const request = (method: string, params: Json, timeoutMs?: number): Promise<Json> =>
    new Promise((resolve, reject) => {
      if (exited !== null) return reject(new Error(exited));
      const id = nextId++;
      const timer = timeoutMs
        ? setTimeout(() => {
            pending.delete(id);
            reject(new Error(`${method} got no reply in ${timeoutMs / 1000}s`));
          }, timeoutMs)
        : undefined;
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(obj(v) ?? {});
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      write({ id, method, params });
    });

  child.on("exit", (code, sig) => {
    exited = `worker exited (${sig ?? code})`;
    for (const waiter of pending.values()) waiter.reject(new Error(exited));
    pending.clear();
  });

  const onPermission = (rpcId: unknown, params: Json | undefined) => {
    const call = obj(params?.toolCall);
    const toolCallId = str(call?.toolCallId);
    const known = toolCallId === undefined ? undefined : seen.get(toolCallId);
    const options = arr(params?.options).flatMap((raw) => {
      const o = obj(raw);
      const id = str(o?.optionId);
      const kind = str(o?.kind);
      const known = OPTION_KINDS.find((k) => k === kind);
      return id !== undefined && known ? [{ id, kind: known }] : [];
    });
    const asked = locations(call, spec.cwd);
    // The nonce keeps an answer copied from an earlier run's line in this directory off this run's requests.
    // Devin's request carries only the call id, so the kind and paths come from the announced call
    const approval: Approval = {
      id: `r${++approvalCount}-${spec.nonce.slice(0, 8)}`,
      toolCallId,
      title: str(call?.title) ?? known?.title ?? "",
      toolKind: str(call?.kind) ?? known?.kind,
      command: str(obj(call?._meta)?.["cognition.ai/editableCommand"]) ?? str(obj(call?.rawInput)?.command),
      scope: scopeOf(call) ?? known?.scope,
      paths: asked.length ? asked : (known?.paths ?? []),
      options,
    };
    if (cancelling) {
      write({ id: rpcId, result: { outcome: { outcome: "cancelled" } } });
      return;
    }
    approvals.set(approval.id, { rpcId, options });
    onEvent({ kind: "approval", approval });
  };

  const onUpdate = (update: Json | undefined) => {
    if (!update || replaying) return;
    const kind = update.sessionUpdate;
    if (kind === "agent_message_chunk") {
      const content = obj(update.content);
      const text = content?.type === "text" ? str(content.text) : undefined;
      if (text) onEvent({ kind: "text", text });
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      const toolCallId = str(update.toolCallId);
      if (toolCallId === undefined) return;
      const before = seen.get(toolCallId);
      const paths = locations(update, spec.cwd);
      const tool = {
        title: str(update.title) ?? before?.title,
        kind: str(update.kind) ?? before?.kind,
        command: str(obj(update.rawInput)?.command) ?? before?.command,
        scope: scopeOf(update) ?? before?.scope,
        paths: paths.length ? paths : (before?.paths ?? []),
      };
      seen.set(toolCallId, tool);
      onEvent({ kind: "tool", toolCallId, tool });
    }
  };

  readline.createInterface({ input: stdout }).on("line", (line) => {
    if (rawBytes < RAW_CAP_BYTES) {
      rawBytes += line.length + 1;
      fs.appendFileSync(path.join(spec.id, "stdout.raw"), `${line}\n`);
    }
    let msg: Json | undefined;
    try {
      msg = obj(JSON.parse(line));
    } catch {
      return;
    }
    if (!msg) return;
    const method = str(msg.method);
    if (msg.id !== undefined && method !== undefined) {
      if (method === "session/request_permission") return onPermission(msg.id, obj(msg.params));
      // An extension request needs a result, or the agent may never settle its turn
      if (method.startsWith("_")) return write({ id: msg.id, result: {} });
      return write({ id: msg.id, error: { code: -32601, message: `client does not support ${method}` } });
    }
    if (msg.id !== undefined) {
      const waiter = typeof msg.id === "number" ? pending.get(msg.id) : undefined;
      if (!waiter) return;
      pending.delete(msg.id as number);
      const error = obj(msg.error);
      if (error) waiter.reject(new RpcError(error));
      else waiter.resolve(msg.result);
      return;
    }
    if (method === "session/update") onUpdate(obj(obj(msg.params)?.update));
  });

  // Until node sees the exit the pid cannot be reused. After it, the pid is
  // ours only while its start time matches, or while it is dead and its
  // group may still hold members.
  const ours = () => exited === null || !alive(pid) || sameProcess(pid, start ?? undefined);
  const close = async (): Promise<{ leftover: number }> => {
    const members = ours() ? tree(pid, [pid]) : [];
    stdin.end();
    const until = Date.now() + EXIT_GRACE_MS;
    while (exited === null && Date.now() < until) await sleep(100);
    if (!ours()) {
      note(`worker pid ${pid} now names another process; not signalling it`);
      return { leftover: 0 };
    }
    const left = members.filter(alive);
    if (left.length) note(`left behind after stdin closed: ${describe(left)}`);
    return { leftover: await killTree(pid, members) };
  };

  try {
    const init = await request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "delegate", version: "1" },
      },
      HANDSHAKE_MS,
    );
    if (spec.resume && obj(init.agentCapabilities)?.loadSession !== true) {
      throw new Error("--resume needs session/load, which this CLI does not advertise");
    }
    const resume = spec.resume;
    const openOnce = async (): Promise<SessionReply> => {
      replaying = resume !== undefined;
      try {
        const result = resume
          ? await request("session/load", { sessionId: resume, cwd: spec.cwd, mcpServers: [] }, HANDSHAKE_MS)
          : await request("session/new", { cwd: spec.cwd, mcpServers: [] }, HANDSHAKE_MS);
        return { kind: "ok", result };
      } catch (e) {
        if (e instanceof RpcError && authRequired(e.code, e.message)) return { kind: "auth-required", message: e.message };
        throw e;
      } finally {
        replaying = false;
      }
    };
    // Authenticate only when the agent asks, because Devin's one method opens
    // a browser sign-in page even while the CLI login is cached
    let opened = await openOnce();
    if (opened.kind === "auth-required") {
      const methods = arr(init.authMethods).map((m) => str(obj(m)?.id));
      if (!methods.includes(profile.authMethod)) {
        throw new Error(`auth method ${profile.authMethod} not offered (${methods.join(", ")})`);
      }
      await request("authenticate", { methodId: profile.authMethod }, HANDSHAKE_MS).catch((e: Error) => {
        throw new Error(`authenticate failed, sign in to the CLI first: ${e.message}`);
      });
      opened = await openOnce();
    }
    if (opened.kind === "auth-required") throw new Error(`sign in to the CLI first: ${opened.message}`);

    let sessionId: SessionId;
    if (resume) {
      sessionId = resume;
    } else {
      fs.writeFileSync(path.join(spec.id, "session-new.json"), JSON.stringify(opened.result, null, 2));
      const id = str(opened.result.sessionId);
      if (!id) throw new Error("session/new returned no sessionId");
      sessionId = id as SessionId;
    }
    fs.writeFileSync(path.join(spec.id, "session_id"), `${sessionId}\n`);
    onEvent({ kind: "opened", sessionId });

    // Checked before any prompt, so a refused run can be retried without
    // --resume. A CLI that lists its models only once one is set is checked
    // against that reply.
    const refuse = (listed: ConfigOption | undefined) => {
      const refused = modelRefusal(listed, spec.model);
      if (refused !== null) throw new Error(refused);
    };
    const opening = configOptions(opened.result).find((o) => o.id === profile.configIds.model);
    refuse(opening);

    // Each set_config_option reply carries every option, so the last one
    // holds what the session will run with
    const set = async (configId: string, value: string) =>
      configOptions(await request("session/set_config_option", { sessionId, configId, value }, HANDSHAKE_MS));
    const mode = profile.mode === null ? null : { configId: profile.mode.configId, value: profile.mode.value(spec.preset) };
    // The mode holds OpenCode's read fence, so a session that cannot take it never gets a prompt
    if (mode !== null && !configOptions(opened.result).some((o) => o.id === mode.configId)) {
      throw new Error(`the session offers no ${mode.configId} option, so ${mode.value} cannot be set`);
    }
    if (mode !== null) await set(mode.configId, mode.value);
    let options = await set(profile.configIds.model, spec.model);
    const listed = opening?.values.length ? opening : options.find((o) => o.id === profile.configIds.model);
    refuse(listed);
    if (!listed?.values.length) note(`the session lists no models, so the CLI alone decides whether ${spec.model} runs`);
    const effort = options.find((o) => o.id === profile.configIds.effort);
    if (!effort) {
      note(`${spec.model} offers no ${profile.configIds.effort} option, so effort ${spec.effort} does not apply`);
    } else if (!effort.values.includes(spec.effort)) {
      throw new Error(`--effort ${spec.effort} is not one of ${effort.values.join(", ")}`);
    } else {
      options = await set(profile.configIds.effort, spec.effort);
    }
    // A CLI that listed no models has its own set or prompt error decide the run
    const wanted = [
      { what: "model", option: options.find((o) => o.id === profile.configIds.model), value: spec.model, required: Boolean(listed?.values.length) },
      ...(effort ? [{ what: "effort", option: options.find((o) => o.id === profile.configIds.effort), value: spec.effort, required: true }] : []),
      ...(mode === null ? [] : [{ what: "mode", option: options.find((o) => o.id === mode.configId), value: mode.value, required: true }]),
    ];
    for (const { what, option, value, required } of wanted) {
      const read = readBack(option, value);
      if (read.kind === "absent" && required) throw new Error(`the session reports no ${what}, so ${value} is unconfirmed`);
      if (read.kind === "absent") note(`the session reports no ${what}, so ${value} is unconfirmed`);
      if (read.kind === "differs") throw new Error(`${what} reads back ${read.current ?? "nothing"}, not ${value}`);
    }

    const lockdown = launch.lockdown();
    if (lockdown.kind !== "held") {
      note(lockdownReason(lockdown));
      throw new Error(`refusing to prompt: ${lockdownReason(lockdown)}`);
    }

    let turn: Promise<PromptEnd> | null = null;

    return {
      sessionId,
      pgid: pid,
      prompt: (text) => {
        cancelling = false;
        turn = request("session/prompt", { sessionId, prompt: [{ type: "text", text }] })
          .then(
            (r): PromptEnd => ({ end: STOP[str(r.stopReason) ?? ""] ?? "error" }),
            (e: Error): PromptEnd => {
              note(`session/prompt failed: ${e.message}`);
              return e instanceof RpcError ? { end: "error", error: e.agentMessage } : { end: "error" };
            },
          )
          .finally(() => {
            cancelling = false;
          });
        return turn;
      },
      interrupt: async () => {
        cancelling = true;
        write({ method: "session/cancel", params: { sessionId } });
        // A permission request left open survives the cancel and strands the turn
        for (const { rpcId } of approvals.values()) write({ id: rpcId, result: { outcome: { outcome: "cancelled" } } });
        approvals.clear();
        if (!turn) return;
        const settled = await Promise.race([turn.then(() => true), sleep(CANCEL_MS).then(() => false)]);
        if (!settled) throw new Error("cancel hung");
      },
      answer: (approvalId, a) => {
        const open = approvals.get(approvalId);
        const option = open ? pickOption(open.options, a) : null;
        if (!open || !option) return null;
        approvals.delete(approvalId);
        write({ id: open.rpcId, result: { outcome: { outcome: "selected", optionId: option.id } } });
        return option;
      },
      close,
    };
  } catch (e) {
    await close();
    throw e;
  }
}

export interface ConfigOption {
  id: string;
  category: string | undefined;
  current: string | undefined;
  values: string[];
}

// A select option lists its values flat or in groups
export function configOptions(reply: Json): ConfigOption[] {
  return arr(reply.configOptions).flatMap((raw) => {
    const o = obj(raw);
    const id = str(o?.id);
    if (!o || id === undefined) return [];
    const values = arr(o.options).flatMap((choice) => {
      const c = obj(choice);
      const flat = str(c?.value);
      return flat !== undefined ? [flat] : arr(c?.options).flatMap((inner) => str(obj(inner)?.value) ?? []);
    });
    return [{ id, category: str(o.category), current: str(o.currentValue), values }];
  });
}

// null when the CLI lists the model, or lists none and so leaves it to the
// CLI, else the refusal with the listed IDs nearest to it
export function modelRefusal(listed: ConfigOption | undefined, model: string): string | null {
  if (!listed?.values.length || listed.values.includes(model)) return null;
  const near = nearest(listed.values, model);
  return `model not offered; nearest: ${near.length ? near.join(", ") : "none"}`;
}

// At most three IDs, case-insensitively: the largest share of words in
// common first (shared over all, so a long ID that merely contains the
// wanted one ranks low), then the fewest single-character edits, then by
// name. An ID qualifies by a shared word or three edits or fewer.
export function nearest(ids: string[], wanted: string): string[] {
  const want = wanted.toLowerCase();
  const words = wordsOf(want);
  return [...new Set(ids)]
    .map((id) => {
      const low = id.toLowerCase();
      const own = wordsOf(low);
      const shared = [...own].filter((w) => words.has(w)).length;
      return { id, overlap: shared / new Set([...own, ...words]).size, edits: editDistance(low, want) };
    })
    .filter((c) => c.overlap > 0 || c.edits <= 3)
    .sort((a, b) => b.overlap - a.overlap || a.edits - b.edits || (a.id < b.id ? -1 : 1))
    .slice(0, 3)
    .map((c) => c.id);
}

function wordsOf(id: string): Set<string> {
  return new Set(id.split(/[^a-z0-9]+/).filter(Boolean));
}

// Levenshtein distance
function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min((row[j] ?? 0) + 1, (next[j - 1] ?? 0) + 1, (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length] ?? 0;
}

export type ReadBack = { kind: "match" } | { kind: "absent" } | { kind: "differs"; current: string | undefined };

export function readBack(option: ConfigOption | undefined, value: string): ReadBack {
  if (!option) return { kind: "absent" };
  return option.current === value ? { kind: "match" } : { kind: "differs", current: option.current };
}

function lockdownReason(lockdown: Exclude<Lockdown, { kind: "held" }>): string {
  switch (lockdown.kind) {
    case "noDeny":
      return 'the effective rules lost the "*": "deny"';
    case "extra":
      return `the effective rules open ${lockdown.rules.map((r) => `${r.permission} ${r.pattern} ${r.action}`).join(", ")}`;
    case "unreadable":
      return `cannot read the effective rules: ${lockdown.reason}`;
  }
}

// Devin's write tool names its file only in a diff, never in locations
export function locations(call: Json | undefined, base: string): string[] {
  const diffs = arr(call?.content).filter((c) => obj(c)?.type === "diff");
  return [...arr(call?.locations), ...diffs].flatMap((l) => {
    const p = str(obj(l)?.path);
    return p === undefined ? [] : [canonicalPath(p, base)];
  });
}

// Devin's request_scope call names the access it wants in rawInput
function scopeOf(call: Json | undefined): string | undefined {
  const input = obj(call?.rawInput);
  const scope = str(input?.scope);
  const target = str(input?.path);
  return scope && target ? `${scope} ${target}` : undefined;
}

// Resolves symlinks through the nearest existing ancestor, so a path that
// does not exist yet still canonicalizes, and /repo/link/x lands where link
// points. The native realpath also gives the on-disk case, so /USERS/x on a
// case-folding volume compares equal to /Users/x.
export function canonicalPath(p: string, base: string): string {
  const full = path.resolve(base, p);
  const rest: string[] = [];
  for (let dir = full; ; dir = path.dirname(dir)) {
    try {
      return path.join(fs.realpathSync.native(dir), ...rest);
    } catch {
      if (dir === path.dirname(dir)) return full;
      rest.unshift(path.basename(dir));
    }
  }
}
