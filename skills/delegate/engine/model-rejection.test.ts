import assert from "node:assert/strict";
import { test } from "node:test";
import { modelRejection } from "./model-rejection.ts";

test("modelRejection matches Codex and Cursor rejection shapes and ignores rate limits and metadata items", () => {
  const cases: [string, string, string | null][] = [
    ["gpt-6-sol", "2026-09-27T10:00:00Z WARN codex_core::client: model gpt-6-sol has no local metadata\nError: Authentication required", null],
    ["gpt-6-sol", '{"type":"error","message":"Rate limit reached for gpt-6-sol in organization org-x"}', null],
    ["gpt-6-sol", '{"type":"error","message":"stream disconnected before completion: The model `gpt-6-sol` is overloaded"}', null],
    ["gpt-6-sol", "user instructions: use model gpt-6-sol, it is not supported elsewhere", null],
    [
      "gpt-6-sol",
      '{"type":"turn.failed","error":{"message":"{\\"error\\":{\\"message\\":\\"The requested model does not exist or you do not have access to it.\\",\\"code\\":\\"model_not_found\\"}}"}}',
      "model rejected: The requested model does not exist or you do not have access to it.",
    ],
    [
      "gpt-6-sol",
      '{"is_error":true,"session_id":"c","result":"Cannot use this model: GPT-6-Sol. Available models: auto"}',
      "model rejected: Cannot use this model: GPT-6-Sol. Available models: auto",
    ],
    [
      "gpt-6-sol-max",
      '{"type":"item.completed","item":{"type":"error","message":"Model metadata for `gpt-6-sol-max` not found."}}\n{"type":"item.completed","item":{"type":"error","message":"unsupported model gpt-6-sol-max"}}',
      "model rejected: unsupported model gpt-6-sol-max",
    ],
    ["gpt-6-sol", "Error: unknown model gpt-6-sol", "model rejected: Error: unknown model gpt-6-sol"],
    ["gpt-6-sol", '{"type":"turn.failed","error":{"code":"model_not_found"}}', "model rejected: model_not_found"],
    ["gpt-6-sol", '{"type":"error","message":"{\\"error\\":{\\"type\\":\\"model_not_found\\"}}"}', "model rejected: model_not_found"],
    ["gpt-6", '{"type":"error","message":"unknown model gpt-6.1 | gpt-6-sol"}', null],
    ["m", `Error: model m is not supported ${"x ".repeat(120)}`, `model rejected: Error: model m is not supported ${"x ".repeat(83)}x…`],
  ];
  for (const [model, text, want] of cases) assert.equal(modelRejection(model, [text]), want, text);
});
