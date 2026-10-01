import fs from "node:fs";
import path from "node:path";
import { type CodexExecution, type DirectCleanup, type ExecuteDirect, directEnv } from "./direct.ts";
import { modelRejection } from "./model-rejection.ts";
import { killTree, spawnDetached, startTime, tree } from "./procs.ts";
import { clean } from "./state.ts";

export const executeCodex: ExecuteDirect = async (input, signal, onStarted) => {
  if (input.provider !== "codex") throw new Error("executeCodex requires provider codex");
  const out = input.out;
  const effort = input.effort;
  if (signal.aborted) {
    return {
      exitCode: null,
      sessionId: "",
      detail: `${effort} exit=null stopped`,
      failed: true,
      cleanup: { kind: "done", leftover: 0 },
      endedBy: "stop",
    };
  }
  const stdin = fs.openSync(path.join(out, "prompt.md"), "r");
  const stdoutFd = fs.openSync(path.join(out, "stdout.raw"), "w");
  const stderrFd = fs.openSync(path.join(out, "stderr.log"), "w");
  const argv = codexArgv(input);
  let child;
  try {
    child = spawnDetached([input.executable, ...argv], {
      cwd: input.target,
      env: directEnv(),
      stdio: [stdin, stdoutFd, stderrFd],
    });
  } finally {
    fs.closeSync(stdin);
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }
  const pid = child.pid;
  if (pid === undefined) throw new Error(`${input.executable} did not start`);
  const start = startTime(pid);
  onStarted({ pid, pgid: pid, start });

  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, sig) => resolve({ code, signal: sig }));
  });
  let cleanup: DirectCleanup = { kind: "done", leftover: 0 };
  let stopping: Promise<void> | undefined;
  const stop = () => {
    if (!stopping) {
      stopping = stopWorker(pid).then((c) => {
        cleanup = c;
      });
    }
    return stopping;
  };
  signal.addEventListener("abort", () => void stop(), { once: true });
  if (signal.aborted) await stop();
  const { code } = await closed;
  if (stopping) await stopping;
  const raw = fs.existsSync(path.join(out, "stdout.raw")) ? fs.readFileSync(path.join(out, "stdout.raw"), "utf8") : "";
  const err = fs.existsSync(path.join(out, "stderr.log")) ? fs.readFileSync(path.join(out, "stderr.log"), "utf8") : "";
  const parsed = parseCodexJsonl(raw);
  const rejected = modelRejection(input.model, [raw, err]);
  if (parsed.errorItems.length) {
    fs.appendFileSync(path.join(out, "stderr.log"), parsed.errorItems.map((m) => `codex error item: ${m}\n`).join(""));
  }
  fs.writeFileSync(path.join(out, "session_id"), `${parsed.sessionId}\n`);
  const answer = fs.existsSync(path.join(out, "answer.md")) ? fs.readFileSync(path.join(out, "answer.md"), "utf8") : "";
  const aborted = signal.aborted;
  const failed = aborted || code !== 0 || parsed.usage === "turn.failed" || !answer.trim();
  const mode = input.mode;
  const tier = input.tier ? `tier=${input.tier} ` : "";
  const usage = parsed.usage ? `${parsed.usage}` : "";
  let detail: string;
  if (aborted) {
    detail = `${effort} exit=${code ?? "null"} stopped`.trim();
  } else if (failed) {
    detail = `${effort} exit=${code ?? "null"} ${usage}${rejected ? ` ${rejected}` : ""}`.trim();
  } else {
    detail = `${effort} ${mode} ${tier}${usage}`.trim();
  }
  return {
    exitCode: code,
    sessionId: parsed.sessionId,
    detail: clean(detail),
    failed,
    cleanup,
    ...(aborted ? { endedBy: "stop" as const } : {}),
  };
};

export function codexArgv(input: CodexExecution): string[] {
  const effort = input.effort;
  const profile = input.mode === "write" ? "workspace" : "read-only";
  const opts = [
    "--json",
    "-m",
    input.model,
    "-c",
    `model_reasoning_effort=${effort}`,
    "-o",
    path.join(input.out, "answer.md"),
    "-c",
    `permissions.delegate.extends=":${profile}"`,
    "-c",
    "permissions.delegate.network.enabled=true",
    "-c",
    'default_permissions="delegate"',
  ];
  if (input.tier) opts.push("-c", `service_tier=${input.tier}`);
  if (!input.gitRoot) opts.push("--skip-git-repo-check");
  if (input.resume) return ["exec", "resume", ...opts, "--", input.resume, "-"];
  return ["exec", ...opts, "-"];
}

export function parseCodexJsonl(text: string): { sessionId: string; usage: string; errorItems: string[] } {
  let sessionId = "";
  let usage = "";
  const errorItems: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof event !== "object" || event === null) continue;
    const e = event as Record<string, unknown>;
    if (e.type === "thread.started" && typeof e.thread_id === "string" && !sessionId) sessionId = e.thread_id;
    if (e.type === "turn.completed") {
      const u = e.usage;
      if (typeof u === "object" && u !== null) {
        const rec = u as Record<string, unknown>;
        usage = `in=${rec.input_tokens ?? "?"} out=${rec.output_tokens ?? "?"}`;
      }
    } else if (e.type === "turn.failed") {
      usage = "turn.failed";
    }
    const item = e.item;
    if (typeof item === "object" && item !== null) {
      const rec = item as Record<string, unknown>;
      if (rec.type === "error" && typeof rec.message === "string") errorItems.push(rec.message);
    }
  }
  return { sessionId, usage, errorItems };
}

async function stopWorker(pid: number): Promise<DirectCleanup> {
  try {
    const leftover = await killTree(pid, tree(pid, [pid]));
    return { kind: "done", leftover };
  } catch (e) {
    return { kind: "uncertain", detail: (e as Error).message };
  }
}
