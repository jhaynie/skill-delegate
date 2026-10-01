# delegate

One command that runs Codex, Cursor, Devin CLI, Grok CLI, and OpenCode as background workers, plus the agent skill that briefs them and checks the result.

Linux and macOS. Node.js 22.18 or newer. No build step and no npm install.

## Install

```bash
npx skills add jhaynie/skill-delegate
```

Then, from the installed skill directory (the folder that contains `SKILL.md`):

```bash
bash scripts/install.sh
```

The script links `~/.local/bin/delegate`. If `~/.local/bin` is not on `PATH`, it prints the line to add.

From a checkout of this repo:

```bash
bash skills/delegate/scripts/install.sh
```

Each worker CLI needs its own login (`codex login`, `cursor-agent login`, `devin auth login`, `grok login`, `opencode auth login`). One-time host rules for the Codex sandbox, the Cursor approval, and the Claude Code plugin are in [skills/delegate/references/setup.md](skills/delegate/references/setup.md).

## Use

The skill in [skills/delegate/SKILL.md](skills/delegate/SKILL.md) is what the agent follows: which worker to pick, how to write the brief, and how to read the status line.

```bash
delegate run --cli grok --cwd <repo> --prompt-file <brief.md>
delegate status <run>
delegate result <run>
```

`<run>` is the `out=` directory from the status line. `delegate --help` prints the rest and the paths of the runtime docs. Command details are in [skills/delegate/README.md](skills/delegate/README.md).

| Workers | How they run |
| --- | --- |
| Devin, Grok, OpenCode | Managed over ACP. `status`, `send`, `answer`, and `stop` work while the run is live. |
| Codex, Cursor | Direct. The owner runs the vendor print CLI. `status`, `result`, and `stop` work. |

## Tests

From the repository root:

```bash
bash scripts/tests/engine.sh
python3 scripts/generate-delegate-agents.py --check
```

## License

[MIT](LICENSE)
