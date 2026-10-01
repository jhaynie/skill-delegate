import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { lstartEpoch, mayBeRunningSince, sameProcess, startTime } from "./procs.ts";

const START = "Thu Jan  1 00:00:00 2026";

for (const state of ["S", "Z", "?", "?E", "?N", "?NE"]) {
  test(`process identity and liveness stay conservative for state ${state}`, (t) => {
    t.mock.method(childProcess, "execFileSync", () => `${process.pid} ${state} ${START}\n`);
    t.mock.method(process, "kill", () => true);
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    const known = state === "S" || state === "Z";
    assert.equal(startTime(process.pid), known ? START : null);
    assert.equal(sameProcess(process.pid, START), known);
    assert.equal(sameProcess(process.pid, "Fri Jan  2 00:00:00 2026"), false);
    assert.equal(mayBeRunningSince(process.pid, lstartEpoch(START)), state !== "Z");
    assert.equal(mayBeRunningSince(process.pid, lstartEpoch("Fri Jan  2 00:00:00 2026")), !known);
  });
}
