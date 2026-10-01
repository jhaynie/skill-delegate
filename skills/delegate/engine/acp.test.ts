import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { authRequired, configOptions, locations, modelRefusal, nearest, readBack } from "./acp.ts";

test("a tool call's paths include the files its diffs write", () => {
  const write = {
    locations: [],
    content: [{ type: "diff", path: "/repo/new.txt", newText: "x" }, { type: "content", content: { type: "text", text: "x" } }],
  };
  assert.deepEqual(locations(write, "/repo"), ["/repo/new.txt"]);
  const edit = { locations: [{ path: "/repo/a.txt" }], content: [{ type: "diff", path: "/elsewhere/b.txt" }] };
  assert.deepEqual(locations(edit, "/repo"), ["/repo/a.txt", "/elsewhere/b.txt"]);
});

test("a session error asks for authenticate only on ACP's auth_required code or message", () => {
  assert.equal(authRequired(-32000, "Authentication required"), true);
  assert.equal(authRequired(-32000, "whatever the agent says"), true);
  assert.equal(authRequired(-32603, "Internal error: authentication is required"), true);
  assert.equal(authRequired(-32603, "Internal error: model not found"), false);
  assert.equal(authRequired(-32602, "Invalid params"), false);
});

test("config options read back flat and grouped values, and a missing option is absent", () => {
  const options = configOptions({
    configOptions: [
      { id: "model", currentValue: "azure/gpt-5.6-sol", options: [{ value: "azure/gpt-5.6-sol" }, { value: "azure/gpt-6-luna" }] },
      { id: "effort", category: "thought_level", currentValue: "medium", options: [{ group: "g", options: [{ value: "low" }, { value: "medium" }] }] },
      { id: "mode", category: "mode", currentValue: "plan", options: [] },
      { currentValue: "no id" },
    ],
  });
  assert.deepEqual(options, [
    { id: "model", category: undefined, current: "azure/gpt-5.6-sol", values: ["azure/gpt-5.6-sol", "azure/gpt-6-luna"] },
    { id: "effort", category: "thought_level", current: "medium", values: ["low", "medium"] },
    { id: "mode", category: "mode", current: "plan", values: [] },
  ]);
  assert.deepEqual(readBack(options[2], "plan"), { kind: "match" });
  assert.deepEqual(readBack(options[2], "build"), { kind: "differs", current: "plan" });
  assert.deepEqual(readBack(undefined, "plan"), { kind: "absent" });
});

// Trimmed from the session/new replies of real Devin, Grok, and OpenCode runs
const devinNew = {
  sessionId: "d-1",
  configOptions: [
    {
      id: "model",
      name: "Model",
      description: "AI model to use",
      category: "model",
      type: "select",
      currentValue: "swe-2-high",
      options: [
        { value: "adaptive", name: "Adaptive", _meta: { "cognition.ai/supportsImages": true } },
        { value: "swe-2-high", name: "SWE-2", _meta: { "cognition.ai/supportsImages": true } },
        { value: "claude-opus-5-5-medium", name: "Claude Opus 5.5", _meta: { "cognition.ai/supportsImages": true } },
      ],
    },
  ],
};
const grokNew = {
  sessionId: "g-1",
  configOptions: [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "grok-4.7",
      options: [
        { value: "grok-4.7", name: "Grok 4.7" },
        { value: "grok-4.7-build-fast", name: "Grok 4.7 Fast" },
        { value: "grok-4.6", name: "Grok 4.6" },
        { value: "grok-4.5", name: "Grok 4.5" },
      ],
    },
  ],
};
const opencodeNew = {
  sessionId: "o-1",
  configOptions: [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "opencode/big-pickle",
      options: [
        "opencode/big-pickle",
        "opencode/gpt-6-luna",
        "azure/gpt-5.6-luna",
        "azure/gpt-5.6-sol",
        "azure/gpt-6-astra",
        "azure/gpt-6-luna",
        "azure/gpt-6-sol",
        "openai/gpt-6-luna",
      ].map((value) => ({ value, name: value })),
    },
    { id: "mode", name: "Session Mode", category: "mode", type: "select", currentValue: "build", options: [{ value: "build", name: "build" }, { value: "plan", name: "plan" }] },
  ],
};
const modelOf = (reply: Record<string, unknown>) => configOptions(reply).find((o) => o.id === "model");

test("Devin, Grok, and OpenCode model options yield their advertised value IDs", () => {
  assert.deepEqual(modelOf(devinNew)?.values, ["adaptive", "swe-2-high", "claude-opus-5-5-medium"]);
  assert.deepEqual(modelOf(grokNew)?.values, ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"]);
  assert.equal(modelOf(opencodeNew)?.values.includes("azure/gpt-6-luna"), true);
  assert.deepEqual(configOptions(opencodeNew)[1], { id: "mode", category: "mode", current: "build", values: ["build", "plan"] });
});

test("an advertised model passes even when it is not the CLI's default, and an unlisted one on the same list does not", () => {
  assert.equal(modelRefusal(modelOf(grokNew), "grok-4.5"), null);
  assert.equal(modelRefusal(modelOf(grokNew), "grok-4.4"), "model not offered; nearest: grok-4.5, grok-4.6, grok-4.7");
  assert.equal(modelRefusal(modelOf(opencodeNew), "azure/gpt-6-luna"), null);
  assert.equal(modelRefusal(modelOf(devinNew), "claude-opus-5-5-medium"), null);
});

test("an unadvertised model is refused with at most three nearest IDs, or none", () => {
  assert.equal(modelRefusal(modelOf(grokNew), "grok4.7"), "model not offered; nearest: grok-4.7, grok-4.7-build-fast, grok-4.5");
  assert.equal(
    modelRefusal(modelOf(opencodeNew), "azure/gtp-6-luna"),
    "model not offered; nearest: azure/gpt-6-luna, azure/gpt-5.6-luna, azure/gpt-6-astra",
  );
  assert.equal(modelRefusal(modelOf(grokNew), "zzz"), "model not offered; nearest: none");
});

// The model IDs from the session/new replies of real Devin, Grok, and OpenCode runs
const catalogs: Record<"devin" | "grok" | "opencode", string[]> = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "model-catalogs.test.json"), "utf8"),
);

test("nearest ranks by shared words, then fewest edits, then name, on the recorded catalogs", () => {
  const cases: [keyof typeof catalogs, string, string[]][] = [
    ["grok", "grok-4.7-fast", ["grok-4.7-build-fast", "grok-4.7", "grok-4.5"]],
    ["devin", "swe-2-medium", ["swe-2-high", "swe-1-7-medium", "swe-1-7-lightning-medium"]],
    ["devin", "gpt-6-sol-high", ["gpt-6-sol-medium", "fusion-gpt-6-sol-high-sidekick-gpt-6-luna-high", "fusion-gpt-6-sol-high-sidekick-gpt-5-6-sol-high"]],
    ["devin", "claude-opus-5-5-hgh", ["claude-opus-5-5-medium", "claude-opus-5-medium", "MODEL_CLAUDE_4_5_OPUS"]],
    ["devin", "adaptve", ["adaptive"]],
    ["opencode", "azure/gpt-6-lunna", ["azure/gpt-6-luna", "azure/gpt-6-astra", "azure/gpt-6-sol"]],
    ["opencode", "azure/gtp-6-luna", ["azure/gpt-6-luna", "azure/gpt-5.6-luna", "azure/gpt-6-astra"]],
    ["opencode", "GPT-6-luna", ["azure/gpt-6-luna", "openai/gpt-6-luna", "opencode/gpt-6-luna"]],
  ];
  for (const [cli, wanted, near] of cases) assert.deepEqual(nearest(catalogs[cli], wanted), near, `${cli} ${wanted}`);
  assert.deepEqual(nearest(["b-2", "a-2", "a-2"], "c-2"), ["a-2", "b-2"]);
});

test("a missing or empty model list passes the requested ID to the CLI, and a list without it refuses it", () => {
  assert.equal(modelRefusal(undefined, "anything"), null);
  assert.equal(modelRefusal(modelOf({ configOptions: [{ id: "model", options: [] }] }), "anything"), null);
  assert.equal(modelRefusal(modelOf({ configOptions: [{ id: "model", options: [{ value: "x" }] }] }), "anything"), "model not offered; nearest: none");
});
