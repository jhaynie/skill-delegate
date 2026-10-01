# delegate plugin

A Claude Code plugin that runs `delegate` workers as background agents, so
each run shows in the Agents panel. The
[`delegate` skill](../SKILL.md) owns routing and
the brief, and the [package README](../README.md) is the
runtime reference.

## What it adds

One forwarding agent per worker CLI, in `agents/`:

- `delegate:codex`
- `delegate:cursor`
- `delegate:devin`
- `delegate:grok`
- `delegate:opencode`

Each agent takes one flag line, runs `delegate run --wait`, and replies with
the final status line only. The parent reads the answer with
`~/.local/bin/delegate result <out>`.

Three commands, in `commands/`:

- `/delegate:status [--cwd <dir>]` lists the live runs.
- `/delegate:result <run>` prints a run's status line and answer.
- `/delegate:cancel <run>` stops a live run.

## Enable it

[Host setup](../references/setup.md#claude-code-plugin) has the install
commands and the permission rule. When a run needs permission for its
`delegate` call, Claude Code prompts you in the main session. In `claude -p`,
nobody can answer it. Add the rule before the first run.

## Editing

`agents/*.md` are generated from the source repository's
`scripts/delegate-agents.json`. From that repository's root, edit the
registry, then run `python3 scripts/generate-delegate-agents.py`. Do not edit
the agent files by hand.
