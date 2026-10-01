import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, test, type TestContext } from "node:test";
import { shouldKeepWaiting } from "./owner.ts";
import { openRun } from "./run.ts";
import { initialState, reduce } from "./state.ts";

const CLI = path.join(import.meta.dirname, "cli.ts");

test("stop keeps waiting on a live run until its heartbeat goes stale", () => {
  const live = reduce(initialState(42, 0), { kind: "turnStart" });
  assert.equal(shouldKeepWaiting(live, 29_000), true);
  assert.equal(shouldKeepWaiting(live, 30_000), false);
  const beat = reduce(live, { kind: "heartbeat", at: 50_000 });
  assert.equal(shouldKeepWaiting(beat, 70_000), true);
  const ended = reduce(beat, { kind: "finish", cause: { kind: "stopped" }, leftover: 0, dirty: 0 });
  assert.equal(shouldKeepWaiting(ended, 50_000), false);
});

// An ACP agent on PATH as grok and as opencode. Each prompt streams
// "answer <n>" and ends after 2 s, so a poll sees it running. With
// FAKE_CANCEL set, the first prompt never ends on its own: slow ends it 12 s
// after a cancel, and never ignores the cancel. FAKE_MODELS makes
// session/new list those models, as the real CLIs do, and FAKE_LATE_MODELS
// lists them only in set replies, echoing any value set; FAKE_NARROW names a
// model whose effort choices are only low and high; FAKE_HIDE_MODEL drops the
// model from every set reply; FAKE_PROMPT_ERROR makes
// every prompt fail as OpenCode did on an Azure model with no deployment,
// and FAKE_ERROR_MESSAGE fails it with that JSON as the error's message,
// after a first line of text when FAKE_ERROR_AFTER_TEXT is set.
// FAKE_ECHO_PATH makes the answer the worker's own PATH. FAKE_ASK makes each
// prompt ask to run a command no tool call announced, so the engine waits
// for the parent, and answers with the option the engine chose.
// FAKE_LOG collects each method the engine calls, with configId=value for a
// set. session/new lists the mode option, as OpenCode's does. FAKE_NO_MODE
// drops it from every reply, or with "set" only from set replies. As
// opencode, the debug
// commands echo back the permissions the engine passed in.
const FAKE_WORKER = `
import fs from "node:fs";
import readline from "node:readline";
if (process.argv[2] === "debug") {
  const [what, agent] = process.argv.slice(3);
  if (what === "config") console.log("{}");
  if (what === "paths") console.log("data /nowhere");
  if (what === "agent") {
    const permission = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).agent[agent].permission;
    const rules = Object.entries(permission).flatMap(([p, v]) =>
      typeof v === "string" ? [{ permission: p, pattern: "*", action: v }] : Object.entries(v).map(([pattern, action]) => ({ permission: p, pattern, action })),
    );
    console.log(JSON.stringify({ name: agent, permission: rules }));
  }
  process.exit(0);
}
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\\n");
const log = (method) => process.env.FAKE_LOG && fs.appendFileSync(process.env.FAKE_LOG, method + "\\n");
const models = process.env.FAKE_MODELS ? process.env.FAKE_MODELS.split(",") : null;
const late = process.env.FAKE_LATE_MODELS ? process.env.FAKE_LATE_MODELS.split(",") : null;
const config = { model: models?.[0] ?? "grok-4.7", reasoning_effort: "medium", mode: "build" };
const efforts = () => (config.model === process.env.FAKE_NARROW ? ["low", "high"] : ["low", "medium", "high"]);
const options = () => ({
  configOptions: [
    { id: "model", currentValue: config.model, options: (models ?? late ?? []).map((value) => ({ value })) },
    { id: "reasoning_effort", currentValue: config.reasoning_effort, options: efforts().map((value) => ({ value })) },
    { id: "mode", currentValue: config.mode, options: [{ value: "build" }, { value: "plan" }] },
  ],
});
// What session/new or session/load lists
const opened = () => ({ configOptions: options().configOptions.filter((o) => (o.id === "mode" ? process.env.FAKE_NO_MODE !== "all" : models)) });
let turns = 0;
let open = null;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === "ask" && !msg.method) {
    const outcome = msg.result.outcome;
    send({ method: "session/update", params: { sessionId: "fake-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer " + (outcome.optionId ?? outcome.outcome) } } } });
    return send({ id: open, result: { stopReason: outcome.outcome === "cancelled" ? "cancelled" : "end_turn" } });
  }
  log(msg.method === "session/set_config_option" ? msg.method + " " + msg.params.configId + "=" + msg.params.value : msg.method);
  switch (msg.method) {
    case "initialize":
      return send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
    case "session/new":
      return send({ id: msg.id, result: { sessionId: "fake-1", ...opened() } });
    case "session/load":
      return send({ id: msg.id, result: opened() });
    case "session/set_config_option": {
      config[msg.params.configId] = msg.params.value;
      const all = options().configOptions.filter((o) => o.id !== (process.env.FAKE_NO_MODE ? "mode" : ""));
      return send({ id: msg.id, result: { configOptions: process.env.FAKE_HIDE_MODEL ? all.filter((o) => o.id !== "model") : all } });
    }
    case "session/set_mode":
      return send({ id: msg.id, error: { code: -32601, message: "session/set_mode is not for this agent" } });
    case "session/prompt": {
      turns++;
      if (process.env.FAKE_PROMPT_ERROR) {
        const message = "Internal error: The API deployment for this resource does not exist. If you created the deployment within the last 5 minutes, please wait a moment and try again.";
        return send({ id: msg.id, error: { code: -32603, message, data: { service: "session", errorName: "APIError" } } });
      }
      if (process.env.FAKE_ERROR_MESSAGE !== undefined) {
        if (process.env.FAKE_ERROR_AFTER_TEXT) send({ method: "session/update", params: { sessionId: "fake-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Let me look." } } } });
        return send({ id: msg.id, error: { code: -32603, message: JSON.parse(process.env.FAKE_ERROR_MESSAGE) } });
      }
      if (process.env.FAKE_ASK) {
        open = msg.id;
        const options = [{ optionId: "allow", kind: "allow_once" }, { optionId: "deny", kind: "reject_once" }];
        return send({ id: "ask", method: "session/request_permission", params: { sessionId: "fake-1", toolCall: { toolCallId: "call-1", title: "touch x", kind: "execute" }, options } });
      }
      const text = process.env.FAKE_ECHO_PATH ? "PATH=" + process.env.PATH : "answer " + turns;
      const update = { sessionUpdate: "agent_message_chunk", content: { type: "text", text } };
      send({ method: "session/update", params: { sessionId: "fake-1", update } });
      if (turns > 1 || !process.env.FAKE_CANCEL) return setTimeout(() => send({ id: msg.id, result: { stopReason: "end_turn" } }), 2_000);
      open = msg.id;
      return;
    }
    case "session/cancel":
      if (process.env.FAKE_CANCEL === "slow") setTimeout(() => send({ id: open, result: { stopReason: "cancelled" } }), 12_000);
      return;
  }
}).on("close", () => process.exit(0));
`;

// A fake grok and opencode on PATH, a target and a run directory outside the
// temp dirs, and the delegate CLI run against them. env is the CLI's
// environment, which a test may change before start.
function fakeSetup(t: TestContext, fake: Record<string, string>, cli: "grok" | "opencode") {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "engine-fake-"));
  fs.writeFileSync(path.join(bin, "fake.mjs"), FAKE_WORKER);
  for (const name of ["grok", "opencode"]) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(bin, "fake.mjs"))} "$@"\n`, { mode: 0o755 });
  }
  fs.mkdirSync(path.join(os.homedir(), ".cache"), { recursive: true });
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".cache", "delegate-engine-test-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, "target"));
  fs.writeFileSync(path.join(home, "brief.md"), "brief\n");
  const out = path.join(home, "run");
  const calls = path.join(home, "calls.log");
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: calls, ...fake };
  for (const marker of ["GROK_AGENT", "OPENCODE", "OPENCODE_PID"]) delete env[marker];
  const delegate = (...args: string[]) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], { env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  const target = path.join(home, "target");
  const start = (...flags: string[]) =>
    delegate("run", "--cli", cli, "--cwd", target, "--prompt-file", path.join(home, "brief.md"), "--deadline", "10m", "--out", out, ...flags);
  const called = () => fs.readFileSync(calls, "utf8").trim().split("\n");
  return { bin, home, target, env, out, delegate, start, called };
}

async function fakeStart(t: TestContext, fake: Record<string, string>, cli: "grok" | "opencode", ...runFlags: string[]) {
  const setup = fakeSetup(t, fake, cli);
  return { ...setup, started: await setup.start(...runFlags) };
}

async function fakeRun(t: TestContext, cancel: "slow" | "never" | "", ...runFlags: string[]) {
  const run = await fakeStart(t, { FAKE_CANCEL: cancel }, "grok", ...runFlags);
  assert.equal(run.started.code, 0, run.started.stderr);
  return run;
}

describe("the engine against a fake ACP worker", { concurrency: true }, () => {
  it("send --now waits out a slow cancel and sees the interrupt acknowledged", async (t) => {
    const { out, delegate, started } = await fakeRun(t, "slow");
    assert.equal(started.stdout, `[grok | running | grok-4.7 | medium read sandbox=read-only turn=1 tools=0 asks=0 waited=0 denied=0 left=10m | session=fake-1 | out=${out}]\n`);
    assert.deepEqual(await delegate("send", out, "--now", "hurry"), {
      code: 0,
      stdout: `[grok | running | grok-4.7 | medium read sandbox=read-only turn=2 tools=0 sent=interrupt asks=0 waited=0 denied=0 left=10m | session=fake-1 | out=${out}]\n`,
      stderr: "",
    });
    assert.equal((await delegate("result", out, "--wait")).stdout.split("\n").slice(1).join("\n"), "\nanswer 2\n\nearlier turns: turns/1.md\n");
  });

  it("stop on a worker that ignores the cancel keeps the turn's transcript and answer", async (t) => {
    const { out, delegate } = await fakeRun(t, "never");
    assert.deepEqual(await delegate("stop", out), {
      code: 0,
      stdout:
        `[grok | partial | grok-4.7 | medium read sandbox=read-only cancel hung turns=1 stop=error asks=0 waited=0 denied=0 leftover=0 | session=fake-1 | out=${out}]\n`,
      stderr: "",
    });
    assert.equal(fs.readFileSync(path.join(out, "answer.md"), "utf8"), "answer 1");
    assert.equal(fs.readFileSync(path.join(out, "turns", "1.md"), "utf8"), "answer 1");
  });

  it("a request ID carries the run's nonce, so an answer naming only its number is not open", async (t) => {
    const { out, delegate } = await fakeStart(t, { FAKE_ASK: "1" }, "grok");
    const req = `r1-${openRun(out).spec.nonce?.slice(0, 8)}`;
    const line = `[grok | waiting | grok-4.7 | medium read sandbox=read-only req=${req} "title=touch x" answer allow|deny | session=fake-1 | out=${out}]\n`;
    const deadline = Date.now() + 15_000;
    let seen = await delegate("status", out);
    while (seen.stdout !== line && Date.now() < deadline) seen = await delegate("status", out);
    assert.deepEqual(seen, { code: 0, stdout: line, stderr: "" });
    assert.deepEqual(await delegate("answer", out, "r1", "allow"), { code: 1, stdout: line, stderr: "r1 is not open or offers no allow_once; answer deny, or stop\n" });
    assert.deepEqual((await delegate("answer", out, req, "allow")).code, 0);
    assert.equal((await delegate("result", out, "--wait")).stdout.split("\n").slice(1).join("\n"), "\nanswer allow\n");
  });

  const GROK_MODELS = { FAKE_MODELS: "grok-4.7,grok-4.7-build-fast,grok-4.6,grok-4.5" };
  const counts = "asks=0 waited=0 denied=0 leftover=0";

  it("an unadvertised model fails before any set_config_option or prompt, naming the session and the nearest IDs", async (t) => {
    const { out, started, called } = await fakeStart(t, GROK_MODELS, "grok", "--model", "grok4.7", "--wait");
    assert.deepEqual(started, {
      code: 1,
      stdout: `[grok | fail | grok4.7 | medium read sandbox=read-only model not offered; nearest: grok-4.7, grok-4.7-build-fast, grok-4.5 turns=0 stop=- ${counts} | session=fake-1 | out=${out}]\n`,
      stderr: "",
    });
    assert.deepEqual(called(), ["initialize", "session/new"]);
  });

  it("a model list that first appears in the set reply is checked before the prompt", async (t) => {
    const { out, started, called } = await fakeStart(t, { FAKE_LATE_MODELS: GROK_MODELS.FAKE_MODELS }, "grok", "--model", "grok4.7", "--wait");
    assert.deepEqual(started, {
      code: 1,
      stdout: `[grok | fail | grok4.7 | medium read sandbox=read-only model not offered; nearest: grok-4.7, grok-4.7-build-fast, grok-4.5 turns=0 stop=- ${counts} | session=fake-1 | out=${out}]\n`,
      stderr: "",
    });
    assert.deepEqual(called(), ["initialize", "session/new", "session/set_config_option model=grok4.7"]);
  });

  it("a resumed session checks the model against what session/load lists", async (t) => {
    const [listed, unlisted] = await Promise.all([
      fakeStart(t, GROK_MODELS, "grok", "--resume", "s-9", "--model", "grok-4.5", "--wait"),
      fakeStart(t, GROK_MODELS, "grok", "--resume", "s-9", "--model", "grok4.7", "--wait"),
    ]);
    assert.equal(listed.started.stdout, `[grok | ok | grok-4.5 | medium read sandbox=read-only turns=1 stop=end_turn ${counts} | session=s-9 | out=${listed.out}]\n`);
    assert.equal(
      unlisted.started.stdout,
      `[grok | fail | grok4.7 | medium read sandbox=read-only model not offered; nearest: grok-4.7, grok-4.7-build-fast, grok-4.5 turns=0 stop=- ${counts} | session=s-9 | out=${unlisted.out}]\n`,
    );
    assert.deepEqual(unlisted.called(), ["initialize", "session/load"]);
  });

  it("an advertised model that is not the default runs", async (t) => {
    const { out, started } = await fakeStart(t, GROK_MODELS, "grok", "--model", "grok-4.5", "--wait");
    assert.equal(started.stdout, `[grok | ok | grok-4.5 | medium read sandbox=read-only turns=1 stop=end_turn ${counts} | session=fake-1 | out=${out}]\n`);
  });

  it("a session that lists no models passes the requested ID to the CLI and notes it", async (t) => {
    const { out, started, called } = await fakeStart(t, {}, "grok", "--model", "grok-next", "--wait");
    assert.equal(started.stdout, `[grok | ok | grok-next | medium read sandbox=read-only turns=1 stop=end_turn ${counts} | session=fake-1 | out=${out}]\n`);
    assert.deepEqual(called().slice(0, 4), ["initialize", "session/new", "session/set_config_option model=grok-next", "session/set_config_option reasoning_effort=medium"]);
    assert.match(fs.readFileSync(path.join(out, "stderr.log"), "utf8"), /the session lists no models, so the CLI alone decides whether grok-next runs/);
  });

  it("a listed model that the set replies stop reporting fails before the prompt", async (t) => {
    const { out, started, called } = await fakeStart(t, { ...GROK_MODELS, FAKE_HIDE_MODEL: "1" }, "grok", "--model", "grok-4.5", "--wait");
    assert.equal(
      started.stdout,
      `[grok | fail | grok-4.5 | medium read sandbox=read-only the session reports no model, so grok-4.5 is unconfirmed turns=0 stop=- ${counts} | session=fake-1 | out=${out}]\n`,
    );
    assert.equal(called().includes("session/prompt"), false);
  });

  it("effort is checked against the option list the model's set returned", async (t) => {
    const { out, started, called } = await fakeStart(t, { ...GROK_MODELS, FAKE_NARROW: "grok-4.5" }, "grok", "--model", "grok-4.5", "--wait");
    assert.equal(
      started.stdout,
      `[grok | fail | grok-4.5 | medium read sandbox=read-only --effort medium is not one of low, high turns=0 stop=- ${counts} | session=fake-1 | out=${out}]\n`,
    );
    assert.deepEqual(called(), ["initialize", "session/new", "session/set_config_option model=grok-4.5"]);
  });

  it("OpenCode's read mode sets mode plan, and a session that lists or reads back no mode fails before the prompt", async (t) => {
    const models = { FAKE_MODELS: "azure/gpt-5.6-sol,azure/gpt-6-luna" };
    const [read, modeless, unconfirmed] = await Promise.all([
      fakeStart(t, models, "opencode", "--model", "azure/gpt-6-luna", "--wait"),
      fakeStart(t, { ...models, FAKE_NO_MODE: "all" }, "opencode", "--model", "azure/gpt-6-luna", "--wait"),
      fakeStart(t, { ...models, FAKE_NO_MODE: "set" }, "opencode", "--model", "azure/gpt-6-luna", "--wait"),
    ]);
    assert.equal(read.started.stdout, `[opencode | ok | azure/gpt-6-luna | medium read turns=1 stop=end_turn ${counts} | session=fake-1 | out=${read.out}]\n`);
    assert.deepEqual(read.called(), [
      "initialize",
      "session/new",
      "session/set_config_option mode=plan",
      "session/set_config_option model=azure/gpt-6-luna",
      "session/prompt",
    ]);
    assert.equal(
      modeless.started.stdout,
      `[opencode | fail | azure/gpt-6-luna | medium read the session offers no mode option, so plan cannot be set turns=0 stop=- ${counts} | session=fake-1 | out=${modeless.out}]\n`,
    );
    assert.deepEqual(modeless.called(), ["initialize", "session/new"]);
    assert.equal(
      unconfirmed.started.stdout,
      `[opencode | fail | azure/gpt-6-luna | medium read the session reports no mode, so plan is unconfirmed turns=0 stop=- ${counts} | session=fake-1 | out=${unconfirmed.out}]\n`,
    );
  });

  it("a prompt-time provider error reaches the fail line, --answer prints the stderr tail after it, and stderr.log keeps it whole", async (t) => {
    const said = "Internal error: The API deployment for this resource does not exist. If you created the deployment within the last 5 minutes, please wait a moment and try again.";
    const [waited, answered] = await Promise.all([
      fakeStart(t, { FAKE_PROMPT_ERROR: "1" }, "opencode", "--wait"),
      fakeStart(t, { FAKE_PROMPT_ERROR: "1" }, "opencode", "--answer"),
    ]);
    const line = (out: string) => `[opencode | fail | azure/gpt-6.1-sol | medium read provider error: ${said} turns=1 stop=error ${counts} | session=fake-1 | out=${out}]\n`;
    assert.deepEqual(waited.started, { code: 1, stdout: line(waited.out), stderr: "" });
    const logged = `delegate: session/prompt failed: ${said} {"service":"session","errorName":"APIError"}`;
    assert.equal(fs.readFileSync(path.join(waited.out, "stderr.log"), "utf8").trimEnd().split("\n").at(-1), logged);
    const tail = [
      "delegate: the session lists no models, so the CLI alone decides whether azure/gpt-6.1-sol runs",
      "delegate: azure/gpt-6.1-sol offers no effort option, so effort medium does not apply",
      logged,
    ];
    assert.deepEqual(answered.started, { code: 1, stdout: `${line(answered.out)}\n${tail.join("\n")}\n`, stderr: "" });
  });

  it("a second run on an ended --out is refused, and result still prints the first run's line and answer", async (t) => {
    const { out, delegate, start } = await fakeRun(t, "", "--wait");
    const line = `[grok | ok | grok-4.7 | medium read sandbox=read-only turns=1 stop=end_turn asks=0 waited=0 denied=0 leftover=0 | session=fake-1 | out=${out}]\n`;
    const why = `--out already holds a run: ${out}. Pass a new --out.`;
    assert.deepEqual(await start("--wait"), { code: 2, stdout: `[grok | fail | - | usage: ${why} | session=- | out=-]\n`, stderr: `${why}\n` });
    assert.deepEqual(await delegate("result", out), { code: 0, stdout: `${line}\nanswer 1\n`, stderr: "" });
  });

  it("the worker is the grok the engine checked, with the caller's PATH, and git never runs from the target", async (t) => {
    const { bin, home, target, env, out, start, delegate } = fakeSetup(t, { FAKE_ECHO_PATH: "1" }, "grok");
    execFileSync("git", ["init", "-q", target]);
    // Each writes a marker outside the target, so the run's dirty count stays 0
    for (const name of ["grok", "git"]) fs.writeFileSync(path.join(target, name), `#!/bin/sh\necho ${name} >> ${home}/ran-in-target\n`, { mode: 0o755 });
    env.PATH = `.:${bin}:${process.env.PATH}`;
    const line = `[grok | ok | grok-4.7 | medium write sandbox=workspace turns=1 stop=end_turn asks=0 waited=0 denied=0 dirty=0 leftover=0 | session=fake-1 | out=${out}]\n`;
    assert.deepEqual(await start("--mode", "write", "--wait"), { code: 0, stdout: line, stderr: "" });
    assert.equal(fs.existsSync(path.join(home, "ran-in-target")), false);
    // The worker, which starts in the target, keeps the relative entry the caller set
    assert.deepEqual(await delegate("result", out), { code: 0, stdout: `${line}\nPATH=${env.PATH}\n`, stderr: "" });
  });

  it("a provider error after text is partial with the error, and an object or empty message still shows", async (t) => {
    const line = async (message: unknown, afterText: boolean) => {
      const fake = { FAKE_ERROR_MESSAGE: JSON.stringify(message), ...(afterText ? { FAKE_ERROR_AFTER_TEXT: "1" } : {}) };
      const { out, started } = await fakeStart(t, fake, "grok", "--wait");
      return started.stdout.replace(` | session=fake-1 | out=${out}]\n`, "");
    };
    const [partial, object, empty] = await Promise.all([line("rate limited on grok-4.7", true), line({ reason: "quota" }, false), line("", false)]);
    assert.equal(partial, `[grok | partial | grok-4.7 | medium read sandbox=read-only provider error: rate limited on grok-4.7 turns=1 stop=error ${counts}`);
    assert.equal(object, `[grok | fail | grok-4.7 | medium read sandbox=read-only provider error: { reason : quota } turns=1 stop=error ${counts}`);
    assert.equal(empty, `[grok | fail | grok-4.7 | medium read sandbox=read-only provider error: (empty) turns=1 stop=error ${counts}`);
  });

  const okLine = (out: string) => `[grok | ok | grok-4.7 | medium read sandbox=read-only turns=1 stop=end_turn ${counts} | session=fake-1 | out=${out}]\n`;

  it("run --wait prints only the final line, --wait --answer adds the answer, and result prints both", async (t) => {
    const [waited, answered] = await Promise.all([fakeRun(t, "", "--wait"), fakeRun(t, "", "--wait", "--answer")]);
    assert.deepEqual(waited.started, { code: 0, stdout: okLine(waited.out), stderr: "" });
    assert.equal(fs.readFileSync(path.join(waited.out, "status"), "utf8"), okLine(waited.out));
    assert.deepEqual(await waited.delegate("result", waited.out), { code: 0, stdout: `${okLine(waited.out)}\nanswer 1\n`, stderr: "" });
    assert.deepEqual(answered.started, { code: 0, stdout: `${okLine(answered.out)}\nanswer 1\n`, stderr: "" });
  });

  it("run --answer without --wait waits for the end and prints the final line and the answer", async (t) => {
    const { out, started } = await fakeRun(t, "", "--answer");
    assert.deepEqual(started, { code: 0, stdout: `${okLine(out)}\nanswer 1\n`, stderr: "" });
  });

  it("a run that ends during startup prints its final line, and --answer and result add a blank line and an empty answer", async (t) => {
    const [plain, answered] = await Promise.all([
      fakeStart(t, GROK_MODELS, "grok", "--model", "grok4.7"),
      fakeStart(t, GROK_MODELS, "grok", "--model", "grok4.7", "--answer"),
    ]);
    const line = (out: string) =>
      `[grok | fail | grok4.7 | medium read sandbox=read-only model not offered; nearest: grok-4.7, grok-4.7-build-fast, grok-4.5 turns=0 stop=- ${counts} | session=fake-1 | out=${out}]\n`;
    assert.deepEqual(plain.started, { code: 1, stdout: line(plain.out), stderr: "" });
    // The run ends before its first turn, so the answer block after the blank line is empty
    assert.deepEqual(answered.started, { code: 1, stdout: `${line(answered.out)}\n`, stderr: "" });
    assert.deepEqual(await answered.delegate("result", answered.out), answered.started);
  });
});
