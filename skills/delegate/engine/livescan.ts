import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { alive, PS_STATE } from "./procs.ts";

export type LiveProc = { readonly pid: number; readonly pgid: number };

export type LiveSnapshot = {
  readonly kind: "ok";
  readonly procs: ReadonlyMap<number, LiveProc>;
  readonly paths: ReadonlyMap<number, readonly string[]>;
};

export type ScanFailure = { readonly kind: "failed"; readonly detail: string };
export type LiveScan = LiveSnapshot | ScanFailure;

export type Occupant =
  | { kind: "path"; pid: number; path: string }
  | { kind: "group"; pid: number; pgid: number };

export function takeSnapshot(): LiveScan {
  try {
    const ps = command("ps", ["-A", "-o", "pid=,pgid=,uid=,stat="]);
    if (ps.error) return failed(`ps: ${ps.error.message}`);
    if (ps.status !== 0) return failed(`ps exited ${ps.status ?? ps.signal}`);
    const procs = parsePs(ps.stdout);
    if (procs === null) return failed("ps output is unparseable");
    const lsof = command("lsof", ["-n", "-P", "-Fpfn"]);
    if (lsof.error) return failed(`lsof: ${lsof.error.message}`);
    if (lsof.status !== 0) return failed(`lsof exited ${lsof.status ?? lsof.signal}`);
    const files = parseLsof(lsof.stdout);
    if (files === null) return failed(`lsof output is unparseable (exit ${lsof.status ?? lsof.signal})`);
    const cwd = fs.realpathSync.native(process.cwd());
    if (!procs.has(process.pid) || files.cwds.get(process.pid) !== cwd) {
      return failed("snapshot does not contain this process with its cwd");
    }
    const uid = process.getuid();
    for (const proc of procs.values()) {
      // lsof skips zombies, which hold no files, and a pid may exit between ps and lsof.
      if (proc.uid === uid && !proc.state.startsWith("Z") && !files.paths.has(proc.pid) && alive(proc.pid)) {
        return failed(`lsof did not report live user process ${proc.pid}`);
      }
    }
    const live = new Map<number, LiveProc>();
    for (const { pid, pgid, state } of procs.values()) {
      if (!state.startsWith("Z")) live.set(pid, { pid, pgid });
    }
    return { kind: "ok", procs: live, paths: files.paths };
  } catch (e) {
    return failed((e as Error).message);
  }
}

export function occupantOf(snap: LiveSnapshot, run: { dir: string; workerPgid?: number }): Occupant | null {
  const dir = path.resolve(run.dir);
  for (const [pid, paths] of snap.paths) {
    if (pid === process.pid) continue;
    for (const held of paths) {
      if (held === dir || held.startsWith(`${dir}${path.sep}`)) return { kind: "path", pid, path: held };
    }
  }
  if (run.workerPgid !== undefined) {
    for (const proc of snap.procs.values()) {
      if (proc.pid !== process.pid && proc.pgid === run.workerPgid) return { kind: "group", pid: proc.pid, pgid: proc.pgid };
    }
  }
  return null;
}

function command(name: string, args: string[]) {
  return childProcess.spawnSync(name, args, {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64_000_000,
    timeout: 30_000,
  });
}

function parsePs(raw: string): Map<number, LiveProc & { uid: number; state: string }> | null {
  const procs = new Map<number, LiveProc & { uid: number; state: string }>();
  for (const line of raw.trim().split("\n")) {
    const row = line.trim().match(/^(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)$/);
    if (row === null) return null;
    const pid = Number(row[1]);
    const pgid = Number(row[2]);
    const uid = Number(row[3]);
    const state = row[4] ?? "";
    // Darwin's ? is potentially live; use S only to validate its modifiers
    const validState = PS_STATE.test(state.startsWith("?") ? `S${state.slice(1)}` : state);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(pgid) || !Number.isSafeInteger(uid) || !validState || procs.has(pid)) return null;
    procs.set(pid, { pid, pgid, uid, state });
  }
  return procs;
}

function parseLsof(raw: string): { paths: Map<number, string[]>; cwds: Map<number, string> } | null {
  const paths = new Map<number, string[]>();
  const cwds = new Map<number, string>();
  let pid: number | undefined;
  let fd: string | undefined;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    if (/^p\d+$/.test(line)) {
      pid = Number(line.slice(1));
      fd = undefined;
      if (!Number.isSafeInteger(pid) || pid <= 0) return null;
      if (!paths.has(pid)) paths.set(pid, []);
    } else if (/^f\S+$/.test(line) && pid !== undefined) {
      fd = line.slice(1);
    } else if (line.startsWith("n") && pid !== undefined) {
      const held = line.slice(1);
      if (path.isAbsolute(held)) paths.get(pid)?.push(held);
      if (fd === "cwd") cwds.set(pid, held);
    } else {
      return null;
    }
  }
  return paths.size ? { paths, cwds } : null;
}

function failed(detail: string): ScanFailure {
  return { kind: "failed", detail };
}
