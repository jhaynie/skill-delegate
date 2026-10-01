import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { test } from "node:test";
import { occupantOf, takeSnapshot, type LiveSnapshot } from "./livescan.ts";

const UID = process.getuid();
const SELF_PS = `  ${process.pid} 123 ${UID} S\n`;
const SELF_FILES = `p${process.pid}\nfcwd\nn${fs.realpathSync.native(process.cwd())}\n`;

test("a snapshot parses process groups, cwd, and open files and ignores socket names", (t) => {
  const calls: [string, string[]][] = [];
  t.mock.method(childProcess, "spawnSync", (name: string, args: string[]) => {
    calls.push([name, args]);
    return { status: 0, stdout: name === "ps"
      ? `${SELF_PS}41022 41020 ${UID} S\n41023 41020 ${UID} Z\n`
      : `${SELF_FILES}p41022\nfcwd\nn/root/run/workspace\nf12\nn/root/run/stdout.raw\nf13\nn127.0.0.1:123->127.0.0.1:456\np41023\n` };
  });
  const snap = takeSnapshot();
  assert.equal(snap.kind, "ok");
  if (snap.kind !== "ok") return;
  assert.deepEqual(snap.procs.get(41022), { pid: 41022, pgid: 41020 });
  assert.equal(snap.procs.has(41023), false);
  assert.deepEqual(snap.paths.get(41022), ["/root/run/workspace", "/root/run/stdout.raw"]);
  assert.deepEqual(calls, [["ps", ["-A", "-o", "pid=,pgid=,uid=,stat="]], ["lsof", ["-n", "-P", "-Fpfn"]]]);
});

for (const state of ["?", "?E", "?N", "?NE", "?<", "?s+"]) {
  test(`a snapshot keeps unknown state ${state} as a potentially live group occupant`, (t) => {
    t.mock.method(childProcess, "spawnSync", (name: string) => ({
      status: 0,
      stdout: name === "ps" ? `${SELF_PS}41022 41020 ${UID} ${state}\n` : `${SELF_FILES}p41022\nfcwd\nn/root/run\n`,
    }));
    const snap = takeSnapshot();
    assert.equal(snap.kind, "ok");
    if (snap.kind !== "ok") return;
    assert.deepEqual(snap.procs.get(41022), { pid: 41022, pgid: 41020 });
    assert.deepEqual(occupantOf(snap, { dir: "/another/run", workerPgid: 41020 }), { kind: "group", pid: 41022, pgid: 41020 });
  });
}

test("a negative uid remains a valid process row", (t) => {
  t.mock.method(childProcess, "spawnSync", (name: string) => ({
    status: 0,
    stdout: name === "ps" ? `${SELF_PS}41022 41020 -2 S\n` : `${SELF_FILES}p41022\n`,
  }));
  const snap = takeSnapshot();
  assert.equal(snap.kind, "ok");
  if (snap.kind !== "ok") return;
  assert.deepEqual(snap.procs.get(41022), { pid: 41022, pgid: 41020 });
});

test("malformed states and process rows still fail the scan", (t) => {
  for (const row of [
    `41022 41020 ${UID} ??`,
    `41022 41020 ${UID} ?Z`,
    `41022 41020 ${UID} ?e`,
    `41022 41020 ${UID} ?NEgarbage`,
    `41022 41020 ${UID} Q`,
    `41022 41020 ${UID} SN?`,
    "41022 41020 ?NE",
    `41022 41020 ${UID} ?NE extra`,
    `41022 41020 - S`,
    `41022 41020 9007199254740992 S`,
  ]) {
    const mock = t.mock.method(childProcess, "spawnSync", (name: string) => ({
      status: 0,
      stdout: name === "ps" ? `${SELF_PS}${row}\n` : SELF_FILES,
    }));
    assert.deepEqual(takeSnapshot(), { kind: "failed", detail: "ps output is unparseable" }, row);
    mock.mock.restore();
  }
});

test("lsof nonzero exit fails even when parsed output passes the self-check", (t) => {
  t.mock.method(childProcess, "spawnSync", (name: string) => ({
    status: name === "ps" ? 0 : 1,
    stdout: name === "ps" ? SELF_PS : SELF_FILES,
  }));
  assert.deepEqual(takeSnapshot(), { kind: "failed", detail: "lsof exited 1" });
});

for (const state of ["S", "?", "?E", "?N", "?NE"]) {
  test(`lsof must report a still-live user pid with state ${state}`, (t) => {
    let lsofReturned = false;
    t.mock.method(childProcess, "spawnSync", (name: string) => {
      if (name === "lsof") lsofReturned = true;
      return { status: 0, stdout: name === "ps" ? `${SELF_PS}41022 41020 ${UID} ${state}\n` : SELF_FILES };
    });
    const kill = t.mock.method(process, "kill", (pid: number, signal: number) => {
      assert.equal(lsofReturned, true);
      assert.equal(pid, 41022);
      assert.equal(signal, 0);
      return true;
    });
    assert.deepEqual(takeSnapshot(), { kind: "failed", detail: "lsof did not report live user process 41022" });
    assert.equal(kill.mock.callCount(), 1);
  });
}

for (const state of ["Z", "ZN", "Z+"]) {
  test(`a zombie with state ${state} missing from lsof does not fail the scan`, (t) => {
    t.mock.method(childProcess, "spawnSync", (name: string) => ({
      status: 0,
      stdout: name === "ps" ? `${SELF_PS}41022 41020 ${UID} ${state}\n` : SELF_FILES,
    }));
    const kill = t.mock.method(process, "kill", () => true);
    const snap = takeSnapshot();
    assert.equal(snap.kind, "ok");
    if (snap.kind !== "ok") return;
    assert.equal(snap.procs.has(41022), false);
    assert.equal(kill.mock.callCount(), 0);
  });
}

test("pids that exited between ps and lsof and missing other-user pids do not fail the scan", (t) => {
  t.mock.method(childProcess, "spawnSync", (name: string) => ({
    status: 0,
    stdout: name === "ps" ? `${SELF_PS}41022 41020 ${UID} S\n41024 41020 ${UID + 1} S\n` : SELF_FILES,
  }));
  const kill = t.mock.method(process, "kill", (pid: number, signal: number) => {
    assert.equal(pid, 41022);
    assert.equal(signal, 0);
    throw Object.assign(new Error("process is gone"), { code: "ESRCH" });
  });
  assert.equal(takeSnapshot().kind, "ok");
  assert.equal(kill.mock.callCount(), 1);
});

test("an unreadable missing user pid also fails closed", (t) => {
  t.mock.method(childProcess, "spawnSync", (name: string) => ({
    status: 0, stdout: name === "ps" ? `${SELF_PS}41022 41020 ${UID} S\n` : SELF_FILES,
  }));
  t.mock.method(process, "kill", () => { throw Object.assign(new Error("not permitted"), { code: "EPERM" }); });
  assert.deepEqual(takeSnapshot(), { kind: "failed", detail: "lsof did not report live user process 41022" });
});

test("missing binaries, command errors, and malformed output fail as values", (t) => {
  for (const [command, result, detail] of [
    ["ps", { error: new Error("spawnSync ps ENOENT") }, /ps.*ENOENT/],
    ["lsof", { error: new Error("spawnSync lsof ENOENT") }, /lsof.*ENOENT/],
    ["ps", { status: 1, stdout: SELF_PS }, /ps exited 1/],
    ["ps", { status: 0, stdout: "unparseable" }, /ps output is unparseable/],
    ["ps", { status: 0, stdout: `${SELF_PS}${SELF_PS}` }, /ps output is unparseable/],
    ["ps", { status: 0, stdout: `0 123 ${UID} S\n` }, /ps output is unparseable/],
    ["lsof", { status: 1, stdout: "" }, /lsof exited 1/],
    ["lsof", { status: null, signal: "SIGTERM", stdout: SELF_FILES }, /lsof exited SIGTERM/],
    ["lsof", { status: 0, stdout: "" }, /lsof output is unparseable/],
    ["lsof", { status: 0, stdout: `n/root/run\n${SELF_FILES}` }, /lsof output is unparseable/],
    ["lsof", { status: 0, stdout: `${SELF_FILES}garbage\n` }, /lsof output is unparseable/],
  ] as const) {
    const mock = t.mock.method(childProcess, "spawnSync", (name: string) => name === command
      ? result : { status: 0, stdout: name === "ps" ? SELF_PS : SELF_FILES });
    const snap = takeSnapshot();
    assert.equal(snap.kind, "failed");
    if (snap.kind === "failed") assert.match(snap.detail, detail);
    mock.mock.restore();
  }
});

test("the self-check requires this pid in ps and its actual cwd in lsof", (t) => {
  for (const [ps, lsof] of [
    [`41022 41020 ${UID} S\n`, SELF_FILES],
    [SELF_PS, "p41022\nfcwd\nn/root/run\n"],
    [SELF_PS, `p${process.pid}\nfcwd\nn/somewhere/else\n`],
    [SELF_PS, SELF_FILES.replace("fcwd", "f12")],
  ]) {
    const mock = t.mock.method(childProcess, "spawnSync", (name: string) => ({ status: 0, stdout: name === "ps" ? ps : lsof }));
    assert.deepEqual(takeSnapshot(), { kind: "failed", detail: "snapshot does not contain this process with its cwd" });
    mock.mock.restore();
  }
});

test("unexpected command exceptions also fail as values", (t) => {
  t.mock.method(childProcess, "spawnSync", () => { throw new Error("scan exploded"); });
  assert.deepEqual(takeSnapshot(), { kind: "failed", detail: "scan exploded" });
});

test("occupants match directory segments, cwd or files, and groups without a leader", () => {
  const snap: LiveSnapshot = {
    kind: "ok",
    procs: new Map([[27300, { pid: 27300, pgid: 27288 }]]),
    paths: new Map([[41022, ["/root/run2", "/root/run2/log"]]]),
  };
  assert.equal(occupantOf(snap, { dir: "/root/run" }), null);
  assert.deepEqual(occupantOf(snap, { dir: "/root/run", workerPgid: 27288 }), { kind: "group", pid: 27300, pgid: 27288 });
  for (const held of ["/root/run", "/root/run/workspace", "/root/run/stdout.raw"]) {
    assert.deepEqual(occupantOf({ ...snap, paths: new Map([[41022, [held]]]) }, { dir: "/root/run/" }),
      { kind: "path", pid: 41022, path: held });
  }
});

test("prune itself is excluded but a pid newly reported by lsof still holds a path", () => {
  const snap: LiveSnapshot = {
    kind: "ok",
    procs: new Map([[process.pid, { pid: process.pid, pgid: 123 }]]),
    paths: new Map([[process.pid, ["/root/run/log"]]]),
  };
  assert.equal(occupantOf(snap, { dir: "/root/run", workerPgid: 123 }), null);
  assert.deepEqual(occupantOf({ ...snap, paths: new Map([[41022, ["/root/run/log"]]]) }, { dir: "/root/run" }),
    { kind: "path", pid: 41022, path: "/root/run/log" });
});
