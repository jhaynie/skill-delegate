import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { alive, lstartEpoch, PS_STATE } from "./procs.ts";

// The Cursor run's private supervisor. cursor.ts starts it detached, so it
// leads a session and process group of its own, and the worker it launches
// joins that group. It notes the worker's descendants while the worker runs,
// and when the worker exits, the owner stops it, or the owner dies, it stops
// the group, every noted process that left it, and every process that holds
// the run's output files open for writing, then waits a bounded time to see
// them exit. Only then does it exit, so while it signals the group, no other
// group can have that id.
//
// Owner, supervisor, and worker:
//   owner --launch--> supervisor --spawn--> cursor-agent (same group)
//   owner <--started, unstarted, done-- supervisor
// The owner stops a run with SIGTERM to the supervisor's pid, which it may
// signal until it sees the supervisor exit. The supervisor sees the owner die
// through the IPC channel closing and through its parent pid changing, and
// neither check starts a process, so a scan that hangs cannot hide it.
// Node opens its IPC channel and files close-on-exec, so no worker process
// inherits the channel and keeps it open after the owner is gone.

const NOTE_MS = 500;
const PS_MS = 3_000;
const SCAN_MS = 5_000;
// As long as procs.ts killTree's grace
const CONFIRM_MS = 3_000;
const LAUNCH_WAIT_MS = 10_000;
const OWNER_POLL_MS = 1_000;
const REPORT_FLUSH_MS = 1_000;

export const NO_PROCESS_LIST = "cannot list processes, so only the worker's group was stopped";
export const NO_WRITER_LIST = "cannot list what holds the run's files, so a worker process that left no trail may still run";

export type Launch = {
  kind: "launch";
  argv: [string, ...string[]];
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  stdout: string;
  stderr: string;
};

export type Report =
  | { kind: "started"; workerPid: number }
  | { kind: "unstarted"; reason: string }
  // leftover is how many processes cleanup found besides the supervisor.
  // Each note says why cleanup proved less than it should, so any note
  // leaves it uncertain whether a worker process still runs.
  | { kind: "done"; exitCode: number | null; leftover: number; notes: string[] };

// One ps row. start is the second the process started, from lstart in C and UTC.
export type Proc = { pid: number; ppid: number; pgid: number; start: number };

// The supervisor's own ps and lsof calls, as pid to the second each was
// spawned. They and anything they start are the supervisor's, not the
// worker's. One that exits while a listing runs is still in that listing,
// so an entry outlives its process, and a later process with its pid has a
// later start.
export type Helpers = Map<number, number>;

const C_UTC = { LC_ALL: "C", TZ: "UTC" };

// A row whose start does not parse names no process a later note can
// confirm, so it is left out
export function parseTable(text: string): Proc[] {
  const rows: Proc[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*?)\s*$/.exec(line);
    const start = m ? lstartEpoch(m[4] ?? null) : null;
    if (m && start !== null) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), start });
  }
  return rows;
}

// Every process in the leader's group, every noted process that still has
// the start it was noted with, and every descendant of either, as pid to
// start. A worker that calls setsid leaves the group, and once its parent
// exits no walk from the group finds it, so each note keeps walking from
// the last. A recycled pid has another start and brings in nothing. The
// leader and the helpers' trees are left out.
export function noteTree(table: readonly Proc[], leader: number, seen: ReadonlyMap<number, number>, helpers: ReadonlyMap<number, number>): Map<number, number> {
  const pids = (keep: (p: Proc) => boolean) => table.filter(keep).map((p) => p.pid);
  const found = withDescendants(table, pids((p) => p.pgid === leader || seen.get(p.pid) === p.start));
  // A process starts in the second it was spawned or, across a second's edge, the next
  const mine = withDescendants(table, pids((p) => [0, 1].includes(p.start - (helpers.get(p.pid) ?? Number.NaN))));
  return new Map(table.filter((p) => found.has(p.pid) && !mine.has(p.pid) && p.pid !== leader).map((p) => [p.pid, p.start]));
}

function withDescendants(table: readonly Proc[], roots: Iterable<number>): Set<number> {
  const found = new Set(roots);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of table) {
      if (found.has(p.ppid) && !found.has(p.pid)) {
        found.add(p.pid);
        grew = true;
      }
    }
  }
  return found;
}

// Every process that has one of files open for writing and started no
// earlier than the second the leader started, as pid to start, so a writer
// that predates the run is left out. holder has each file open for reading
// and must show up on each, or the scan proved nothing about that file. null
// when nothing can be proved: no /proc and no lsof, a nonzero lsof or ps, a
// holder missing from any file, a missing leader, or a scan past its
// deadline. Linux reads /proc and needs no other tool.
export async function fileWriters(
  files: readonly string[],
  holder: number,
  leader: number,
  env: NodeJS.ProcessEnv,
  helpers: Helpers = new Map(),
): Promise<Map<number, number> | null> {
  const deadline = Date.now() + SCAN_MS;
  const left = () => deadline - Date.now();
  let found: { holders: Set<number>[]; writers: Set<number> } | null;
  if (fs.existsSync("/proc/self/fd")) {
    found = await procWriters(files, left);
  } else {
    found = { holders: [], writers: new Set() };
    for (const file of files) {
      // lsof exits 1 when a file has no holder. holder holds the file, so a
      // healthy lsof exits 0 and any other exit proves nothing.
      const lsof = await capture("lsof", ["-w", "-F", "pa", "--", file], env, left(), helpers);
      if (lsof === null || lsof.code !== 0) return null;
      const holders = new Set<number>();
      let pid: number | null = null;
      for (const line of lsof.stdout.split("\n")) {
        if (line.startsWith("p")) {
          pid = Number(line.slice(1));
          holders.add(pid);
        } else if ((line === "aw" || line === "au") && pid !== null) {
          found.writers.add(pid);
        }
      }
      found.holders.push(holders);
    }
  }
  if (found === null || !found.holders.every((holders) => holders.has(holder)) || left() <= 0) return null;
  // ps exits 1 when any pid is gone, and then its rows prove nothing either
  const ps = await startsOf([leader, ...found.writers], env, left(), helpers);
  if (ps === null || ps.code !== 0) return null;
  const since = ps.starts.get(leader);
  if (since === undefined) return null;
  return new Map([...ps.starts].filter(([pid, start]) => found.writers.has(pid) && start >= since).sort(([a], [b]) => a - b));
}

async function procWriters(files: readonly string[], left: () => number): Promise<{ holders: Set<number>[]; writers: Set<number> } | null> {
  const targets = new Map<string, number>();
  const holders = files.map(() => new Set<number>());
  for (const [i, file] of files.entries()) {
    const st = await fs.promises.stat(file, { bigint: true }).catch(() => null);
    if (st) targets.set(`${st.dev}:${st.ino}`, i);
  }
  const writers = new Set<number>();
  for (const pid of (await fs.promises.readdir("/proc")).filter((name) => /^\d+$/.test(name))) {
    if (left() <= 0) return null;
    const fds = await fs.promises.readdir(`/proc/${pid}/fd`).catch(() => [] as string[]);
    for (const fd of fds) {
      if (left() <= 0) return null;
      const st = await fs.promises.stat(`/proc/${pid}/fd/${fd}`, { bigint: true }).catch(() => null);
      const i = st ? targets.get(`${st.dev}:${st.ino}`) : undefined;
      if (i === undefined) continue;
      const info = await fs.promises.readFile(`/proc/${pid}/fdinfo/${fd}`, "utf8").catch(() => null);
      if (info === null) continue;
      holders[i]?.add(Number(pid));
      const flags = /^flags:\s*([0-7]+)/m.exec(info)?.[1];
      // O_WRONLY or O_RDWR
      if (flags !== undefined && (Number.parseInt(flags, 8) & 3) !== 0) writers.add(Number(pid));
    }
  }
  return { holders, writers };
}

// ps's exit code and the start of each pid it printed, or null when ps
// cannot run in ms
async function startsOf(pids: readonly number[], env: NodeJS.ProcessEnv, ms: number, helpers: Helpers): Promise<{ code: number; starts: Map<number, number> } | null> {
  const ps = await capture("ps", ["-o", "pid=,lstart=", "-p", pids.join(",")], { ...env, ...C_UTC }, ms, helpers);
  if (ps === null) return null;
  const starts = new Map<number, number>();
  for (const line of ps.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\S.*?)\s*$/.exec(line);
    const start = m ? lstartEpoch(m[2] ?? null) : null;
    if (m && start !== null) starts.set(Number(m[1]), start);
  }
  return { code: ps.code, starts };
}

// pid, run state, and start second, or null when ps cannot run, times out,
// or exits nonzero. A failed batch proves nothing.
async function statesOf(
  pids: readonly number[],
  env: NodeJS.ProcessEnv,
  ms: number,
  helpers: Helpers,
): Promise<Map<number, { state: string; start: number }> | null> {
  if (!pids.length) return new Map();
  const ps = await capture("ps", ["-o", "pid=,stat=,lstart=", "-p", pids.join(",")], { ...env, ...C_UTC }, ms, helpers);
  if (ps === null || ps.code !== 0) return null;
  const rows = new Map<number, { state: string; start: number }>();
  for (const line of ps.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)\s+(\S.*?)\s*$/.exec(line);
    const start = m ? lstartEpoch(m[3] ?? null) : null;
    const state = m?.[2];
    if (m && start !== null && state !== undefined && PS_STATE.test(state)) rows.set(Number(m[1]), { state, start });
  }
  return rows;
}

// ESRCH ends it. A readable Z or a different start ends it. A missing or
// unparseable row for a pid that still exists stays unknown and live.
function stillPresent(pid: number, expectedStart: number | undefined, rows: Map<number, { state: string; start: number }> | null): boolean {
  if (!alive(pid)) return false;
  if (rows === null) return true;
  const row = rows.get(pid);
  if (row === undefined) return true;
  if (row.start !== expectedStart) return false;
  return !row.state.startsWith("Z");
}

// pid's lstart in C and UTC as ps prints it, the text procs.ts startTime
// gives, or null when ps cannot tell within its deadline
export async function processStart(pid: number): Promise<string | null> {
  const ps = await capture("ps", ["-o", "lstart=", "-p", String(pid)], { ...process.env, ...C_UTC }, PS_MS, new Map());
  return (ps?.code === 0 && ps.stdout.trim()) || null;
}

// A command's exit code and stdout, or null when it cannot start or runs
// past ms, in which case it gets SIGKILL. It is the supervisor's own helper,
// so no cleanup policy applies to it.
function capture(command: string, args: string[], env: NodeJS.ProcessEnv, ms: number, helpers: Helpers): Promise<{ code: number; stdout: string } | null> {
  if (ms <= 0) return Promise.resolve(null);
  // spawn throws for some errors, such as EPERM, and emits the rest
  let child: ChildProcess;
  try {
    child = spawn(command, args, { env, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return Promise.resolve(null);
  }
  const { pid } = child;
  if (pid === undefined) return new Promise((resolve) => child.once("error", () => resolve(null)));
  helpers.set(pid, Math.floor(Date.now() / 1_000));
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(null);
    }, ms);
    let settled = false;
    const settle = (result: { code: number; stdout: string } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let stdout = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.on("error", () => settle(null));
    child.on("close", (code) => settle(code === null ? null : { code, stdout }));
  });
}

async function processTable(helpers: Helpers): Promise<Proc[] | null> {
  const ps = await capture("ps", ["-A", "-o", "pid=,ppid=,pgid=,lstart="], { ...process.env, ...C_UTC }, PS_MS, helpers);
  if (ps === null || ps.code !== 0) return null;
  const table = parseTable(ps.stdout);
  return table.length ? table : null;
}

// The found processes still alive with the start they were found with once
// CONFIRM_MS has passed since their SIGTERM. Cleanup sends TERM and nothing
// harder, so one that ignores it keeps running and cleanup says so. A live
// pid ps cannot account for counts as still running.
async function stillRunning(found: ReadonlyMap<number, number>, helpers: Helpers): Promise<number[]> {
  const deadline = Date.now() + CONFIRM_MS;
  const left = () => deadline - Date.now();
  let living = [...found.keys()];
  while (living.length && left() > 0) {
    const rows = await statesOf(living, process.env, left(), helpers);
    living = living.filter((pid) => stillPresent(pid, found.get(pid), rows));
    if (!living.length || left() <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return living;
}
function parseLaunch(message: unknown): Launch | null {
  if (typeof message !== "object" || message === null || !("kind" in message) || message.kind !== "launch") return null;
  const m = message as Record<string, unknown>;
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
  const { argv, cwd, env, stdin, stdout, stderr } = m;
  if (!strings(argv) || argv[0] === undefined) return null;
  if (typeof env !== "object" || env === null || !strings(Object.values(env))) return null;
  if (typeof cwd !== "string" || typeof stdin !== "string" || typeof stdout !== "string" || typeof stderr !== "string") return null;
  return { kind: "launch", argv: [argv[0], ...argv.slice(1)], cwd, env: env as Record<string, string>, stdin, stdout, stderr };
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // already gone
  }
}

function errorCode(e: unknown): string {
  return (e as NodeJS.ErrnoException).code ?? (e as Error).message;
}

function exitCodeOf(code: number | null, sig: NodeJS.Signals | null): number | null {
  if (code !== null) return code;
  const number = sig === null ? undefined : os.constants.signals[sig];
  return number === undefined ? null : 128 + number;
}

async function supervise(): Promise<void> {
  const owner = process.ppid;
  const leader = process.pid;
  const helpers: Helpers = new Map();
  let seen = new Map<number, number>();
  let worker: ChildProcess | null = null;
  let workerEnded = Promise.resolve();
  let launch: Launch | null = null;
  let exitCode: number | null = null;
  let noting: NodeJS.Timeout | undefined;
  let stopping = false;

  // A report to an owner that is gone is dropped, and then runs at once
  const report = (r: Report, then: () => void) => {
    if (!process.connected || !process.send) return then();
    const fallback = setTimeout(then, REPORT_FLUSH_MS);
    process.send(r, () => {
      clearTimeout(fallback);
      then();
    });
  };

  // Before a worker starts there is nothing to clean up
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (worker === null) process.exit(0);
    void cleanUp();
  };
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, stop);
  process.on("disconnect", stop);
  setInterval(() => {
    if (process.ppid !== owner) stop();
  }, OWNER_POLL_MS);

  const cleanUp = async () => {
    clearInterval(noting);
    const notes: string[] = [];
    const workerGone = await Promise.race([workerEnded.then(() => true), Promise.resolve(false)]);
    const table = await processTable(helpers);
    if (table) seen = noteTree(table, leader, seen, helpers);
    else notes.push(NO_PROCESS_LIST);
    const held = launch ? [launch.stdout, launch.stderr] : [];
    const writers = await fileWriters(held, leader, leader, process.env, helpers);
    if (writers === null) notes.push(NO_WRITER_LIST);
    const found = new Map([...(writers ?? []), ...seen]);
    found.delete(leader);
    const leftoverRows = found.size ? await statesOf([...found.keys()], process.env, Math.min(PS_MS, 1_000), helpers) : new Map();
    const leftover = [...found.keys()].filter((pid) => {
      if (workerGone && pid === worker?.pid) return false;
      return stillPresent(pid, found.get(pid), leftoverRows);
    }).length;
    // No other group can have this id while its leader, this process, runs.
    // This signals the supervisor too, which is handled as a stop already under way.
    signal(-leader, "SIGTERM");
    // A pid can be reused while the scans run, so each one gets a signal only
    // while ps still gives it the start it was found with. That narrows the
    // window, but a pid reused between ps and kill still gets it. A failed
    // identity read does not authorize a signal from a saved pid.
    const now = found.size ? await startsOf([...found.keys()], process.env, PS_MS, helpers) : null;
    for (const [pid, start] of found) if (now?.starts.get(pid) === start) signal(pid, "SIGTERM");
    // The worker is this process's child, so its pid stays its own until it
    // is reaped, even when no scan could name it
    const [running, workerExited] = await Promise.all([
      stillRunning(found, helpers),
      Promise.race([workerEnded.then(() => true), new Promise<boolean>((resolve) => setTimeout(resolve, CONFIRM_MS, false))]),
    ]);
    const lingering = new Set(running);
    if (!workerExited && worker?.pid !== undefined) lingering.add(worker.pid);
    if (lingering.size) notes.push(`still running ${CONFIRM_MS / 1_000} s after SIGTERM: ${[...lingering].join(" ")}`);
    report({ kind: "done", exitCode, leftover, notes }, () => process.exit(0));
  };

  launch = await new Promise<Launch | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), LAUNCH_WAIT_MS);
    process.once("message", (m) => {
      clearTimeout(timer);
      resolve(parseLaunch(m));
    });
  });
  if (launch === null) process.exit(1);

  let fds: number[];
  try {
    // Read ends stay open for the writer scan, which must find this process on both
    fds = [fs.openSync(launch.stdin, "r"), fs.openSync(launch.stdout, "w"), fs.openSync(launch.stderr, "w")];
    fs.openSync(launch.stdout, "r");
    fs.openSync(launch.stderr, "r");
  } catch (e) {
    return report({ kind: "unstarted", reason: `cannot open the worker's files: ${errorCode(e)}` }, () => process.exit(1));
  }
  const [command, ...args] = launch.argv;
  const unstarted = (e: unknown) => report({ kind: "unstarted", reason: `cannot start ${command}: ${errorCode(e)}` }, () => process.exit(1));
  let child: ChildProcess;
  try {
    child = spawn(command, args, { cwd: launch.cwd, env: launch.env, stdio: fds });
  } catch (e) {
    return unstarted(e);
  } finally {
    for (const fd of fds) fs.closeSync(fd);
  }
  if (child.pid === undefined) {
    child.once("error", unstarted);
    return;
  }
  worker = child;
  workerEnded = new Promise((resolve) => child.once("exit", () => resolve()));
  child.on("exit", (code, sig) => {
    exitCode = exitCodeOf(code, sig);
    stop();
  });
  report({ kind: "started", workerPid: child.pid }, () => {});

  let busy = false;
  const note = async () => {
    if (busy || stopping) return;
    busy = true;
    const table = await processTable(helpers);
    if (table && !stopping) seen = noteTree(table, leader, seen, helpers);
    busy = false;
  };
  noting = setInterval(note, NOTE_MS);
  void note();
}

// import.meta.main needs Node 24; this also works on 22.18
if (process.argv[1] && fs.realpathSync(process.argv[1]) === import.meta.filename) await supervise();
