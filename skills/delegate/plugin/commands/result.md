---
description: Print a delegate run's status line and answer
argument-hint: '<run>'
allowed-tools: Bash(*/.local/bin/delegate result *)
---

The run to read, as the user gave it: $ARGUMENTS

A run is the `out=` directory from its status line, as a path or as a run
name under the run root. `delegate result` refuses anything that is not a run
directory, so do not check the path first.

- If the user named no run, or more than one, make no tool call. Reply with
  the one line `Name one run directory, the out= path from its status line.`
- Otherwise treat the whole trimmed text as one path. Make exactly one `Bash`
  call that passes it as one POSIX shell-quoted argument. Wrap it in single
  quotes and write each single quote inside it as `'\''`. A path that starts
  with `~/` becomes `"$HOME"/` followed by the quoted rest.

For a run at `/runs/it's here`, the call is:

```bash
~/.local/bin/delegate result '/runs/it'\''s here'
```

Return its output unchanged.
