import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileWriters, noteTree, parseTable } from "./cursor-supervisor.ts";

const LINUX_PROC = fs.existsSync("/proc/self/fd");

test("a ps table parses in C and UTC, and a row whose start does not parse is left out", () => {
  const text = "  101     1   101 Mon Sep 28 17:50:00 2026\n  102   101   101 Tue Sep  1 00:00:05 2026\n  103   101   101 garbage 12\n";
  assert.deepEqual(parseTable(text), [
    { pid: 101, ppid: 1, pgid: 101, start: 1790617800 },
    { pid: 102, ppid: 101, pgid: 101, start: 1788220805 },
  ]);
});

test("a note keeps the group, what it noted before with the same start, and their descendants, and nothing else", () => {
  const leader = 100;
  const table = [
    { pid: 100, ppid: 50, pgid: 100, start: 1000 }, // the supervisor
    { pid: 101, ppid: 100, pgid: 100, start: 1001 }, // cursor-agent
    { pid: 102, ppid: 101, pgid: 102, start: 1002 }, // a child that called setsid
    { pid: 103, ppid: 1, pgid: 103, start: 1003 }, // noted before, its parent gone
    { pid: 104, ppid: 103, pgid: 103, start: 1010 }, // born after that
    { pid: 105, ppid: 1, pgid: 105, start: 1020 }, // a recycled pid noted with start 1004
    { pid: 106, ppid: 105, pgid: 105, start: 1021 },
    { pid: 107, ppid: 1, pgid: 107, start: 900 }, // unrelated
    { pid: 108, ppid: 100, pgid: 100, start: 1030 }, // the supervisor's ps, spawned at 1030
    { pid: 109, ppid: 108, pgid: 100, start: 1030 },
    { pid: 110, ppid: 101, pgid: 100, start: 1040 }, // an old helper's pid, reused later
  ];
  const seen = new Map([
    [103, 1003],
    [105, 1004],
  ]);
  const helpers = new Map([
    [108, 1030],
    [110, 1031],
  ]);
  assert.deepEqual(
    noteTree(table, leader, seen, helpers),
    new Map([
      [101, 1001],
      [102, 1002],
      [103, 1003],
      [104, 1010],
      [110, 1040],
    ]),
  );
});

function scratch(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cursor-scan-")));
}

// A process that opens file with flags, then prints ready and waits
async function holder(t: TestContext, file: string, flags: "a" | "r"): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", `require("fs").openSync(process.argv[1], "${flags}"); console.log("ready"); setTimeout(() => {}, 30000)`, file], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  t.after(() => child.kill());
  await once(child.stdout!, "data");
  return child;
}

function startedLater(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1_100));
}

// The writers a scan found, without their starts
async function writerPids(scan: ReturnType<typeof fileWriters>): Promise<number[] | null> {
  const found = await scan;
  return found && [...found.keys()];
}

test("a writer scan finds what holds the files for writing and started no earlier than the leader", async (t) => {
  const dir = scratch();
  const file = path.join(dir, "stdout.raw");
  fs.writeFileSync(file, "");
  const ours = fs.openSync(file, "r");
  t.after(() => fs.closeSync(ours));
  const early = await holder(t, file, "a");
  await startedLater();
  const leader = await holder(t, path.join(dir, "other"), "a");
  const writer = await holder(t, file, "a");
  await holder(t, file, "r");
  const found = await fileWriters([file], process.pid, leader.pid!, process.env);
  assert.deepEqual(found && [...found.keys()], [writer.pid]);
  // Each writer comes with the start the scan read, which a later signal checks against
  assert.equal(typeof found?.get(writer.pid!), "number");
  // A writer that started in the leader's own second counts
  assert.deepEqual(await writerPids(fileWriters([file], process.pid, early.pid!, process.env)), [early.pid, writer.pid].sort((a, b) => a! - b!));
  // The holder must show up, or the scan proved nothing
  assert.equal(await fileWriters([file], leader.pid!, leader.pid!, process.env), null);
});

test("a writer scan needs the holder on every file, since finding it on one proves nothing about the other", async (t) => {
  const dir = scratch();
  const [stdout, stderr] = [path.join(dir, "stdout.raw"), path.join(dir, "stderr.log")];
  fs.writeFileSync(stdout, "");
  fs.writeFileSync(stderr, "");
  const ours = fs.openSync(stdout, "r");
  t.after(() => fs.closeSync(ours));
  const writer = await holder(t, stderr, "a");
  assert.equal(await fileWriters([stdout, stderr], process.pid, process.pid, process.env), null);
  const both = fs.openSync(stderr, "r");
  t.after(() => fs.closeSync(both));
  assert.deepEqual(await writerPids(fileWriters([stdout, stderr], process.pid, process.pid, process.env)), [writer.pid]);
});

// A PATH whose first directory holds these fake tools
function fakeTools(dir: string, tools: Record<string, string>): NodeJS.ProcessEnv {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  for (const [name, body] of Object.entries(tools)) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
}

test("a writer scan proves nothing when lsof fails, hangs, or exits 1 after it found the holder", { skip: LINUX_PROC && "Linux reads /proc" }, async (t) => {
  const dir = scratch();
  const file = path.join(dir, "stdout.raw");
  fs.writeFileSync(file, "");
  const ours = fs.openSync(file, "r");
  t.after(() => fs.closeSync(ours));
  const writer = await holder(t, file, "a");
  const scan = (tools: Record<string, string>) => fileWriters([file], process.pid, process.pid, fakeTools(fs.mkdtempSync(path.join(dir, "t-")), tools));
  assert.equal(await scan({ lsof: "exit 1" }), null);
  assert.equal(await scan({ lsof: `printf 'p%s\\nf8\\nar\\np%s\\nf1\\naw\\n' ${process.pid} ${writer.pid}; exit 1` }), null);
  const began = Date.now();
  assert.equal(await scan({ lsof: "exec sleep 30" }), null);
  assert.ok(Date.now() - began < 7_000, `a hung lsof held the scan for ${Date.now() - began} ms`);
  // With no lsof at all, the scan proves nothing either
  assert.equal(await fileWriters([file], process.pid, process.pid, { ...process.env, PATH: path.join(dir, "empty") }), null);
});

test("a writer scan proves nothing when ps exits 1 after it printed the start times", async (t) => {
  const dir = scratch();
  const file = path.join(dir, "stdout.raw");
  fs.writeFileSync(file, "");
  const ours = fs.openSync(file, "r");
  t.after(() => fs.closeSync(ours));
  await holder(t, file, "a");
  const env = fakeTools(dir, { ps: 'PATH="${PATH#*:}" ps "$@"; exit 1' });
  assert.equal(await fileWriters([file], process.pid, process.pid, env), null);
});
