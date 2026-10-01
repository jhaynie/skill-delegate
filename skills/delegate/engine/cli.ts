import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CANCEL_MS, canonicalPath } from "./acp.ts";
import { executeCodex } from "./codex.ts";
import { DEFAULT_MODEL as CURSOR_DEFAULT_MODEL, cursorPrompt, executeCursor, prepareCursor, recordedCursorWorkspace } from "./cursor.ts";
import {
  CODEX_FLAG_ORDER,
  CODEX_RUN_FLAGS,
  CURSOR_FLAG_ORDER,
  CURSOR_RUN_FLAGS,
  DirectRunError,
  type DirectProvider,
  createDirect,
  directAnswerText,
  directLiveLine,
  forceDirectStop,
  isDirectDir,
  listDirectRuns,
  ownDirect,
  readDirect,
  readDirectStatus,
  reconcileDirect,
  requestStop,
  resolveRunDir,
  shouldKeepWaitingDirect,
  untilDirectEnded,
  waitDirectReady,
} from "./direct.ts";
import { pickHelp, ROOT_HELP, type CommandShapes } from "./help.ts";
import { forceStop, own, reconcile, shouldKeepWaiting } from "./owner.ts";
import { admitResume, initScratchSource, pruneRuns, resolvePruneRoot, scratchWorkspace } from "./prune.ts";
import { lstartEpoch, spawnDetached, sleep } from "./procs.ts";
import {
  createRun,
  findRunBySession,
  fsDenied,
  holdsRun,
  listRuns,
  newMsgId,
  newNonce,
  openRun,
  outRoot,
  ownerLock,
  readRun,
  RunFileError,
  runnerAlive,
  type Holder,
  type OwnerLock,
  type Run,
  type RunFileProblem,
} from "./run.ts";
import { clean, CLIS, earlierTurns, isLive, statusLine, statusText, type Cli, type NewRunSpec, type Preset, type RunId, type RunState, type SessionId } from "./state.ts";
import { briefRules, profiles, rulesFiles } from "./workers.ts";

type Exit = 0 | 1 | 2;

const RUN_WAIT_MS = 60_000;
const ACK_WAIT_MS = 10_000;
// The most stop waits on an owner whose heartbeat stays fresh. Its shutdown
// takes about 21 s (acp.ts, procs.ts) plus the git snapshot
const STOP_WAIT_MS = 60_000;
const DEFAULT_DEADLINE_MS = 45 * 60_000;
const STOP_NOT_APPLIED = "stop not applied: the run had already ended";
const PREDATES_NONCES = "this run predates command nonces, so it takes no answer, send, or stop";
const USAGE = ROOT_HELP;
const DIRECT_UNSUPPORTED = "unsupported on a direct run";
const CODEX_TAKES = CODEX_FLAG_ORDER.map((name) => `--${name}`).join(", ");
const CURSOR_TAKES = CURSOR_FLAG_ORDER.map((name) => `--${name}`).join(", ");

class UsageError extends Error {
  // What parsed before the error, so a run's fail line can name its cli
  flags: ReadonlyMap<string, string> | undefined;
  constructor(message: string, flags?: ReadonlyMap<string, string>) {
    super(message);
    this.flags = flags;
  }
}

export async function main(argv: string[]): Promise<Exit> {
  absolutePath();
  const [command, ...rest] = argv;
  try {
    const picked = pickHelp(argv, RUN_FLAGS, COMMAND_SHAPES);
    if (picked.kind === "help") {
      print(picked.text);
      if (picked.docs) {
        const pkg = path.dirname(import.meta.dirname);
        print(`docs: ${path.join(pkg, "README.md")} ${path.join(pkg, "docs", "runners.md")}`);
      }
      return 0;
    }
    if (picked.kind === "error") throw new UsageError(picked.message, picked.flags);
    switch (command) {
      case "run":
        return await runCommand(rest);
      case "status":
        return await statusCommand(rest);
      case "send":
        return await sendCommand(rest);
      case "answer":
        return await answerCommand(rest);
      case "stop":
        return await stopCommand(rest);
      case "result":
        return await resultCommand(rest);
      case "prune":
        return pruneCommand(rest);
      case "own":
        return await ownCommand(need(rest[0], "own <out> <executable>"), need(rest[1], "own <out> <executable>"));
      case "--print-flags":
        for (const name of RUN_FLAGS.valued) print(`--${name} value`);
        for (const name of RUN_FLAGS.booleans) print(`--${name} boolean`);
        return 0;
      default:
        throw new UsageError(USAGE);
    }
  } catch (e) {
    if (e instanceof DirectRunError) {
      let answer: string | null = null;
      if ((command === "run" && rest.includes("--answer")) || (command === "result" && !rest.includes("--quiet"))) {
        try {
          answer = directAnswerText(e.dir, true);
        } catch (readError) {
          if (!fsDenied(readError)) throw readError;
          answer = "";
        }
      }
      printRun(`[- | fail | - | ${clean(e.message)} | session=- | out=${statusText(e.dir)}]`, answer);
      process.stderr.write(`${e.message}\n`);
      return 1;
    }
    if (!(e instanceof UsageError || e instanceof RunFileError)) throw e;
    const message = e instanceof RunFileError ? `usage: ${e.message}` : e.message;
    const named = e instanceof UsageError ? e.flags?.get("cli") : undefined;
    const cli = command === "run" && (CLIS.some((c) => c === named) || named === "codex" || named === "cursor") ? named : undefined;
    print(usageLine(cli ?? "-", message));
    process.stderr.write(`${message}\n`);
    return 2;
  }
}

// A usage error prints a fail line too, so a caller that reads only stdout,
// such as a forwarding agent, still gets a status line
function usageLine(cli: string, message: string): string {
  const first = message === USAGE ? (USAGE.split("\n")[1] ?? "") : (message.replace(/^usage:\s*/, "").split(`\n${USAGE}`)[0] ?? "");
  return `[${cli} | fail | - | usage: ${clean(first)} | session=- | out=-]`;
}

// The flags run takes. parseArgs reads this table, and --print-flags prints
// it for the plugin agent generator, so the two never disagree.
const RUN_FLAGS = {
  positional: 0,
  booleans: ["full-access", "wait", "answer"],
  valued: ["cli", "cwd", "prompt-file", "mode", "model", "effort", "deadline", "resume", "out"],
};

const COMMAND_SHAPES: CommandShapes = {
  status: { positional: 1, booleans: ["verbose"], valued: ["cwd"] },
  send: { positional: 2, booleans: ["now"] },
  answer: { positional: 3, booleans: ["widen"] },
  stop: { positional: 1 },
  result: { positional: 1, booleans: ["wait", "quiet"], valued: ["timeout"] },
  prune: { positional: 0, booleans: ["dry-run"], valued: ["older-than"] },
};

async function runCommand(args: string[]): Promise<Exit> {
  if (args.includes("--print-flags")) {
    const cli = peekCli(args);
    if (cli === "codex") {
      printFlagTable(CODEX_RUN_FLAGS, CODEX_FLAG_ORDER);
      return 0;
    }
    if (cli === "cursor") {
      printFlagTable(CURSOR_RUN_FLAGS, CURSOR_FLAG_ORDER);
      return 0;
    }
    for (const name of RUN_FLAGS.valued) print(`--${name} value`);
    for (const name of RUN_FLAGS.booleans) print(`--${name} boolean`);
    return 0;
  }
  const cli = peekCli(args);
  const table =
    cli === "codex"
      ? { ...CODEX_RUN_FLAGS, unexpected: codexUnexpected, valuePrefix: "-" }
      : cli === "cursor"
        ? { ...CURSOR_RUN_FLAGS, unexpected: cursorUnexpected, valuePrefix: "-" }
        : RUN_FLAGS;
  const { flags } = parseArgs(args, table);
  try {
    return await startRun(flags);
  } catch (e) {
    if (e instanceof UsageError) e.flags ??= flags;
    if (e instanceof RunFileError) throw new UsageError(`usage: ${e.message}`, flags);
    throw e;
  }
}

function printFlagTable(table: { booleans: readonly string[]; valued: readonly string[] }, order: readonly string[]): void {
  const seen = new Set<string>();
  for (const name of order) {
    if (table.valued.includes(name)) print(`--${name} value`);
    else if (table.booleans.includes(name)) print(`--${name} boolean`);
    seen.add(name);
  }
  for (const name of table.valued) if (!seen.has(name)) print(`--${name} value`);
  for (const name of table.booleans) if (!seen.has(name)) print(`--${name} boolean`);
}

function peekCli(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--cli") {
      const value = args[i + 1];
      return value && !value.startsWith("--") ? value : undefined;
    }
  }
  return undefined;
}

function codexUnexpected(arg: string): string {
  return `usage: delegate run --cli codex does not take ${arg}. It takes ${CODEX_TAKES}`;
}

function cursorUnexpected(arg: string): string {
  return `usage: delegate run --cli cursor does not take ${arg}. It takes ${CURSOR_TAKES}`;
}

async function startRun(flags: ReadonlyMap<string, string>): Promise<Exit> {
  const name = need(flags.get("cli"), `--cli ${[...CLIS, "codex", "cursor"].join("|")}`);
  if (name === "codex" || name === "cursor") return startDirectRun(flags, name);
  const cli = CLIS.find((c) => c === name);
  if (!cli) throw new UsageError(`--cli must be one of ${[...CLIS, "codex", "cursor"].join(", ")}, not ${name}`);
  const profile = profiles[cli];
  if (profile.hostMarker && process.env[profile.hostMarker]) {
    throw new UsageError(`this host is ${cli}, so use its native subagents, not this engine`);
  }
  const cwd = expandHome(need(flags.get("cwd"), "--cwd <repo>"));
  if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new UsageError(`--cwd is not a directory: ${cwd}`);
  const promptFile = expandHome(need(flags.get("prompt-file"), "--prompt-file <brief.md>"));
  const brief = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, "utf8") : "";
  if (!brief.trim()) throw new UsageError(`prompt file is missing or empty: ${promptFile}`);
  const mode = flags.get("mode") ?? "read";
  if (mode !== "read" && mode !== "write") throw new UsageError("--mode must be read or write");
  const full = flags.has("full-access");
  if (full && mode !== "write") throw new UsageError("--full-access applies only to --mode write");
  if (full && !profile.fullAccess) throw new UsageError(`--full-access: ${cli} has no sandbox to turn off`);
  const preset: Preset = full ? "full" : mode;
  const answer = flags.has("answer");
  const wait = flags.has("wait") || answer;
  const deadlineMs = flags.has("deadline") ? duration(flags.get("deadline")) : DEFAULT_DEADLINE_MS;

  const target = fs.realpathSync.native(cwd);
  const gitRoot = gitTopLevel(target);
  if (preset !== "read" && !gitRoot) throw new UsageError(`write mode needs --cwd inside a git repo: ${target}`);
  // Checked before anything is created, so a refusal leaves no run directory behind
  const out = flags.get("out");
  const given = out === undefined ? undefined : expandHome(out);
  const planned = given ?? path.join(outRoot(), `${cli}-${stamp()}-`);
  checkPaths(preset, canonicalPath(planned, process.cwd()), gitRoot ?? target, target, given === undefined ? canonicalPath(outRoot(), process.cwd()) : null);
  const command = profile.argv(preset)[0];
  // The owner starts this exact file, so a PATH change after the check cannot swap it
  const executable = command === undefined ? null : findExecutable(command);
  if (executable === null) {
    printRun(`[${cli} | fail | - | ${command ?? cli} is not installed | session=- | out=-]`, answer ? "" : null);
    return 1;
  }
  const resume = flags.get("resume");
  let reuseWorkspace: string | undefined;
  if (preset === "read" && !profile.readInTarget && resume) {
    const prior = findRunBySession(resume)?.spec;
    if (prior?.preset !== "read") {
      throw new UsageError(`session workspace expired: ${resume}. Start a new run.`);
    }
    if (!realDirectory(prior.cwd)) throw new UsageError(`session workspace expired: ${prior.cwd}. Start a new run.`);
    reuseWorkspace = prior.cwd;
  }
  if (given === undefined) ensureDir(outRoot());
  const outReal = fs.realpathSync.native(given === undefined ? fs.mkdtempSync(planned) : ensureDir(given, "--out"));
  claimOut(outReal);
  const nonce = newNonce();
  let workerCwd = target;
  let workspaceSource: string | undefined;
  if (preset === "read" && !profile.readInTarget) {
    // The CLIs file a session under its cwd, so a resumed read run reuses the first run's workspace
    if (reuseWorkspace !== undefined) {
      if (!realDirectory(reuseWorkspace)) {
        ownerLock(outReal).unlock();
        throw new UsageError(`session workspace expired: ${reuseWorkspace}. Start a new run.`);
      }
      workerCwd = reuseWorkspace;
      workspaceSource = reuseWorkspace;
    } else {
      workerCwd = ensureDir(scratchWorkspace(outReal, nonce));
      initScratchSource(outReal);
      if (!fs.existsSync(path.join(workerCwd, ".git"))) execFileSync("git", ["-C", workerCwd, "init", "-q"]);
    }
  }

  const spec: NewRunSpec = {
    id: outReal as RunId,
    nonce,
    cli,
    target,
    cwd: workerCwd,
    gitRoot,
    preset,
    model: flags.get("model") ?? profile.defaults.model,
    effort: flags.get("effort") ?? profile.defaults.effort,
    deadlineAt: Date.now() + deadlineMs,
    sandbox: profile.sandbox(preset),
    ...(resume ? { resume: resume as SessionId } : {}),
    ...(workspaceSource === undefined ? {} : { workspaceSource }),
  };
  let run: ReturnType<typeof createRun> | undefined;
  const write = () => {
    run = createRun(spec, briefRules(spec, rulesFiles(target, gitRoot)) + brief);
  };
  if (workspaceSource !== undefined && resume) {
    const admitted = admitResume({
      sourceWorkspace: workspaceSource,
      dependent: { dir: outReal, nonce },
      writeDependent: write,
      stillValid: () => findRunBySession(resume)?.spec.cwd === workspaceSource && realDirectory(workspaceSource),
    });
    if (admitted.kind === "legacy") write();
    else if (admitted.kind !== "pinned") {
      ownerLock(outReal).unlock();
      throw new UsageError(admitted.message);
    }
    if (!fs.existsSync(path.join(workerCwd, ".git"))) execFileSync("git", ["-C", workerCwd, "init", "-q"]);
  } else {
    write();
  }
  if (run === undefined) throw new UsageError(`session workspace expired: ${workspaceSource ?? workerCwd}. Start a new run.`);
  const log = fs.openSync(run.file("owner.log"), "a");
  spawnDetached([process.execPath, import.meta.filename, "own", run.dir, executable], {
    cwd: run.dir,
    env: process.env,
    stdio: ["ignore", log, log],
  }).unref();
  // A slow start prints starting and exits 0; the owner keeps going and status catches up
  const s = await waitFor(run, (st) => (st.sessionId !== undefined && st.phase.kind !== "starting") || !isLive(st.phase), RUN_WAIT_MS);
  const final = wait ? await untilEnded(run, Number.POSITIVE_INFINITY) : s;
  return answer ? reportWithAnswer(run, final) : report(run, final);
}

async function startDirectRun(flags: ReadonlyMap<string, string>, provider: DirectProvider): Promise<Exit> {
  if (provider === "codex" && process.env.CODEX_SESSION_ID) {
    throw new UsageError("delegate run --cli codex: this host is codex, so use its native subagents");
  }
  if (provider === "cursor" && process.env.CURSOR_AGENT) {
    throw new UsageError("delegate run --cli cursor: this host is cursor, so use its native subagents");
  }
  const cwd = expandHome(need(flags.get("cwd"), "--cwd <repo>"));
  if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new UsageError(`--cwd is not a directory: ${cwd}`);
  const promptFile = expandHome(need(flags.get("prompt-file"), "--prompt-file <brief.md>"));
  const brief = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, "utf8") : "";
  if (!brief.trim()) throw new UsageError(`prompt file is missing or empty: ${promptFile}`);
  const mode = flags.get("mode") ?? "read";
  if (mode !== "read" && mode !== "write") throw new UsageError("--mode must be read or write");
  const fullAccess = flags.has("full-access");
  if (fullAccess && mode !== "write") throw new UsageError("--full-access applies only to --mode write");
  const answer = flags.has("answer");
  const wait = flags.has("wait") || answer;
  const target = fs.realpathSync.native(cwd);
  const gitRoot = gitTopLevel(target);
  if (provider === "cursor" && mode === "write" && !gitRoot) throw new UsageError(`write mode needs --cwd inside a git repo: ${target}`);
  const out = flags.get("out");
  const given = out === undefined ? undefined : expandHome(out);
  const planned = given ?? path.join(outRoot(), `${provider}-${stamp()}-`);
  checkPaths(mode, canonicalPath(planned, process.cwd()), gitRoot ?? target, target, given === undefined ? canonicalPath(outRoot(), process.cwd()) : null);
  const command = provider === "codex" ? "codex" : "cursor-agent";
  const executable = findExecutable(command);
  if (executable === null) {
    printRun(`[${provider} | fail | - | ${command} is not installed | session=- | out=-]`, answer ? "" : null);
    return 1;
  }
  const resume = flags.get("resume");
  if (provider === "cursor") {
    const refusal = prepareCursor({ target, gitRoot, mode, ...(resume === undefined ? {} : { resume }), ...(fullAccess ? { fullAccess } : {}) });
    if (refusal) throw new UsageError(refusal);
  }
  if (given === undefined) ensureDir(outRoot(), "the run directory");
  const outReal = fs.realpathSync.native(given === undefined ? fs.mkdtempSync(planned) : ensureDir(given, "--out"));
  claimOut(outReal);
  const nonce = newNonce();
  let workspaceSource: string | undefined;
  if (provider === "cursor" && mode === "read") {
    if (resume !== undefined) {
      const recorded = recordedCursorWorkspace(resume);
      if (recorded === null || !realDirectory(recorded)) {
        ownerLock(outReal).unlock();
        throw new UsageError(`session workspace expired: ${recorded ?? resume}. Start a new run.`);
      }
      workspaceSource = recorded;
    } else {
      workspaceSource = scratchWorkspace(outReal, nonce);
      fs.mkdirSync(workspaceSource, { recursive: true });
      initScratchSource(outReal);
    }
  }
  const writeDirect = () =>
    provider === "codex"
      ? createDirect(outReal, {
          provider: "codex",
          target,
          gitRoot,
          model: flags.get("model") ?? "gpt-6.1-sol",
          mode,
          effort: flags.get("effort") ?? "high",
          nonce,
          ...(flags.get("tier") === undefined ? {} : { tier: flags.get("tier") }),
          ...(resume === undefined ? {} : { resume }),
        })
      : createDirect(outReal, {
          provider: "cursor",
          target,
          gitRoot,
          model: flags.get("model") ?? CURSOR_DEFAULT_MODEL,
          mode,
          nonce,
          ...(fullAccess ? { fullAccess } : {}),
          ...(resume === undefined ? {} : { resume }),
          ...(workspaceSource === undefined ? {} : { workspaceSource }),
        });
  let identity: ReturnType<typeof writeDirect> | undefined;
  if (provider === "cursor" && mode === "read" && resume !== undefined && workspaceSource !== undefined) {
    const admitted = admitResume({
      sourceWorkspace: workspaceSource,
      dependent: { dir: outReal, nonce },
      writeDependent: () => {
        identity = writeDirect();
      },
      stillValid: () => recordedCursorWorkspace(resume) === workspaceSource && realDirectory(workspaceSource),
    });
    if (admitted.kind === "legacy") identity = writeDirect();
    else if (admitted.kind !== "pinned") {
      ownerLock(outReal).unlock();
      throw new UsageError(admitted.message);
    }
  } else {
    identity = writeDirect();
  }
  if (identity === undefined) throw new UsageError(`session workspace expired: ${workspaceSource ?? outReal}. Start a new run.`);
  const prompt =
    identity.provider === "cursor"
      ? cursorPrompt({ target, gitRoot, mode, ...(resume === undefined ? {} : { resume }), ...(fullAccess ? { fullAccess } : {}) }, brief)
      : brief;
  fs.writeFileSync(path.join(outReal, "prompt.md"), prompt);
  const log = fs.openSync(path.join(outReal, "owner.log"), "a");
  spawnDetached([process.execPath, import.meta.filename, "own", outReal, executable], {
    cwd: outReal,
    env: process.env,
    stdio: ["ignore", log, log],
  }).unref();
  fs.closeSync(log);
  if (!wait) {
    await waitDirectReady(outReal, RUN_WAIT_MS);
    return reportDirect(outReal, false);
  }
  const line = await untilDirectEnded(outReal, Number.POSITIVE_INFINITY);
  if (!line) {
    const died = identity.provider === "codex" ? `${identity.effort} owner died` : `${identity.fullAccess ? "write full-access" : identity.mode} owner died`;
    printRun(`[${provider} | fail | ${identity.model} | ${died} | session=- | out=${statusText(outReal)}]`, answer ? "" : null);
    return 1;
  }
  return reportDirect(outReal, answer);
}

async function ownCommand(dir: string, executable: string): Promise<never> {
  if (isDirectDir(dir)) {
    const meta = readDirect(dir);
    return ownDirect(dir, executable, meta.provider === "codex" ? executeCodex : executeCursor);
  }
  return own(openRef(dir), executable);
}

async function reportDirect(dir: string, answer: boolean): Promise<Exit> {
  await reconcileDirect(dir);
  const final = readDirectStatus(dir);
  const meta = readDirect(dir);
  const line = final ?? directLiveLine(dir, meta);
  const failed = (final ?? "").split(" | ")[1] === "fail";
  printRun(line, answer ? directAnswerText(dir, failed) : null);
  return failed ? 1 : 0;
}

async function refuseDirectCommand(ref: string, command: string): Promise<Exit | null> {
  const dir = resolveRunDir(ref);
  if (dir === undefined || !isDirectDir(dir)) return null;
  await reconcileDirect(dir);
  const line = readDirectStatus(dir) ?? directLiveLine(dir, readDirect(dir));
  print(line);
  process.stderr.write(`${command} is ${DIRECT_UNSUPPORTED}\n`);
  return 1;
}

async function stopDirectCommand(dir: string): Promise<Exit> {
  await reconcileDirect(dir);
  const ended = readDirectStatus(dir);
  if (ended) {
    process.stderr.write(`${STOP_NOT_APPLIED}\n`);
    print(ended);
    return ended.split(" | ")[1] === "fail" ? 1 : 0;
  }
  const meta = readDirect(dir);
  requestStop(dir, meta.nonce);
  const until = Date.now() + STOP_WAIT_MS;
  while (shouldKeepWaitingDirect(dir, Date.now()) && Date.now() < until) await sleep(200);
  if (!readDirectStatus(dir)) {
    const { forced } = await forceDirectStop(dir, meta.provider);
    if (!forced) await untilDirectEnded(dir, Date.now() + 5_000);
  }
  const final = readDirectStatus(dir);
  if (!final) {
    print(directLiveLine(dir, readDirect(dir)));
    process.stderr.write(`cleanup uncertain: stop did not prove the owner ended\n`);
    return 1;
  }
  print(final);
  const endedBy = readDirect(dir).endedBy;
  if (endedBy !== "stop" && endedBy !== "forced") process.stderr.write(`${STOP_NOT_APPLIED}\n`);
  return final.split(" | ")[1] === "fail" ? 1 : 0;
}

// Takes owner.lock on --out, so no other run starts there until this run's
// owner holds it. An --out that already holds a run, of either kind and
// ended or not, is refused, so a command or result aimed at that run never
// reaches another.
function claimOut(dir: string): void {
  const refused = new UsageError(`--out already holds a run: ${dir}. Pass a new --out.`);
  if (holdsRun(dir)) throw refused;
  const lock = ownerLock(dir);
  if (!takeOut(lock, dir)) throw new UsageError(`--out already holds a run: ${dir}. ${heldBy(lock.holder())}`);
  if (holdsRun(dir)) {
    lock.unlock();
    throw refused;
  }
}

// An --out whose lock cannot be written is one the run cannot create
function takeOut(lock: OwnerLock, dir: string): boolean {
  try {
    return lock.takeover();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === undefined) throw e;
    throw new UsageError(`cannot create --out ${dir}: ${code}`);
  }
}

// Who holds owner.lock, and how to free the directory once that holder is
// gone, since a holder that cannot be proven gone keeps it
function heldBy(holder: Holder | null): string {
  if (!holder) return "owner.lock cannot be read. Pass a new --out, or remove owner.lock once no run uses the directory.";
  const start = holder.legacy || lstartEpoch(holder.start) === null ? "" : `, started ${holder.start.split(/\s+/).join(" ")} UTC`;
  return `owner.lock names pid ${holder.pid}${start}. Pass a new --out, or remove owner.lock once pid ${holder.pid} is gone.`;
}

async function statusCommand(args: string[]): Promise<Exit> {
  const { positional, flags } = parseArgs(args, COMMAND_SHAPES.status);
  const [ref] = positional;
  if (ref && flags.has("cwd")) throw new UsageError("status takes a run or --cwd <dir>, not both");
  if (ref) {
    const dir = resolveRunDir(ref);
    if (dir !== undefined && isDirectDir(dir)) {
      await reconcileDirect(dir);
      const meta = readDirect(dir);
      print(readDirectStatus(dir) ?? directLiveLine(dir, meta));
      return readDirectStatus(dir)?.split(" | ")[1] === "fail" ? 1 : 0;
    }
    const run = openRef(ref);
    return report(run, await reconcile(run));
  }
  const cwd = flags.get("cwd");
  const within = cwd === undefined ? null : canonicalPath(cwd, process.cwd());
  const skipped: Record<RunFileProblem, string[]> = { "older-format": [], unreadable: [] };
  for (const dir of listRuns()) {
    const read = readRun(dir);
    if (read.kind !== "ok") {
      skipped[read.kind].push(dir);
      continue;
    }
    const { spec } = read.run;
    if (within !== null && !inside(spec.target, within)) continue;
    const s = await reconcile(read.run);
    // The target tells a parent its own runs from another session's
    if (isLive(s.phase)) print(`${statusLine(spec, s, Date.now())} cwd=${statusText(spec.target)}`);
  }
  for (const dir of listDirectRuns()) {
    let meta;
    try {
      meta = readDirect(dir);
    } catch {
      skipped.unreadable.push(dir);
      continue;
    }
    if (within !== null && !inside(meta.target, within)) continue;
    await reconcileDirect(dir);
    const line = readDirectStatus(dir);
    if (line) continue;
    print(`${directLiveLine(dir, readDirect(dir))} cwd=${statusText(meta.target)}`);
  }
  // Runs from before a state change stay under the root, so their count is noise on every call
  if (flags.has("verbose")) skippedNote(skipped["older-format"], "with an older state format");
  skippedNote(skipped.unreadable, "whose spec.json or state.json is missing or not JSON");
  return 0;
}

// Names the runs while the list is short enough to read
function skippedNote(dirs: string[], why: string): void {
  if (!dirs.length) return;
  const named = dirs.length <= 5 ? `: ${dirs.join(" ")}` : "";
  process.stderr.write(`skipped ${dirs.length} run${dirs.length === 1 ? "" : "s"} ${why}${named}\n`);
}

async function sendCommand(args: string[]): Promise<Exit> {
  const { positional, flags } = parseArgs(args, COMMAND_SHAPES.send);
  const now = flags.has("now");
  const [ref, text] = positional;
  const runRef = need(ref, 'send <run> [--now] "text"');
  if (!text?.trim()) throw new UsageError('send <run> [--now] "text"');
  const direct = await refuseDirectCommand(runRef, "send");
  if (direct !== null) return direct;
  const run = openRef(runRef);
  if (run.spec.nonce === undefined) return report(run, await reconcile(run), null, PREDATES_NONCES, 1);
  const id = newMsgId();
  const s0 = await reconcile(run);
  if (!isLive(s0.phase)) return report(run, s0, null, "the run has ended; start a new run with --resume <session>", 1);
  run.post({ id, kind: "send", text, now });
  // An interrupt is acknowledged only once the worker's cancel settles and the next turn starts
  const s = await waitFor(run, (st) => st.acks[id] !== undefined || !isLive(st.phase), now ? CANCEL_MS + ACK_WAIT_MS : ACK_WAIT_MS);
  const ack = s.acks[id];
  if (ack === undefined && !isLive(s.phase)) return report(run, s, null, "rejected: the run ended before the message was read", 1);
  if (ack === undefined) return report(run, s, null, "not acknowledged yet; check status", 1);
  return ack === "rejected" ? report(run, s, null, "rejected", 1) : report(run, s);
}

async function answerCommand(args: string[]): Promise<Exit> {
  const { positional, flags } = parseArgs(args, COMMAND_SHAPES.answer);
  const widen = flags.has("widen");
  const [ref, approval, verdict] = positional;
  if (!ref || !approval || (verdict !== "allow" && verdict !== "deny") || (widen && verdict !== "allow")) {
    throw new UsageError("answer <run> <req> allow|deny [--widen]");
  }
  const decision = widen ? "widen" : verdict;
  const direct = await refuseDirectCommand(ref, "answer");
  if (direct !== null) return direct;
  const run = openRef(ref);
  const s0 = await reconcile(run);
  if (run.spec.nonce === undefined) return report(run, s0, null, PREDATES_NONCES, 1);
  if (!isLive(s0.phase)) return report(run, s0, null, `the run has ended, so ${approval} is not open`, 1);
  const id = newMsgId();
  run.post({ id, kind: "answer", approval, decision });
  const s = await waitFor(run, (st) => st.acks[id] !== undefined || !isLive(st.phase), ACK_WAIT_MS);
  const ack = s.acks[id];
  if (ack === undefined && !isLive(s.phase)) return report(run, s, null, "rejected: the run ended before the answer was read", 1);
  if (ack === undefined) return report(run, s, null, "not acknowledged yet; check status", 1);
  if (ack === "rejected") {
    const why = {
      allow: `${approval} is not open or offers no allow_once; answer deny, or stop`,
      widen: `${approval} is not open or offers only bypass or global allow options; answer deny, or stop`,
      deny: `${approval} is not open`,
    }[decision];
    return report(run, s, null, why, 1);
  }
  return report(run, s);
}

async function stopCommand(args: string[]): Promise<Exit> {
  const ref = need(parseArgs(args, COMMAND_SHAPES.stop).positional[0], "stop <run>");
  const dir = resolveRunDir(ref);
  if (dir !== undefined && isDirectDir(dir)) return stopDirectCommand(dir);
  const run = openRef(ref);
  const s0 = await reconcile(run);
  if (run.spec.nonce === undefined) return report(run, s0, null, PREDATES_NONCES, 1);
  if (!isLive(s0.phase)) return report(run, s0, null, STOP_NOT_APPLIED);
  const id = newMsgId();
  run.post({ id, kind: "stop" });
  const waited = await waitFor(run, (st) => !shouldKeepWaiting(st, Date.now()), STOP_WAIT_MS);
  const { state: s, forced } = isLive(waited.phase) ? await forceStop(run) : { state: waited, forced: false };
  // A run can end on its own after the post, with the stop unread, even while stop forces it
  const applied = isLive(s.phase) || forced || s.acks[id] === "stopped";
  return report(run, s, null, applied ? "" : STOP_NOT_APPLIED);
}

function pruneCommand(args: string[]): Exit {
  const { flags } = parseArgs(args, COMMAND_SHAPES.prune);
  const olderThanMs = pruneDuration(flags.get("older-than"));
  const dryRun = flags.has("dry-run");
  const resolved = resolvePruneRoot();
  if (resolved.kind === "error") throw new UsageError(resolved.message);
  if (resolved.kind === "missing") {
    print(dryRun ? "would_delete=0 deleted=0 kept=0 failed=0" : "deleted=0 kept=0 failed=0");
    return 0;
  }
  const summary = pruneRuns({ root: resolved.root, olderThanMs, dryRun, now: Date.now() });
  let wouldDelete = 0;
  for (const decision of summary.decisions) {
    if (decision.kind === "delete") {
      wouldDelete += 1;
      print(`${dryRun ? "would delete" : "delete"} ${decision.dir}`);
    } else print(`keep ${decision.dir} ${decision.reason}`);
  }
  print(
    dryRun
      ? `would_delete=${wouldDelete} deleted=0 kept=${summary.kept} failed=0`
      : `deleted=${summary.deleted} kept=${summary.kept} failed=${summary.failed}`,
  );
  if (dryRun || summary.failed === 0) return 0;
  for (const decision of summary.decisions) {
    if (decision.kind === "keep" && decision.reason === "remove failed") process.stderr.write(`cannot remove ${decision.dir}\n`);
  }
  return 1;
}

async function resultCommand(args: string[]): Promise<Exit> {
  const { positional, flags } = parseArgs(args, COMMAND_SHAPES.result);
  const ref = need(positional[0], "result <run> [--wait [--timeout <seconds>]] [--quiet]");
  if (flags.has("timeout") && !flags.has("wait")) throw new UsageError("--timeout applies only to --wait");
  const quiet = flags.has("quiet");
  const timeoutMs = flags.has("timeout") ? positiveInt(flags.get("timeout"), "--timeout") * 1_000 : null;
  // A runner has no owner to report its end, so its wait stops when the
  // runner dies, or at the engine's default deadline
  const runnerUntil = flags.has("wait") ? Date.now() + (timeoutMs ?? DEFAULT_DEADLINE_MS) : Date.now();
  const dir = resolveRunDir(ref);
  if (dir !== undefined && isDirectDir(dir)) {
    if (flags.has("wait")) await untilDirectEnded(dir, runnerUntil);
    else await reconcileDirect(dir);
    const final = readDirectStatus(dir);
    const meta = readDirect(dir);
    const line = final ?? directLiveLine(dir, meta);
    const failed = (final ?? "").split(" | ")[1] === "fail";
    if (quiet || (flags.has("wait") && !final)) {
      print(line);
      return failed ? 1 : 0;
    }
    printRun(line, directAnswerText(dir, failed));
    return failed ? 1 : 0;
  }
  const runner = await runnerResult(ref, quiet, runnerUntil);
  if (runner !== null) return runner;
  const run = openRef(ref);
  const s = flags.has("wait") ? await untilEnded(run, Date.now() + (timeoutMs ?? Number.POSITIVE_INFINITY)) : await reconcile(run);
  return quiet || (flags.has("wait") && isLive(s.phase)) ? report(run, s) : reportWithAnswer(run, s);
}

// A Codex or Cursor run directory: no spec.json, a prompt.md from the start,
// and the runner's final line in status once it ends. Until then it prints a
// running line, after waiting for status until `until`, or a fail line once
// the runner is gone. null for anything else, which openRef then reports.
async function runnerResult(ref: string, quiet: boolean, until: number): Promise<Exit | null> {
  const dir = [path.resolve(ref), path.join(outRoot(), ref)].find((d) =>
    ["spec.json", "status", "prompt.md"].some((name) => fs.existsSync(path.join(d, name))),
  );
  if (dir === undefined || fs.existsSync(path.join(dir, "spec.json")) || isDirectDir(dir)) return null;
  for (;;) {
    const final = runnerFinal(dir, quiet) ?? died(dir, quiet);
    if (final !== null) {
      printRun(final.line, final.text);
      return final.failed ? 1 : 0;
    }
    if (Date.now() >= until) {
      print(`[- | running | - | no final line yet | session=- | out=${statusText(dir)}]`);
      return 0;
    }
    await sleep(1_000);
  }
}

// A runner whose pid is gone and that wrote no status never will. Nor will
// one that wrote neither: a runner writes runner.pid before prompt.md, so a
// directory without it came from a runner older than runner.pid. status is
// checked after the pid, since a runner writes it just before it exits. The
// runner is named when its default directory name says which it was.
function died(dir: string, quiet: boolean): { line: string; text: string | null; failed: boolean } | null {
  const runner = runnerAlive(dir);
  if (runner === true || fs.existsSync(path.join(dir, "status"))) return null;
  const cli = /^(codex|cursor)-/.exec(path.basename(dir))?.[1] ?? "-";
  const detail = runner === false ? "runner died" : "older runner wrote no final line";
  const text = quiet ? null : answerText((name) => path.join(dir, name), true);
  return { line: `[${cli} | fail | - | ${detail} | session=- | out=${statusText(dir)}]`, text, failed: true };
}

// The runner's final line and the answer beside it, or null until the
// runner writes status, which it does last
function runnerFinal(dir: string, quiet: boolean): { line: string; text: string | null; failed: boolean } | null {
  const line = statusText((readIfPresent(path.join(dir, "status")) ?? "").split("\n")[0] ?? "").trim();
  if (!line) return null;
  const failed = line.split(" | ")[1] === "fail";
  return { line, text: quiet ? null : answerText((name) => path.join(dir, name), failed), failed };
}

async function untilEnded(run: Run, until: number): Promise<RunState> {
  let s = await reconcile(run);
  while (isLive(s.phase) && Date.now() < until) {
    await sleep(1_000);
    s = await reconcile(run);
  }
  return s;
}

// The line and the answer of one state. A live run can end while its
// answer is read, so a state that reads the same on both sides of that read
// means the line and the answer agree.
function reportWithAnswer(run: Run, s: RunState): Exit {
  for (;;) {
    const text = body(run, s);
    const state = run.state();
    if (JSON.stringify(state) === JSON.stringify(s)) return report(run, s, text);
    s = state;
  }
}

// Line, blank line, then the answer
function body(run: Run, s: RunState): string {
  const failed = s.phase.kind === "ended" && s.phase.outcome === "fail";
  return [answerText(run.file, failed), earlierTurns(s.turns)].filter(Boolean).join("\n\n");
}

// The answer; a fail with none shows the stderr tail, as the runners do
function answerText(file: (name: string) => string, failed: boolean): string {
  const read = (name: string) => readIfPresent(file(name)) ?? "";
  const answer = read("answer.md");
  if (!failed || answer.trim()) return answer.trimEnd();
  return read("stderr.log").trimEnd().split("\n").slice(-20).join("\n");
}

// null for a missing file
function readIfPresent(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

function report(run: Run, s: RunState, answer: string | null = null, note = "", code?: Exit): Exit {
  printRun(statusLine(run.spec, s, Date.now()), answer);
  if (note) process.stderr.write(`${note}\n`);
  return code ?? (s.phase.kind === "ended" && s.phase.outcome === "fail" ? 1 : 0);
}

// The line, then with an answer a blank line and its body, which may be empty
function printRun(line: string, answer: string | null): void {
  print(line);
  if (answer !== null) print(answer ? `\n${answer.trimEnd()}` : "");
}

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function waitFor(run: Run, done: (s: RunState) => boolean, ms: number): Promise<RunState> {
  const until = Date.now() + ms;
  let s = run.state();
  while (!done(s) && Date.now() < until) {
    await sleep(200);
    s = await reconcile(run);
  }
  return s;
}

// Flags may come before or after the positional arguments. A repeated
// boolean flag is harmless, because a forwarding agent may append one the
// request has. A repeated valued flag is refused, so no value silently wins.
function parseArgs(
  args: string[],
  shape: {
    positional: number;
    booleans?: readonly string[];
    valued?: readonly string[];
    unexpected?: (arg: string) => string;
    valuePrefix?: string;
  },
): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  const valuePrefix = shape.valuePrefix ?? "--";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const name = arg.startsWith("--") ? arg.slice(2) : null;
    if (name !== null && shape.booleans?.includes(name)) {
      flags.set(name, "");
    } else if (name !== null && shape.valued?.includes(name)) {
      // A value that starts with -- is the next flag, so `--model --wait` has no model.
      // Codex also refuses a value that starts with -, matching its old runner.
      const value = args[++i];
      if (!value || value.startsWith(valuePrefix)) throw new UsageError(`${arg} needs a value`, flags);
      if (flags.has(name)) throw new UsageError(`${arg} is given more than once`, flags);
      flags.set(name, value);
    } else if (positional.length < shape.positional) {
      positional.push(arg);
    } else {
      const why = name !== null && shape.unexpected ? shape.unexpected(arg) : `unexpected argument ${arg}\n${USAGE}`;
      throw new UsageError(why, flags);
    }
  }
  return { positional, flags };
}

function openRef(ref: string): Run {
  try {
    return openRun(ref);
  } catch (e) {
    if (e instanceof RunFileError) throw e;
    throw new UsageError(`usage: not a run directory: ${ref}`);
  }
}

function need(value: string | undefined, what: string): string {
  if (!value) throw new UsageError(`missing ${what}\n${USAGE}`);
  return value;
}

function positiveInt(value: string | undefined, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`${flag} must be a positive integer`);
  return n;
}

function duration(value: string | undefined): number {
  const m = /^(\d+)(s|m|h)?$/.exec(value ?? "");
  if (!m) throw new UsageError("--deadline takes a duration such as 90s, 45m, or 2h");
  const unit = { s: 1_000, m: 60_000, h: 3_600_000 }[(m[2] ?? "s") as "s" | "m" | "h"];
  return Number(m[1]) * unit;
}

function pruneDuration(value: string | undefined): number {
  const m = /^(\d+)(s|m|h|d)$/.exec(value ?? "");
  if (!m) throw new UsageError("--older-than takes a positive duration such as 7d, 12h, 30m, or 90s");
  const n = Number(m[1]);
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
  const ms = n * unit;
  if (!Number.isSafeInteger(n) || n < 1 || !Number.isSafeInteger(ms) || ms < 1) {
    throw new UsageError("--older-than takes a positive duration such as 7d, 12h, 30m, or 90s");
  }
  return ms;
}

function realDirectory(dir: string): boolean {
  try {
    return fs.lstatSync(dir).isDirectory();
  } catch {
    return false;
  }
}

// Keeps only absolute PATH entries for the engine's own commands. A child
// resolves an empty or relative entry from its own cwd, so git in the
// target would run whatever the target holds. The worker gets the caller's
// PATH back through DELEGATE_WORKER_PATH, since its entries are the
// caller's choice.
function absolutePath(): void {
  if (process.env.PATH !== undefined && process.env.DELEGATE_WORKER_PATH === undefined) process.env.DELEGATE_WORKER_PATH = process.env.PATH;
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter((dir) => path.isAbsolute(dir));
  // An empty PATH searches the cwd too, so none at all is left unset
  if (dirs.length) process.env.PATH = dirs.join(path.delimiter);
  else delete process.env.PATH;
}

// The first executable file named command on the engine's absolute PATH
function findExecutable(command: string): string | null {
  for (const dir of process.env.PATH?.split(path.delimiter) ?? []) {
    const file = path.join(dir, command);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {
      // not here
    }
  }
  return null;
}

// A caller that quotes every flag value, as the plugin agents do, leaves a
// leading ~/ for the engine to expand
function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

function gitTopLevel(dir: string): string | null {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

// The sandboxes leave the temp dir writable, and a worker can write its own
// workspace, so the run directory stays out of both, and the target out of it.
// defaultRoot is the run root when --out was not given.
function checkPaths(preset: Preset, out: string, root: string, target: string, defaultRoot: string | null): void {
  const temps = [process.env.TMPDIR, "/tmp", os.tmpdir(), darwinTemp()].flatMap((t) => {
    try {
      return t ? [fs.realpathSync.native(t)] : [];
    } catch {
      return [];
    }
  });
  const guarded = preset === "read" ? [out, target] : [out];
  for (const temp of temps) {
    for (const p of guarded) {
      if (inside(p, temp)) throw new UsageError(`${p} is in ${temp}, which the sandbox leaves writable. Use a path outside the temp dir.`);
    }
  }
  if (inside(out, root) && defaultRoot !== null) {
    throw new UsageError(
      `--cwd puts the worker in ${root}, which contains ${defaultRoot}, where run directories go. ` +
        "Pass --cwd the repo or scratch directory the task is about, not a directory above it. Do not add --out to get around this.",
    );
  }
  if (inside(out, root)) throw new UsageError(`--out must be outside ${root}, because the worker can write there`);
  if (inside(target, out)) throw new UsageError(`--cwd must be outside --out ${out}, because the worker can write there`);
}

function darwinTemp(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    return execFileSync("getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

function inside(p: string, root: string): boolean {
  return p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

// what names the flag the directory came from, so a failure, such as a file
// or a dangling link in its place, is the caller's usage error
function ensureDir(dir: string, what?: string): string {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    if (what === undefined) throw e;
    throw new UsageError(`cannot create ${what} ${dir}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
  return dir;
}

function stamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// import.meta.main needs Node 24; this also works on 22.18
if (process.argv[1] && fs.realpathSync(process.argv[1]) === import.meta.filename) {
  process.exitCode = await main(process.argv.slice(2));
}
