import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { executeCodex, codexArgv, parseCodexJsonl } from "./codex.ts";
import { directEnv } from "./direct.ts";
import { HOST_MARKERS } from "./workers.ts";

test("codex argv uses exec --json, permission profiles, and resume after --", () => {
  const base = {
    provider: "codex" as const,
    out: "/runs/out",
    target: "/repo",
    gitRoot: "/repo" as string | null,
    mode: "read" as const,
    model: "gpt-6-sol",
    executable: "/bin/codex",
    effort: "low",
  };
  assert.deepEqual(codexArgv(base), [
    "exec",
    "--json",
    "-m",
    "gpt-6-sol",
    "-c",
    "model_reasoning_effort=low",
    "-o",
    "/runs/out/answer.md",
    "-c",
    'permissions.delegate.extends=":read-only"',
    "-c",
    "permissions.delegate.network.enabled=true",
    "-c",
    'default_permissions="delegate"',
    "-",
  ]);
  assert.ok(codexArgv({ ...base, mode: "write" }).includes('permissions.delegate.extends=":workspace"'));
  assert.ok(codexArgv({ ...base, gitRoot: null }).includes("--skip-git-repo-check"));
  const resumed = codexArgv({ ...base, tier: "fast", resume: "t-9" });
  assert.deepEqual(resumed.slice(-5), ["-c", "service_tier=fast", "--", "t-9", "-"]);
  assert.equal(resumed[0], "exec");
  assert.equal(resumed[1], "resume");
});

test("parseCodexJsonl reads the thread, last usage, turn.failed, and error items", () => {
  const parsed = parseCodexJsonl(`
{"type":"thread.started","thread_id":"t-1"}
{"type":"item.completed","item":{"id":"item_0","type":"error","message":"boom"}}
{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}
{"type":"turn.failed"}
not json
`);
  assert.deepEqual(parsed, { sessionId: "t-1", usage: "turn.failed", errorItems: ["boom"] });
});

test("directEnv keeps credential names and drops host markers", () => {
  const prev = { ...process.env };
  process.env.OPENAI_API_KEY = "secret";
  process.env.CODEX_SESSION_ID = "sess";
  process.env.DELEGATE_WORKER_PATH = "/caller/bin";
  process.env.PATH = "/engine/bin";
  try {
    const env = directEnv();
    assert.equal(env.OPENAI_API_KEY, "secret");
    assert.equal(env.PATH, "/caller/bin");
    for (const name of HOST_MARKERS) assert.equal(env[name], undefined);
    assert.equal(env.DELEGATE_WORKER_PATH, undefined);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in prev)) delete process.env[key];
    }
    Object.assign(process.env, prev);
  }
});

test("executeCodex writes argv, answer, session, and keeps OPENAI_API_KEY", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-exec-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "codex");
  const argvFile = path.join(root, "argv");
  const envFile = path.join(root, "env");
  fs.writeFileSync(
    bin,
    `#!/bin/sh
printf '%s ' "$@" > "$FAKE_ARGV"
printf 'key=%s marker=%s\\n' "$OPENAI_API_KEY" "$CODEX_SESSION_ID" > "$FAKE_ENV"
answer=""
while [ $# -gt 0 ]; do [ "$1" = -o ] && answer="$2"; shift; done
cat > /dev/null
printf 'hello from codex\\n' > "$answer"
printf '%s\\n' '{"type":"thread.started","thread_id":"t-1"}' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}'
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(root, "prompt.md"), "brief\n");
  const prev = {
    FAKE_ARGV: process.env.FAKE_ARGV,
    FAKE_ENV: process.env.FAKE_ENV,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    CODEX_SESSION_ID: process.env.CODEX_SESSION_ID,
  };
  process.env.FAKE_ARGV = argvFile;
  process.env.FAKE_ENV = envFile;
  process.env.OPENAI_API_KEY = "secret";
  process.env.CODEX_SESSION_ID = "sess";
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  let started = 0;
  const result = await executeCodex(
    {
      provider: "codex",
      out: root,
      target: root,
      gitRoot: null,
      mode: "read",
      model: "m1",
      executable: bin,
      effort: "low",
      resume: "t-9",
    },
    new AbortController().signal,
    () => {
      started += 1;
    },
  );
  assert.equal(started, 1);
  assert.equal(result.failed, false);
  assert.equal(result.sessionId, "t-1");
  assert.match(result.detail, /low read/);
  assert.match(result.detail, /in=1 out=2/);
  assert.equal(fs.readFileSync(path.join(root, "answer.md"), "utf8"), "hello from codex\n");
  assert.match(fs.readFileSync(argvFile, "utf8"), /exec resume .* -- t-9 - /);
  assert.equal(fs.readFileSync(envFile, "utf8").trim(), "key=secret marker=");
});

test("executeCodex with an already-aborted signal does not spawn", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-abort-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "prompt.md"), "brief\n");
  const ac = new AbortController();
  ac.abort();
  let started = 0;
  const result = await executeCodex(
    {
      provider: "codex",
      out: root,
      target: root,
      gitRoot: null,
      mode: "read",
      model: "m1",
      executable: "/nonexistent/codex",
      effort: "low",
    },
    ac.signal,
    () => {
      started += 1;
    },
  );
  assert.equal(started, 0);
  assert.equal(result.failed, true);
  assert.match(result.detail, /stopped/);
});
