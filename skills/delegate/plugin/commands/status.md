---
description: List the live delegate runs
argument-hint: '[--cwd <dir>]'
allowed-tools: Bash(*/.local/bin/delegate status), Bash(*/.local/bin/delegate status --cwd *)
---

The user's arguments: $ARGUMENTS

- With no arguments, make exactly one `Bash` call:

  ```bash
  ~/.local/bin/delegate status
  ```

- With `--cwd` and one directory, make exactly one `Bash` call that passes
  the directory as one POSIX shell-quoted argument. Wrap it in single quotes
  and write each single quote inside it as `'\''`. A directory that starts
  with `~/` becomes `"$HOME"/` followed by the quoted rest. It lists only the
  runs whose target is that directory or inside it. For `/repo/my app`:

  ```bash
  ~/.local/bin/delegate status --cwd '/repo/my app'
  ```

- With anything else, make no tool call. Reply with the one line
  `Use /delegate:status, or /delegate:status --cwd <dir>.`

Each line ends in `cwd=<target>`, so another session's run shows its own
target. Return the output unchanged.
