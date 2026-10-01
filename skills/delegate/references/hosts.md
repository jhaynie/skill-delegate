# Host notes

Read your host's section before the first run on that host. The `Every host` section applies everywhere.

## Every host

- `~/.local/bin/delegate` runs every worker. When it is missing, run `scripts/install.sh` from the directory that contains `SKILL.md`. It links the command on Linux and macOS. If that script cannot be run, use a native helper, say so in your report, and tell the user to install it.
- Each worker CLI must be installed and signed in. A missing CLI returns a `fail` line that names it. Tell the user, and move the subtask to another family.
- Every worker calls a hosted model, so the host's shell needs outbound network.

## Claude Code

Your own family runs through the Agent tool. Pass `model: opus`. Without it, the Agent tool uses `CLAUDE_CODE_SUBAGENT_MODEL`, else the parent's model. Pass `sonnet` for search, tracing, and collection.

### With the delegate plugin

In Claude Code, launch runs through the plugin by default, so they show in the Agents panel. Use Bash instead when the plugin is missing or you can't start agents. Either way, you still watch the run. Check `delegate status <out>`, answer any approval request, and read the answer with `delegate result <out>`.

1. Write the brief file. Then call the Agent tool with `subagent_type` `delegate:<worker>` and the run flags as the prompt. Pass a new `--out` yourself, so you know the run directory before the agent returns. A run refuses an `--out` that already holds a run. Put it directly under the run root, which is `$DELEGATE_OUT_ROOT`, else `${XDG_CACHE_HOME:-$HOME/.cache}/delegate`, such as `~/.cache/delegate/<name>`, so `status` and `/delegate:status` list it.
2. The agent replies with one line and never the answer. The line is the final status line, a refusal when the flag line is invalid, or an unknown notice when its call was cut off. Read the answer with `~/.local/bin/delegate result <out>`.
3. While the agent blocks on a managed run, nothing tells you when the worker asks for something. Poll `~/.local/bin/delegate status <out>`. Answer a `waiting` line with `~/.local/bin/delegate answer <out> <req> allow|deny`, following the `waiting` row under "Run a worker" in `SKILL.md`. Otherwise the run sits until its deadline. Direct runs have no approval `answer`.
4. When the agent's Bash call passes the tool timeout, Claude Code moves the call to the background, and the agent may reply at once with the unknown notice. The run keeps going, so check it yourself. `~/.local/bin/delegate status <out>` and `~/.local/bin/delegate result <out>` work on a managed or direct run. An owner that is gone without a final line shows as `fail` with `owner died`. A legacy Cursor directory that still has `runner.pid` and no `status` shows as `fail` with `runner died`.

The user can run `/delegate:status`, `/delegate:result <out>`, and `/delegate:cancel <out>`. When a plugin agent needs permission for its `delegate` call, Claude Code shows the prompt in your main session. Pre-approve `delegate` so runs don't stop there. In `claude -p`, nobody can answer the prompt. [setup.md](setup.md#claude-code-plugin) lists the allow rules and how to load `plugin/`.

### Without the plugin

Follow the managed or direct recipe under "Run a worker" in `SKILL.md`. Direct `run` returns once the worker has started, or a live `starting` line if that wait times out while the owner keeps going. `--wait` and `--answer` still wait for the final line.

## Codex

Your own family runs through the native spawn tools. A spawned agent inherits the parent's model unless the brief names one.

Codex runs its shell inside a Seatbelt sandbox, and a worker's own sandbox cannot start inside it. A one-time rule in `~/.codex/rules/delegate.rules` runs `delegate` outside Codex's sandbox. [setup.md](setup.md#codex-host-setup) has the rule. The pattern is the absolute path of `~/.local/bin/delegate`, which is under `/Users` on macOS and under `/home` on Linux.

- Call `delegate` by the absolute path the rule names, such as `/Users/<you>/.local/bin/delegate`, on its own. `cd x && delegate run` does not match the rule.
- Without the rule, a Devin run cannot start its sandbox and a Cursor run cannot sign in. Tell the user about the rule. Do not retry.

## Cursor

Your own family runs as subagents through the Task tool. A custom subagent's `model` field picks the model, and the default, `inherit`, uses the session model. Cursor ignores that field and falls back to another model when the plan does not include the model, an admin blocks it, or a legacy request-based plan lacks Max Mode.

Cursor runs `delegate` only after you allow `Shell(**/.local/bin/delegate)` in its CLI config, or allow the command in the app's Approvals & Execution. [setup.md](setup.md#cursor-host-setup) has the rule.

## Grok CLI

Your own family runs as built-in subagents. They follow `[subagents.models]` in the Grok config when it is set.

## OpenCode

Your own family runs as subagents through the `task` tool, such as `general` and `explore`. A custom agent's `model` field picks the model. Without it, the subagent inherits the session model.

## T3 Code

T3 Code runs a Claude Code or Codex provider. Follow the section for the thread's provider. When T3 Code's orchestrator offers the `delegate_task` tool, prefer it over the provider's native helper.

## Claude-family work from other hosts

There is no Claude Code worker. Other hosts run Claude models through Cursor with `delegate run --cli cursor --model <id>`. Pick the ID from `cursor-agent models`. Cursor's default, `auto`, does not promise a model family, so a second opinion needs a named model. Named models need a paid Cursor plan.
