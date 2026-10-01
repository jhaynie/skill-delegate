import { execFileSync, spawn, type ChildProcess, type StdioOptions } from "node:child_process";

const GRACE_MS = 3_000;

// A new session and process group, so the whole tree can be signalled by
// its pgid and it outlives the caller
export function spawnDetached(
  argv: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; stdio: StdioOptions },
): ChildProcess {
  const [command, ...args] = argv;
  if (!command) throw new Error("spawnDetached needs a command");
  return spawn(command, args, { ...opts, detached: true });
}

// Only ESRCH proves pid gone. EPERM, or an error kill should never give,
// leaves it possibly alive.
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

// ps's lstart in C, "Thu Jan  1 00:00:00 2026". Date.parse alone would read
// text such as "garbage 12" as a date.
const LSTART = /^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;

// First character is the run state (Z is zombie). Later characters are
// documented modifiers on Linux and Darwin. A word such as Zombies is not.
export const PS_STATE = /^[DIRSTUWZXdit][AELNSVWXsl+<>]*$/;

// An lstart read in C and UTC, in epoch seconds, or null for any other text.
// A runner records its lstart with the day's padding collapsed, so the
// number, not the text, says whether two starts match.
export function lstartEpoch(lstart: string | null): number | null {
  const ms = lstart !== null && LSTART.test(lstart) ? Date.parse(`${lstart} UTC`) : Number.NaN;
  return Number.isNaN(ms) ? null : ms / 1000;
}

// One ps read of pid, state, and lstart. Failed, empty, or unparseable
// output is null, which liveness treats as unknown, not death.
function inspect(pid: number): { start: string; state: string } | null {
  let raw: string;
  try {
    raw = execFileSync("ps", ["-o", "pid=,stat=,lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
  const m = raw.match(/^(\d+)\s+(\S+)\s+(.*)$/);
  if (m === null) return null;
  const pidText = m[1];
  const state = m[2];
  const rest = m[3];
  if (pidText === undefined || state === undefined || rest === undefined) return null;
  if (Number(pidText) !== pid || !PS_STATE.test(state)) return null;
  const start = rest.trim();
  if (lstartEpoch(start) === null) return null;
  return { start, state };
}

function defunct(state: string): boolean {
  return state.startsWith("Z");
}

// ps start time, so a recycled pid never passes for the recorded process.
// ps formats it in the caller's locale and zone, so every reader asks for C
// and UTC, and gets the string the writer recorded.
export function startTime(pid: number): string | null {
  return inspect(pid)?.start ?? null;
}

// For signalling: pid is still the recorded process. A zombie keeps that
// identity, so its process group can be signalled even though it cannot run.
export function sameProcess(pid: number, start: string | undefined): boolean {
  if (start === undefined || !alive(pid)) return false;
  const seen = inspect(pid);
  return seen !== null && seen.start === start;
}

// For liveness: pid may still be the process that started at start, in
// epoch seconds, or at a time no reader knows when start is null. Only proof
// ends it: the pid is gone, ps reads a state that starts with Z, or ps reads
// it with another start time. A ps that fails, or whose state or lstart
// does not parse, proves nothing, so a live process is never taken for dead.
export function mayBeRunningSince(pid: number, start: number | null): boolean {
  if (!alive(pid)) return false;
  const seen = inspect(pid);
  if (seen !== null && defunct(seen.state)) return false;
  if (start === null || seen === null) return true;
  const now = lstartEpoch(seen.start);
  return now === null || now === start;
}

// mayBeRunningSince for an owner.lock holder. A legacy start, from an engine
// before the C and UTC reads, is in its writer's locale and zone, which no
// reader can know, so only a gone pid or a proven zombie ends that holder.
export function mayBeRunning(pid: number, start: string, legacy: boolean): boolean {
  return mayBeRunningSince(pid, legacy ? null : lstartEpoch(start));
}

// kill 0 succeeds for a zombie. A readable Z state is proof the process
// cannot run. Failed or unparseable ps stays executing.
export function executing(pid: number): boolean {
  return mayBeRunningSince(pid, null);
}

// Group members plus every descendant of roots, found by walking ppid.
// Take it before the root exits, because orphans lose their ppid link.
export function tree(pgid: number, roots: number[]): number[] {
  const table = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number) as [number, number, number]);
  const found = new Set(roots);
  for (const [pid, , group] of table) if (group === pgid) found.add(pid);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, ppid] of table) {
      if (found.has(ppid) && !found.has(pid)) {
        found.add(pid);
        grew = true;
      }
    }
  }
  found.delete(process.pid);
  return [...found];
}

// SIGTERM the group and the recorded pids, SIGKILL whatever is left after
// the grace. Returns how many were still alive when called.
export async function killTree(pgid: number, pids: number[]): Promise<number> {
  if (pgid <= 1) throw new Error(`refusing to signal process group ${pgid}`);
  const living = pids.filter(alive);
  signal(-pgid, "SIGTERM");
  for (const pid of living) signal(pid, "SIGTERM");
  const until = Date.now() + GRACE_MS;
  while (Date.now() < until && living.some(alive)) await sleep(100);
  signal(-pgid, "SIGKILL");
  for (const pid of living.filter(alive)) signal(pid, "SIGKILL");
  return living.length;
}

export function describe(pids: number[]): string {
  try {
    return execFileSync("ps", ["-o", "pid=,command=", "-p", pids.join(",")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim()
      .split("\n")
      .map((line) => line.trim().slice(0, 120))
      .join("; ");
  } catch {
    return pids.join(",");
  }
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // already gone
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
