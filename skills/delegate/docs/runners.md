# Runner notes

Read this when a run returns `partial` or `fail` for a reason you did not
expect, or before a brief that needs a command the default mode blocks.

## The engine: Devin, Grok, and OpenCode

The engine owns managed runs. The package README's
[engine lifecycle](../README.md#engine-lifecycle) covers the owner process
and the inbox. A `running` line shows the minutes left as `left=`.

### The policy

Every permission request the worker sends goes through one rule, `decide` in
[`policy.ts`](../engine/policy.ts).

- The engine answers a request on its own only with the request's exact
  `allow_once` option, and only when the request matches a tool call the
  worker announced, with the same command and kind.
- A shell command is allowed, because the OS sandbox bounds what it can
  write. OpenCode's config decides its shell on its own.
- A read is allowed inside the worker's directory or the target. An edit is
  allowed inside the worker's directory: the repo in write mode, and in a
  Devin read run its scratch workspace. A Grok or OpenCode read worker runs
  in the target, so every edit waits for you.
- Anything else waits for you: a path outside those, an MCP call, Devin's
  `request_scope`, or a request with no matching call. The status line says
  `waiting` and quotes the command, the scope, or a file tool's kind and path.
  Only a request with none of those shows the tool's title, as `title=`,
  because a title can hide what the call does.
- `--full-access` allows every request that offers `allow_once`.
- `answer allow` sends `allow_once`, and `answer deny` sends `reject_once`.
  `answer allow --widen` sends the least sticky allow on offer, a session
  grant but never a bypass or a global one, so the sandbox stays wider for
  the rest of the run. Use it only when the line offers
  `deny|allow --widen` and the task needs the wider grant, and name the
  widening in your report. The skill's `waiting` row says when to allow at
  all.

What the engine cannot enforce:

- The CLI decides what to ask. Grok runs a command it deems read-only, such
  as `cat`, without a request, and so does Devin in its own ways. With
  `--full-access`, Grok gets no `--permission-mode`, so the mode in
  `~/.grok/config.toml` applies.
- The network stays open for every CLI.
- `denied=` counts only your answers. A call Devin's deny list blocks is
  refused inside Devin, and only `stdout.raw` records it.

### The status line

| Field | Meaning | What you do |
| --- | --- | --- |
| `asks=N` | Requests the worker sent | Nothing |
| `waited=N` | Requests that waited for your answer | Nothing, once each is answered |
| `denied=N` | Requests you denied. Devin goes on without them, and Grok and OpenCode end their turn. The run ends `partial` when the last turn has text, else `fail` | Read the answer. Resume only when it is incomplete |
| `widened=N` | Your allows that opened more than the policy would: a sticky grant from `allow --widen`, or an `allow` on a path outside the roots the policy allows on its own. `events.jsonl` marks each answer `"widened":"sticky"` or `"widened":"path"`. Absent at zero | Name each widening in your report |
| `dirty=N` | Paths whose git status or content changed under the target's git root during the run, by the worker or any other writer, such as you or a second worker in the same repo. `dirty=?` means a snapshot failed. Absent for a direct run and outside a git work tree. It never changes the outcome | Read `git-before.txt` and `git-after.txt` in `out=` for the paths. A read-mode worker cannot write the repo, so in a read run a nonzero count is another writer. On `dirty=?`, check `git status` yourself |
| `leftover=N` | Worker processes still alive when cleanup started, which the engine then signalled. `stderr.log` names them. `prune` ignores the count | Nothing |

A current Codex or Cursor run directory holds `run.json` with `nonce` and
`provider`, and `owner.lock` names the live owner. A legacy Cursor directory
may still hold `runner.pid` from its start, the runner's pid and its start
time in seconds since the epoch, so a runner that died shows as dead. A run
that cannot create its run directory exits 2 with a `usage:` line.

Every run needs an `--out` of its own. A run of either kind refuses an
`--out` that already holds a run, ended or not, with
`usage: --out already holds a run: <dir>. Pass a new --out.` and exit 2,
and changes nothing there. An `--out` is free only when it is empty, or
holds nothing but a regular file named `owner.lock`, regular claim files
named `owner.lock.<40 hex>.<n>`, which a takeover leaves, or lock temps named
`.tmp-<pid>-owner.lock`. The lock rules
below then decide on those. Any other entry holds it, a dotfile, a temp
file, a FIFO, a directory, or a symlink included, even one that points
nowhere. So a command or a `result` aimed at one run never
reaches another.

Each run takes `owner.lock` before it writes, so two runs given one fresh
`--out` at once cannot both start. A current owner's lock uses the same
token as a managed owner. A legacy Cursor lock may still hold a nonce that
starts `runner-`. A lock's owner is
gone only on proof. `kill` reports no such process for its pid, or `ps`
reads that pid with another start time, and then the next run takes the
lock. Any other `kill` error, or a `ps` that cannot run, fails for that
pid, or prints no start time, proves nothing, so the lock holds, and a lock
that cannot be read holds too. A lock from an engine that recorded its
start time in its own time zone holds while its pid exists, since that
zone is unknown. A refusal over a held lock names the holder's pid and
start time, and says to pass a new `--out`, or to remove `owner.lock` once
that pid is gone. A current direct run writes `run.json` with `nonce` and
`provider`. A legacy Cursor or Codex runner wrote `runner.pid` right after
it took the lock, and `result` still reads that file by the same rule.

`delegate prune --older-than` uses those same lock and process checks, and
also keeps a run folder that a live process is using. The
[prune contract](../README.md#clean-up-old-runs) covers completion age,
process checks, workspace dependencies, preview, and which older runs stay.

`delegate result` prints a line and an answer only when both come from one
run. On a `fail` with no answer, the error text is the `stderr.log` tail. On
a direct run directory, the status line is the first line of `status`, and
the answer or the failure text follows it. Until
that file is nonempty, `result` on a legacy runner directory prints
`[- | running | - | no final line yet | session=- | out=<dir>]`, and
`result --wait` waits for `status` until `--timeout`, or the engine's
default deadline without it. A legacy runner whose `runner.pid` names a
process that is gone, with no `status`, died. `result` prints
`[<cli> | fail | - | runner died | session=- | out=<dir>]` for it, and
`--wait` stops there. A `runner.pid` that exists but cannot be read counts
as a live runner. A directory with no `runner.pid` at all and no `status`
came from a runner older than `runner.pid`, which has ended. `result` prints
`[<cli> | fail | - | older runner wrote no final line | session=- | out=<dir>]`
and the answer, and `--wait` stops there too. The cli comes from the directory's name, so a default
run directory, `codex-...` or `cursor-...`, names it, and an `--out` whose
name starts with neither shows `-`.

In any status line, every control character, terminal escape sequence, and
Unicode line separator becomes a space, so the line stays one physical line
and prints as written. In a managed run's line, a reason, a request, the
session, and a usage detail lose `|`, `]`, and `"` too, and a direct run's
usage detail loses `|` and `]`, so text from the worker or the caller cannot
add a field. The line is for reading, not parsing, and the model and `out=`
can still hold `|` or `]`.

A `running` line carries `turn=`, `tools=`, the last `sent=`, `asks=`,
`waited=`, `denied=`, and `left=`. A `waiting` line quotes the request. Only
the ended line carries `turns=`, `stop=`, the last turn's stop reason,
`dirty=`, and `leftover=`.

The reasons `stopped`, `deadline`, and an engine error such as
`engine died` or `stop forced` make the run `partial` when the last turn has
text, else `fail` with that reason. A last turn that completes with no text
fails with `empty-after-deny` when you denied a request in the run, and
with `empty` otherwise.

A `--model` the session does not list fails before the first prompt with
`model not offered; nearest: <id>, <id>, <id>`, or `nearest: none`. The line
carries the session, but no prompt was sent, so start a new run with a listed
ID instead of resuming. A CLI that lists no models gets the ID as given, and
its own error decides the run. A last turn the agent answered with an error
fails with `provider error: <message>`, the agent's own words, or is
`partial` with that reason when the turn has text. An empty message reads
`provider error: (empty)`.
A listed ID can still fail this way, such as an Azure model with no
deployment behind it, because the list names models, not what your account
can run. `stderr.log` keeps the full error.

- `send` queues a message for the end of the current turn, shown as
  `sent=queue queued=N`. `send --now` interrupts the turn and sends the
  message as the next prompt, shown as `sent=interrupt`. Managed workers
  do not advertise ACP steering. The worker gets
  15 s to honor the cancel, and `send --now` waits that long plus its usual
  10 s for the acknowledgment. A worker that ignores the cancel ends the
  run with `cancel hung`, and the turn's transcript and answer are kept.
- `answer` and `send` exit 1 with a one-line reason when the run has ended,
  the run rejects the command, or the owner has not acknowledged it within
  its wait. On an ended run neither posts anything.
- A command carries its run's nonce, and a run moves one with another
  nonce to `inbox/rejected/` unread. A request ID such as `req=r1-3fa2c9d1`
  ends in the first 8 hex digits of the nonce. It is matched only inside its
  own `--out`, which holds one run for life. A run made before command
  nonces still reads with `result` and `status`, but `answer`, `send`, and
  `stop` print its line and refuse it with exit 1.
- `stop` cancels the turn and ends the run with `stopped`. It waits while
  the engine's heartbeat stays fresh, up to 60 s, so the shutdown can take
  its `dirty=` snapshot. Past that it forces the end with `stop forced`,
  which carries no `dirty=`. When the run ends on its own before its owner
  reads the stop, even while `stop` forces it, or had ended already, `stop`
  prints the ended line, says `stop not applied: the run had already ended`,
  and exits 0.
- `status` with no run lists every live run under the run root, from any
  session, and ends each line with `cwd=<target>`. `status --cwd <dir>`
  lists only the runs whose target is that directory or inside it.
  `--verbose` also counts the runs it skipped for an older state format.
- Each CLI files a session under its working directory, so a resumed Devin
  read run reuses the scratch workspace of the run that started the
  session.
- Every brief starts with runner rules from
  [`workers.ts`](../engine/workers.ts). The run's `prompt.md` shows
  them. A read-mode Devin worker starts in a scratch workspace, so the rules
  name the target and its rules files.
- The worker's environment drops the host markers and every variable whose
  name looks like a secret, except Devin's own `DEVIN_` variables.

### Devin

- Devin runs as `devin acp` with `DEVIN_SANDBOX=true` unless write mode gets
  `--full-access`. The `--sandbox` flag leaves an ACP session unsandboxed.
- Devin's ACP server offers `swe-2-high` but not `swe-2-medium`. `--effort`
  sets Devin's thought level.
- The edit tool asks under the sandbox. Devin's print mode rejects that
  request even with a `Write` allow rule. Over ACP, the request reaches the
  engine's policy, which allows edits inside the worker's directory. Write
  mode can use either the edit tool or the shell.
- The sandbox and the `Write(.git/**)` deny rule block every write to
  `.git`, so a write-mode worker cannot commit or move a ref. Commit and
  revert in the target yourself.
- Devin writes setup state into the config it is given, so the engine keeps
  one copy of [`devin-worker.json`](../config/devin-worker.json) at
  `~/.config/delegate/devin-worker.json`, records the template's hash in
  `devin-worker.json.template-sha256` beside it, and replaces the copy when
  the template's content changes. Devin's own writes to the copy stay, and
  none reach this package.
- The worker config has no `Exec` allow list, because the sandbox bounds what
  a command can write. Never add a `Write(...)` allow rule: the sandbox makes
  granted paths writable, so the rule would widen it, in read mode too.
- The deny list blocks `sudo`, `git push`, writes to `.git` and agent config,
  and reads of credentials and the macOS keychain. `Exec` rules match only
  the start of a command, so `bash -c` gets past them. `Read` rules hold
  under the sandbox.
- The worker config turns off Devin's own subagents and denies `mcp__*`. The
  worker imports Claude Code's rules, skills, and hooks, and every run loads
  `~/.config/devin/AGENTS.md`.

### Grok

- Grok runs as `grok --sandbox <profile> --permission-mode default agent
  --no-leader stdio`. The explicit mode overrides `permission_mode` in
  `~/.grok/config.toml`, so even with `always-approve` there, Grok's
  requests reach the policy. Read
  mode uses the `read-only` profile with the target as the working
  directory, so the shell and the file tools cannot write the target or
  `~`, and Grok loads the repo's own rules. The profile leaves the temp
  directory writable, as Cursor's and Devin's sandboxes do. A live read
  run wrote to `/tmp`. Write mode uses `workspace`, which makes the repo
  writable. `--full-access` drops both flags.
- A read-mode worker in the target may not edit it, so the policy holds
  every edit request for you.
- The worker sees your Grok MCP servers and the Claude Code servers Grok
  imports. Each MCP call waits for your answer, and the line names the tool,
  such as `title=grep_app__searchGitHub`.
- Grok treats a denied request as a cancel: the turn ends with
  `stop=cancelled`, and the run ends `partial` with the text so far. Resume
  it with a brief that says what to do without the denied call.
- There is no allow list. A command the sandbox blocks needs
  `answer allow --widen` when the line offers it and the task needs the
  command, or a `--full-access` run.

### OpenCode

- OpenCode runs as `opencode acp` in the target with no OS sandbox. The
  engine sets session mode `plan` in read mode and `build` in write mode
  through the session's `mode` config option. `session/new` picks the
  user's default model, so the engine sets `--model` on every run, and any
  `provider/model` the session lists runs. It reads the mode, the model, and
  the effort back before the first prompt.
- The engine writes the agent's permissions into `OPENCODE_CONFIG_CONTENT`,
  which OpenCode merges after `opencode.json`. Every tool is denied, then
  `read`, `glob`, `grep`, `list`, `webfetch`, `websearch`, `codesearch`,
  `todowrite`, `skill`, and `lsp` are allowed. Write mode adds `bash` and
  `edit`, which also covers `write` and `apply_patch`. Every MCP server in
  `opencode debug config` is turned off by name, because OpenCode keeps its
  MCP resource tools while any server is connected. Without that config the
  run fails before the worker starts.
- A managed or organization config, or a user's rule for `plan` or
  `build`, can survive the merge after the engine's deny. So once the session opens, the
  engine runs `opencode debug agent` with the worker's environment. When a
  rule after the deny opens anything the engine did not put there, the run
  fails with `refusing to prompt`, and `stderr.log` names each rule.
- Read mode has no shell and no edit tool. OpenCode gates no shell command,
  and its `plan` prompt alone did not stop `printf hi > hello.txt`. A read
  worker reads, searches, and fetches, and may read outside the target. A
  brief that needs `git`, `gh`, or a test run goes to write mode or to
  another worker.
- Write mode sets `external_directory` to ask, so a file tool call outside
  the repo waits for you. The line quotes it as `other` with its paths. The
  shell can still write anywhere. There is no `--full-access`, because there
  is no sandbox to turn off.
- `--effort` picks the model's variant. The run fails when the model does
  not offer the value. A model with no variants skips it, and `stderr.log`
  says so.
- The user's OpenCode plugins run in the worker, and OpenCode loads the
  repo's `AGENTS.md` on its own.

## Codex

- Codex runs through the engine owner as `codex exec --json`. The owner
  keeps credential variables such as `OPENAI_API_KEY`. It does not use the
  managed-run `baseEnv()` filter, which would strip them.
- The owner always passes `--model`, so it does not inherit the default in
  `~/.codex/config.toml`.
- A model Codex rejects adds `model rejected: <its error>` to the fail line,
  when an error field names the model and says it is unsupported or not
  found, or has the code `model_not_found`. A rate limit or a sign-in error
  never counts. `stderr.log` keeps the full error.
- On a worktree with uncommitted work from an interrupted run, tell the new
  run to inspect that state and continue from it. Note in your report that
  the earlier evidence may predate the resumed run.

## Cursor

- Both modes pass `--sandbox enabled`, unless write mode gets
  `--full-access`. Any shell command runs, and a write outside the workspace
  fails with "Operation not permitted". Network from the sandboxed shell is
  blocked. A `sandbox.json` with `"networkPolicy": {"default": "allow"}` in
  the scratch workspace did not change that.
- The owner never passes `--approve-mcps`, so the worker has no MCP
  servers.
- Cursor cleanup is best effort and TERM-only. Each run has its own process
  group and output files, so sharing a repo does not make another run a
  cleanup target. On normal exit or `stop`, the supervisor tries to stop
  that group, recorded descendants, and processes writing its output files.
  It records descendants every half second and keeps tracking those that
  detach. A process can escape if it loses its ancestry and inherited
  output handles before the next scan. PID reuse between a scan and a
  signal, or within one start-time second, can cause a signal to reach an
  unrelated process. Nothing gets SIGKILL. A process still running at the
  bound makes the line `fail` with `cleanup uncertain`.
- If the owner is killed with SIGKILL, the supervisor sees the IPC channel
  close or its parent pid change, then runs the same TERM cleanup. The
  final line still says `cleanup uncertain`, because the dead owner cannot
  receive the supervisor's report. Other detached descendants may survive.
- The output-file scan counts writers holding `stdout.raw` or `stderr.log`
  whose start time is in the group leader's start second or later. This
  includes a writer that started just before the leader in the same second.
  Readers and earlier writers are excluded. `leftover=N` counts processes
  found at cleanup besides the supervisor. `cleanup uncertain` means a scan
  failed, a signalled process still ran at the bound, or the owner died
  before the supervisor reported. Check for stray `cursor-agent` processes
  yourself. [`cursor-supervisor.ts`](../engine/cursor-supervisor.ts) runs
  the scans. [`direct.ts`](../engine/direct.ts) renders leftover or
  uncertainty once on the final line.
- Commands on a Cursor allow list skip the sandbox. So the worker runs with
  its own config dir, `~/.config/delegate/cursor-config/`, passed as
  `CURSOR_CONFIG_DIR`. The owner creates it on first use and empties its
  allow list whenever a run finds entries there. Sign-in carries over.
- Cursor writes `"sandbox": {"mode": "disabled"}` into that config. The
  `--sandbox enabled` flag overrides it, so the owner leaves it alone, like
  every key but the allow list.
- Read mode runs agent mode in a scratch workspace, `workspace-<nonce>/` in
  `out=`, because Cursor ignores read-only protection for its own workspace.
  An older run's scratch is `workspace/`, which resume still reads.
  Its `.cursor/sandbox.json` lists the target as a read-only path, so
  the worker reads the target by absolute path and cannot write it. The temp
  dir stays writable, because shell here-docs need it, and run directories
  live outside it. The prompt's runner rules name the target and its rules files.
- Write mode runs agent mode with `--workspace` set to the target, where the
  file tools and the shell can both edit. The repo is the workspace, so its
  own Cursor config applies. The owner refuses a repo whose
  `.cursor/cli.json` allows commands, or whose `.cursor/sandbox.json` lists
  `additionalReadwritePaths` or sets `"type": "insecure_none"`, because each
  would widen or skip the sandbox.
- The sandbox protects only `.git/config` and the hooks inside `.git`. A
  write-mode worker can still commit or move a ref, so the prompt's runner
  rules tell it not to. Check `git log` and `git status` after the run.
- The owner passes `--force` only for `--full-access`, and never passes
  `--yolo` or `--auto-review`. Both `--force` and `--auto-review` turn the
  sandbox off. `--auto-review` also lets a classifier approve writes.
- Cursor keeps chats in the config dir and keys each one by its workspace
  path. A write session's workspace is the target, so resume it with the same
  `--cwd`. A read session's workspace is its first run's scratch directory,
  so the owner records that path in `~/.config/delegate/cursor-sessions/` and
  a resumed read run reuses it. Resume a session in the mode it started in. A
  read session this owner did not start cannot resume.
- WebFetch reaches only cursor.com, and WebSearch is unreliable. Send web
  research to Devin.
- Named models need a paid Cursor plan. A free plan runs only `auto`, which
  does not promise a model family, so name a model when the family matters.
- A custom subagent's `model` field is ignored when the plan does not
  include that model, an admin blocks it, or a legacy request-based plan
  lacks Max Mode. [Cursor falls back](https://cursor.com/docs/agent/subagents)
  to another model.
- Treat authentication, billing, and unknown-model errors as final for the
  run and choose another delegate. Do not rerun them. An unknown model adds
  `model rejected: <its error>` to the fail line when Cursor's error names
  the model, in any case, and says it cannot be used.

## Why Devin stays local

Devin CLI can move a session to [Devin Cloud](https://docs.devin.ai/cli/cloud).
The [`/handoff`](https://docs.devin.ai/cli/handoff) command packages the
conversation, the current branch, and any uncommitted diff, then starts a cloud
session on its own VM that keeps working after the local process exits. That
breaks a delegate in three ways:

- The local session ends with no answer.
- The result lands on a pull request branch in the cloud, not in the worktree
  the parent expected to read.
- The cloud session bills separately and ships the uncommitted diff to a remote
  box.

The first Devin runner rule in
[`workers.ts`](../engine/workers.ts) forbids
a cloud handoff, and the worker config sets
[`subagents_enabled`](https://docs.devin.ai/cli/reference/configuration/config-file#subagents_enabled)
to `false` so Devin cannot fan out on its own.
