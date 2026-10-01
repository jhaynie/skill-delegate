import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalPath } from "./acp.ts";
import { decide, pickOption, widening, type SeenTool } from "./policy.ts";
import type { Approval } from "./state.ts";

const read = { preset: "read" as const, cwd: "/runs/r/workspace", target: "/repo" };
const write = { preset: "write" as const, cwd: "/repo", target: "/repo" };
const full = { preset: "full" as const, cwd: "/repo", target: "/repo" };

// Devin's real option set on an exec request
const devinOptions: Approval["options"] = [
  { id: "allow_once", kind: "allow_once" },
  { id: "allow_session", kind: "allow_always" },
  { id: "allow_always_global", kind: "allow_always" },
  { id: "switch_bypass", kind: "allow_always" },
  { id: "reject_once", kind: "reject_once" },
];

const request = (over: Partial<Approval>): Approval => ({ id: "r1", toolCallId: "call_1#a", title: "", paths: [], options: devinOptions, ...over });
const seen = (tool: SeenTool): Map<string, SeenTool> => new Map([["call_1#a", tool]]);

test("a correlated execute gets allow_once, and an uncorrelated one waits", () => {
  const exec = seen({ kind: "execute", command: "./test.sh", paths: [] });
  assert.equal(decide(write, request({ command: "./test.sh" }), exec), "allow");
  assert.equal(decide(write, request({ toolCallId: "call_other" }), exec), "ask");
  assert.equal(decide(write, request({ toolCallId: undefined }), exec), "ask");
});

test("a request whose editableCommand differs from the announced command waits", () => {
  const exec = seen({ kind: "execute", command: "./test.sh", paths: [] });
  assert.equal(decide(write, request({ command: "sed -i s/a/b/ x && ./test.sh" }), exec), "ask");
  assert.equal(decide(write, request({ command: "./test.sh" }), seen({ kind: "execute", paths: [] })), "ask");
});

test("a request that offers no allow_once waits, even in full", () => {
  const scopeReq = request({ options: [{ id: "allow_session", kind: "allow_always" }, { id: "reject_once", kind: "reject_once" }] });
  const tool = seen({ kind: "execute", paths: [] });
  assert.equal(decide(write, scopeReq, tool), "ask");
  assert.equal(decide(full, scopeReq, tool), "ask");
});

test("a correlated read inside the workspace or the read-only target is allowed, elsewhere it waits", () => {
  assert.equal(decide(read, request({}), seen({ kind: "read", paths: ["/repo/src/a.ts"] })), "allow");
  assert.equal(decide(read, request({}), seen({ kind: "read", paths: ["/runs/r/workspace/notes.md"] })), "allow");
  assert.equal(decide(read, request({}), seen({ kind: "read", paths: ["/Users/p/.ssh/id_ed25519"] })), "ask");
  assert.equal(decide(read, request({}), seen({ kind: "read", paths: [] })), "ask");
});

test("a correlated edit is allowed only inside the workspace, so read mode never edits the target", () => {
  assert.equal(decide(write, request({}), seen({ kind: "edit", paths: ["/repo/slug.py"] })), "allow");
  assert.equal(decide(read, request({}), seen({ kind: "edit", paths: ["/repo/slug.py"] })), "ask");
  assert.equal(decide(write, request({}), seen({ kind: "edit", paths: ["/repo/../etc/hosts"] })), "ask");
  assert.equal(decide(write, request({}), seen({ kind: "edit", paths: ["/repository/x"] })), "ask");
  assert.equal(decide(write, request({ paths: ["/tmp/x"] }), seen({ kind: "edit", paths: ["/repo/a"] })), "ask");
});

test("the request's own kind counts when the announced call had none", () => {
  assert.equal(decide(write, request({ toolKind: "execute" }), seen({ paths: [] })), "allow");
  assert.equal(decide(write, request({}), seen({ paths: [] })), "ask");
  assert.equal(decide(write, request({}), seen({ kind: "fetch", paths: [] })), "ask");
});

test("full allows any request that offers allow_once, correlated or not", () => {
  assert.equal(decide(full, request({ toolCallId: "never-seen" }), new Map()), "allow");
});

test("allow and deny send only the once options", () => {
  assert.equal(pickOption(devinOptions, "allow")?.id, "allow_once");
  assert.equal(pickOption(devinOptions, "deny")?.id, "reject_once");
  assert.equal(pickOption([{ id: "allow_session", kind: "allow_always" }], "allow"), null);
});

test("widen takes the least sticky allow, session before always, never bypass or global", () => {
  const scope: Approval["options"] = [
    { id: "allow_always_global", kind: "allow_always" },
    { id: "switch_bypass", kind: "allow_always" },
    { id: "allow_always", kind: "allow_always" },
    { id: "allow_session", kind: "allow_always" },
    { id: "reject_once", kind: "reject_once" },
  ];
  assert.equal(pickOption(scope, "widen")?.id, "allow_session");
  assert.equal(pickOption(scope.filter((o) => o.id !== "allow_session"), "widen")?.id, "allow_always");
  assert.equal(pickOption(scope.slice(0, 2), "widen"), null);
  assert.equal(pickOption(devinOptions, "widen")?.id, "allow_once");
});

test("a request kind that differs from the announced kind waits", () => {
  assert.equal(decide(write, request({ toolKind: "execute" }), seen({ kind: "edit", paths: ["/repo/a"] })), "ask");
  assert.equal(decide(write, request({ toolKind: "edit" }), seen({ kind: "edit", paths: ["/repo/a"] })), "allow");
});

test("an edit through a symlink that leaves the workspace waits", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "engine-policy-")));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  fs.mkdirSync(path.join(root, "outside"));
  fs.symlinkSync(path.join(root, "outside"), path.join(repo, "link"));
  const spec = { preset: "write" as const, cwd: repo, target: repo };
  const through = canonicalPath(path.join(repo, "link", "new", "secret.txt"), repo);
  assert.equal(through, path.join(root, "outside", "new", "secret.txt"));
  assert.equal(decide(spec, request({}), seen({ kind: "edit", paths: [through] })), "ask");
  const plain = canonicalPath("sub/new.txt", repo);
  assert.equal(decide(spec, request({}), seen({ kind: "edit", paths: [plain] })), "allow");
});

test("a read-mode worker in the target never edits it, and one in a scratch workspace edits only there", () => {
  const inTarget = { preset: "read" as const, cwd: "/repo", target: "/repo" };
  const edit = (p: string) => seen({ kind: "edit", paths: [p] });
  assert.equal(decide(inTarget, request({}), edit("/repo/a.txt")), "ask");
  assert.equal(decide(read, request({}), edit("/runs/r/workspace/notes.md")), "allow");
  assert.equal(decide(read, request({}), edit("/repo/a.txt")), "ask");
  assert.equal(decide(write, request({}), edit("/repo/a.txt")), "allow");
});

test("an allow widens by stickiness, or by a path outside the roots the policy allows for that kind", () => {
  const once = { id: "allow_once", kind: "allow_once" as const };
  const edit = (p: string) => seen({ kind: "edit", paths: [p] });
  const readTool = (p: string) => seen({ kind: "read", paths: [p] });
  assert.equal(widening(write, request({}), edit("/elsewhere/from-worker.txt"), once), "path");
  assert.equal(widening(write, request({}), edit("/repo/a.txt"), once), null);
  assert.equal(widening(read, request({}), edit("/repo/a.txt"), once), "path");
  assert.equal(widening(read, request({}), readTool("/repo/a.txt"), once), null);
  assert.equal(widening(read, request({}), readTool("/etc/hosts"), once), "path");
  assert.equal(widening(write, request({ command: "ls" }), seen({ kind: "execute", command: "ls", paths: [] }), once), null);
  assert.equal(widening(write, request({}), edit("/repo/a.txt"), { id: "allow_session", kind: "allow_always" }), "sticky");
  assert.equal(widening(write, request({}), edit("/elsewhere/x"), { id: "reject_once", kind: "reject_once" }), null);
});
