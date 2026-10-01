---
name: delegate
description: Delegate scoped subtasks to Codex, Cursor, Devin CLI, Grok CLI, or OpenCode through the `delegate` CLI, or to the host's native helper agent. Use when the user asks to delegate, use subagents, fan work out, get a second opinion from another model, run adversarial passes, or split a task across models. Not for ordinary single-agent work.
---

# Delegate

Split a task into scoped subtasks, run the independent ones in parallel, then verify and integrate the results yourself. You own the result.

## When to use

- The task has subtasks that can run without each other.
- The user asks to delegate, use subagents, fan work out, or run an adversarial pass.
- You want a second model family to check a design, diagnosis, or review.

## When not to use

- The main session can do the task directly.
- The subtask has no clear question, done condition, or result shape.
- Parallel writers would touch the same files without separate worktrees.
- Another skill you already have is the right tool for this task.

## Pick a delegate

Route by what the subtask needs. A first review is a subtask like any other. For a second opinion, pick a model family other than yours and the first worker's. A family means who made the model (e.g., OpenAI, Anthropic, or xAI), not the CLI that runs it (e.g., OpenCode running GPT counts as OpenAI). If you can't tell which model is running, don't count it as a different family.

| Task | Delegate | Suggested model and effort |
| --- | --- | --- |
| Exploration, broad scans, a cold non-OpenAI read | Grok | `grok-4.7` at `medium`. `high` or `xhigh` for harder judgment |
| OpenAI-family review, implementation, debugging | Codex | `gpt-6.1-sol` at `high`. `medium` for routine work, `xhigh` for especially difficult problems |
| Bulk edits, regression tests, clear-spec implementation | Codex | `gpt-6-luna` at `high` |
| OpenAI-family work billed to Azure OpenAI, or a model only an OpenCode provider exposes | OpenCode | `azure/gpt-6.1-sol` at `medium`. `high` when medium misses |
| Implementation, investigation, docs, independent review, web research | Devin | `swe-2-high` at `medium`. `high` when medium misses |
| Claude-family work, on a host other than Claude Code | Cursor | `claude-opus-5-5-medium` |
| Frontend, design, UI polish | Native helper. From Codex, Grok | The host's own default model, through the mechanism in the Hosts table below. From Codex, `grok-4.7` at `medium` |
| A pass that needs parent context or the host's own tools | Native helper | The host's own default model, through the mechanism in the Hosts table below |

Request any ID the worker CLI lists with `--model`. An ID the worker does not take fails the run, and the fail line names the nearest listed IDs or quotes the CLI's error. A listed ID can still fail at the first prompt when the account cannot run it, such as an Azure model with no deployment behind it, so switch the model or the worker.

## Hosts

Work in your own family goes to your host's own helper. Work in another family goes through `delegate run --cli <worker>`. You can't delegate to the CLI you're running in (e.g., from inside Codex, use Codex's own helper, not `delegate run --cli codex`). Before the first run on a host, read its section in [references/hosts.md](references/hosts.md).

| Host | Own family runs as |
| --- | --- |
| Claude Code | The Agent tool with `model: opus`. `sonnet` for search, tracing, and collection |
| Codex | Native spawn tools |
| Grok CLI | Built-in subagents |
| Cursor | Subagents through its Task tool |
| OpenCode | Subagents through its `task` tool |
| T3 Code | T3 Code runs a Claude Code or Codex provider, so use that row. When its orchestrator offers `delegate_task`, prefer it |

## Run a worker

`delegate run` starts one of two kinds of run:

- **Managed runs.** Devin, Grok, and OpenCode. The engine's daemon owns the run over ACP, so `status`, `send`, `answer`, and `stop` work on it while the worker runs.
- **Direct runs.** Codex and Cursor. The owner runs the vendor print CLI (`codex exec --json` or `cursor-agent` print mode). `status`, `result`, and `stop` work. `send` and approval `answer` are unsupported.

```bash
~/.local/bin/delegate run --cli codex|cursor|devin|grok|opencode --cwd <repo> --prompt-file <brief.md> [--mode read|write] [--model M] [--resume <session>] [--out <dir>] [--wait | --answer]
~/.local/bin/delegate status [<run> | --cwd <dir>]      # <run> is the out= directory from the status line
~/.local/bin/delegate send <run> [--now] "text"
~/.local/bin/delegate answer <run> <req> allow|deny [--widen]
~/.local/bin/delegate stop <run>
~/.local/bin/delegate result <run> [--wait [--timeout <seconds>]] [--quiet]
~/.local/bin/delegate prune --older-than 7d [--dry-run]
```

The `run` line shows the flags every worker takes. `--effort`, `--tier`, `--full-access`, and `--deadline` differ by worker, and `~/.local/bin/delegate run --cli <worker> --help` prints the ones that worker takes. The [flag table](README.md#commands) in the package README shows them side by side.

If `~/.local/bin/delegate` is missing, run `scripts/install.sh` from the directory that contains this file. It links the command on Linux and macOS and needs Node.js 22.18 or newer.

`delegate --help` prints the usage and the docs paths, and `run` rejects a flag the worker does not take or a valued flag that is repeated or has no value. `prune` removes old run folders under the run root. Preview with `--dry-run` first.

1. Write the brief to a file from the template below. Launch independent runs in one turn, each with its recipe.
   - **Plugin agent, Claude Code.** The default in Claude Code. Call the Agent tool with `subagent_type` `delegate:<worker>` and the run flags, `--out` included. It replies with one line, never the answer, so follow the plugin steps in [references/hosts.md](references/hosts.md#with-the-delegate-plugin).
   - **Managed run.** `run` returns once the session opens, and the run may already have ended. Knowing `out=` does not tell you when the worker asks for something, so poll `status <out>` until the run ends and answer each `waiting` line. Then read the answer with `result <out>`.
   - **Direct run.** `run` returns once the worker has started. If that wait times out, default `run` prints a live `starting` line and the owner keeps going; poll `status <out>` or `result <out> --wait`. `--wait` and `--answer` still wait for the final line. `stop <out>` ends it. `send` and approval `answer` are unsupported. The status line shows no progress, so read the worker's event stream in `out=` when you need it. For Codex, `jq -r 'select(.type=="item.completed").item.type' <out>/stdout.raw | sort | uniq -c` counts its commands, edits, and messages so far.
2. Read the first line: `[<cli> | <status> | <model> | <detail> | session=<id> | out=<dir>]`.

   | Status | Meaning | Do |
   | --- | --- | --- |
   | `starting`, `running` | The worker is still starting or working | Keep working. For a managed run, poll `status <out>`, and `send` it a message when it needs one. For a direct run, poll `status <out>` or `result <out> --wait` |
   | `waiting` | A managed run's worker asked for something the engine does not grant on its own. The line quotes the request, cut at 80 characters | Read the request. When the quote is cut, read the full one from the `phase.approval` field in `state.json` under `out=` before you allow it. Allow only actions the task needs and the user's request or earlier instructions permit. Deny an unclear request or one outside the task, such as a Devin edit outside the repo that the brief did not ask for. Run `answer <out> <req> allow` or `answer <out> <req> deny`, where `<req>` is the line's `req=` ID. Some requests offer only a sticky grant, so use the answers the line lists, `allow --widen` included, and name each widening in your report |
   | `ok` | The worker finished | Read the answer |
   | `partial` | The worker answered but stopped early, or you denied a request | Read the answer. Resume only when it is incomplete |
   | `fail` | The worker failed, or cleanup is uncertain | Read `result` for the answer or error, then fix the cause or move the subtask |

3. Read the answer with `result <out>`, which reads either kind of run, or under the final line of `run --answer`. An answer that only promises more work is incomplete under any status. To resume it, write a new brief file that says "Stop inspecting. Synthesize the requested result now." Then start a new run with the same `--cli`, `--cwd`, and `--mode`, plus `--resume <session>` and a new `--out`. Pass the same `--model`, `--effort`, and `--tier` too. A resumed run does not read them from the session, so a missing flag gets the fresh default.
4. Open files in `out=` only for the evidence you need. For runtime details, run `~/.local/bin/delegate --help`. Its `docs:` line gives absolute paths to the package README and `runners.md`. Open the file at that path and read only the section that answers your question:
   - Commands, exit codes, or run files: the package README.
   - Status-line fields, permissions, or worker-specific failures: `runners.md`.

`--mode read` is the default and blocks edits. `--mode write` edits `--cwd` in place, and every worker but Codex needs that `--cwd` inside a git repo. The engine records `git status` before and after a managed run for `dirty=`, but no run restores the repo. So commit your own changes first and leave the repo alone while the worker runs.

`--out`, and in read mode `--cwd`, cannot sit in a temp dir such as `/tmp` or `$TMPDIR`, because the sandboxes leave temp writable. Put a throwaway target under your home directory, such as `~/.cache/<name>`.

- After every write run, `partial` and `fail` included, check `git status`, `git log`, and `git diff --stat`. Read only the diffs that matter.
- `--full-access` turns a worker's sandbox off. Use it only for a task the sandbox blocks, and name the reason in your report.
- Only Codex and Grok see your MCP servers. Cursor's shell has no network. OpenCode has no OS sandbox. Attach private GitHub and MCP data to the brief, or route MCP work to a native helper.

## Brief template

```text
<Read-only delegate.|Write-capable delegate.>

Goal: <specific outcome>
Scope: <the one question or file set this worker owns>
Context: <repo, branch, absolute paths, prior decision>
Rules: Read <absolute path to the nearest AGENTS.md or CLAUDE.md> before anything else.
Use skills: <skill names, or none>
Constraints: <what not to touch, safety rules>
Stop when: <what counts as enough evidence, or "after N commands">
Return: <the evidence the parent will check, commands run, files inspected or changed, verdict>
Return shape: <format and length limit, such as "findings list, max 30 lines, no narration">
```

Workers start cold, so the brief carries everything. Give each worker one scope that no other worker shares. Every brief has a `Stop when` line and a bounded `Return shape`. Point at files and artifacts instead of pasting context.

## Parent rules

- Review every result against files, commands, diffs, or artifacts before you integrate it, and write your own summary.
- When a result misses the bar, tighten the brief or move the subtask to another model. Do not patch over bad work unless the fix is trivial.

## Output

At launch, tell the user each run's worker, model, and `out=` directory. After that, report only a `waiting` run, a failure, or the end. At the end, report which delegates ran, what each was asked, what came back, what you verified, and what you accepted, rejected, or reran. Name each `widened=` grant and each `--full-access` run with its reason.
