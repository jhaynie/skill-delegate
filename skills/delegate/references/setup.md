# Host setup

One-time rules so a host can run `~/.local/bin/delegate`. Install the command first, from the directory that contains `SKILL.md`:

```bash
bash scripts/install.sh
```

That links `~/.local/bin/delegate` on Linux and macOS. It needs Node.js 22.18 or newer on `PATH`. The engine is TypeScript that node runs directly. There is no build step and no package install.

Each worker CLI must be installed and signed in on its own. A missing CLI prints a `fail` line that names it.

| Worker | Sign in |
| --- | --- |
| Codex | `codex login` |
| Cursor | `cursor-agent login` |
| Devin | `devin auth login` |
| Grok | `grok login` |
| OpenCode | `opencode auth login` for the provider of the model you pass |

## Codex host setup

Codex runs its shell inside a Seatbelt sandbox, and macOS cannot start a second Seatbelt sandbox inside it. `delegate` starts Devin, Grok, and Cursor workers in their own sandbox, and every worker keeps its state outside the repo, so on a Codex host `delegate` must run outside Codex's sandbox.

Add `~/.codex/rules/delegate.rules`. The pattern is the absolute path of the command. A tilde does not match, and `$HOME` is not expanded. On macOS that path is under `/Users/<you>`. On Linux it is under `/home/<you>` or whatever `echo "$HOME/.local/bin/delegate"` prints.

```python
prefix_rule(pattern=["/absolute/path/to/.local/bin/delegate"], decision="allow")
```

Codex runs a command that matches an `allow` rule outside its sandbox. Call `delegate` by that absolute path, on its own. `cd x && delegate run` does not match. The one rule covers every worker and every command, because `delegate run --cli cursor` starts a detached owner that launches `cursor-agent`. Without the rule, Devin's sandbox cannot start inside Codex's, and Cursor cannot read its login from the Keychain.

Check the rule:

```bash
codex execpolicy check --rules ~/.codex/rules/delegate.rules -- "$HOME/.local/bin/delegate" run --cli cursor
```

For network in Codex's own shell, use a permission profile with network on. The Codex owner defines its own profile with network on, so Codex workers need no setup.

## Cursor host setup

Cursor runs a shell command only after you approve it. Add this rule to `permissions.allow` in `~/.cursor/cli-config.json`, or allow the command in the app's Approvals & Execution settings:

```json
"Shell(**/.local/bin/delegate)"
```

The `**` matches the home directory on both Linux and macOS.

## Claude Code plugin

The plugin shows each worker run in the Agents panel. Its agents call `~/.local/bin/delegate`, so run `scripts/install.sh` first. From a checkout of this repository:

```bash
claude plugin marketplace add <path-to-this-repo>
claude plugin install delegate@delegate
```

From an installed skill directory, without the marketplace:

```bash
claude --plugin-dir <skill-dir>/plugin
```

`<skill-dir>` is the directory that contains `SKILL.md`. The plugin directory inside it is `plugin/`.

When an agent needs permission for a worker call, Claude Code shows the prompt in the main session. In `claude -p`, nobody can answer it. Add this rule to `permissions.allow` in `~/.claude/settings.json`:

```json
"Bash(*/.local/bin/delegate *)"
```

The agents are generated. In the source repository, edit `scripts/delegate-agents.json`, then run `python3 scripts/generate-delegate-agents.py` from the repository root. Do not edit `plugin/agents/*.md` by hand.

Remove a marketplace install with `claude plugin uninstall delegate@delegate`, then `claude plugin marketplace remove delegate`.
