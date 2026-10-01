# delegate

One CLI, `delegate`, runs Codex, Cursor, Devin CLI, Grok CLI, and OpenCode
workers and prints one status line for each run. The
[`delegate` skill](SKILL.md) owns routing, the
brief, and the parent's rules. This README is reference for the runtime.

A run is one of two kinds:

- **Managed runs.** Devin, Grok, and OpenCode. The engine's daemon owns the
  run over ACP, the Agent Client Protocol.
- **Direct runs.** Codex and Cursor. The engine's detached owner runs the
  vendor print CLI.

## Install

`scripts/install.sh` links `~/.local/bin/delegate` to `bin/delegate`
in this package. Run it from this directory, on Linux or macOS:

```bash
bash scripts/install.sh
```

The engine needs `node` at the version [`bin/delegate`](bin/delegate) names,
because node runs its TypeScript with no build step. That is Node.js 22.18
or newer. There is no build and no package install.

## Sign in to each worker CLI

Each worker needs its CLI installed and signed in.

| Worker | Sign in |
| --- | --- |
| Codex | `codex login` |
| Cursor | `cursor-agent login` |
| Devin | `devin auth login` |
| Grok | `grok login` |
| OpenCode | `opencode auth login` for the provider of the model you pass |

A missing CLI prints a `fail` line that names it, such as
`[codex | fail | - | codex is not installed | session=- | out=-]`, and leaves no
run directory.

## Commands

`delegate --help` and `delegate -h` print the command sequence, then a
`docs:` line with the absolute paths of this README and
[`docs/runners.md`](docs/runners.md). `delegate <command> --help` prints
that command's flags. `delegate run --cli codex --help` and
`delegate run --cli cursor --help` print that worker's flags. The help
text in [`engine/help.ts`](engine/help.ts) owns the wording. `<run>` is the
`out=` directory from the status line, and flags may come before or after it.

| Command | Behavior |
| --- | --- |
| `delegate run …` | Starts a background worker and prints one status line |
| `delegate status <run>` | Shows progress, completion, or a pending approval. Without `<run>`, lists live runs |
| `delegate result <run>` | Reads the current status and any saved answer without waiting |
| `delegate send <run> "text"` | Queues a follow-up for a live managed run. `--now` interrupts the current turn to deliver it |
| `delegate answer <run> <req> allow\|deny` | Answers a managed run's pending permission request |
| `delegate stop <run>` | Requests termination and process cleanup |
| `delegate prune --older-than 7d --dry-run` | Previews [cleanup of eligible completed runs](#clean-up-old-runs). Without `--dry-run`, applies it |
| `delegate <command> --help` | Prints that command's options |

The controls differ in these ways:

- Default `run` returns after startup. The worker may already have finished
  by then. A direct run may return `starting` while its owner continues
  waiting for startup.
- `run --wait` waits and prints only the final status line. `run --answer`
  waits and prints that line, a blank line, and the answer. `result --wait`
  waits for an existing run. A waiting client's Ctrl-C leaves the owner running.
  On a Codex or Cursor run, `result --wait` stops waiting after the engine's
  default deadline, `DEFAULT_DEADLINE_MS` in [`engine/cli.ts`](engine/cli.ts),
  and prints the live line. `--timeout <seconds>` sets a different wait.
- `run --resume <session>` continues a provider session in a new
  [run folder](#the-run-directory). The session ID and the run folder are
  different identifiers.
- Codex and Cursor support `status`, `result`, and `stop`. They do not
  support `send` or approval `answer`.

> [!NOTE]
> Waiting does not answer permission requests. A managed run in `waiting`
> needs the parent to inspect the request and use `answer`, following the
> skill's [request rule](SKILL.md#run-a-worker).

`bin/delegate` starts the engine. Each worker accepts these run flags:

| Flag | Codex | Cursor | Devin | Grok | OpenCode |
| --- | --- | --- | --- | --- | --- |
| `--cwd`, `--prompt-file`, `--mode`, `--model`, `--resume`, `--out`, `--wait`, `--answer` | Yes | Yes | Yes | Yes | Yes |
| `--effort` | Reasoning effort | No | Thought level | Yes | The model's variant |
| `--tier` | Service tier | No | No | No | No |
| `--full-access` | No | Write mode | Write mode | Write mode | No, there is no sandbox |
| `--deadline` | No | No | Yes | Yes | Yes |

A flag the worker does not take exits 2 with a `fail` line whose detail
starts with `usage:` and names the flag, so a requested limit is never
dropped. A valued flag, `--cli` included, that is repeated or has no value
exits 2 the same way. In every run, a leading `~/` in `--cwd`, `--prompt-file`, or
`--out` names your home directory even when the shell left it quoted.

| Exit status | Meaning |
| --- | --- |
| 0 | `ok` or `partial`, or a live run |
| 1 | `fail`, or a `send` or `answer` the run did not take |
| 2 | Usage error. stdout still gets a `fail` line whose detail starts with `usage:` |

### Command examples

The examples use placeholder paths. `/path/to/brief.md` is an existing brief
file, and `/path/from/out` is the `out=` directory printed by `run`.
The [brief template](SKILL.md#brief-template)
defines the task and result the worker receives.

The CLI's top-level help lists commands and documentation paths:

```bash
~/.local/bin/delegate --help
```

This read-mode Grok run starts in the background. On a Grok host, the
[native helper](references/hosts.md) handles
Grok work instead:

```bash
~/.local/bin/delegate run --cli grok \
  --cwd /path/to/repo --prompt-file /path/to/brief.md
```

`status` reports the run's state. `result` reads its saved answer:

```bash
~/.local/bin/delegate status /path/from/out
~/.local/bin/delegate result /path/from/out
```

For a managed run in `waiting`, the skill's
[request rule](SKILL.md#run-a-worker) explains
when the parent can use `answer`. A `starting` or `running` line means the
worker has more work to do. The [status table](#the-status-line) defines each
state. `result --wait` waits for completion:

```bash
~/.local/bin/delegate result /path/from/out --wait
```

Alternatively, `stop` ends the run:

```bash
~/.local/bin/delegate stop /path/from/out
```

Expire completed local runs that are older than seven days. Preview first:

```bash
~/.local/bin/delegate prune --older-than 7d --dry-run
~/.local/bin/delegate prune --older-than 7d
```

## Choose a model

The skill's "Pick a delegate" table suggests a model and effort for each
task. It is not a gate. Any model the worker CLI lists works with `--model`.
`engine/workers.ts` owns managed defaults. Codex defaults live in
`engine/cli.ts`. Cursor's default is `DEFAULT_MODEL` in `engine/cursor.ts`.

- A managed run checks `--model` against the models the session lists,
  before any setting or prompt, and a model it does not list fails the run.
  A CLI that lists no models gets the ID as given.
- A direct run passes `--model` to its CLI unchecked, and a model the CLI
  rejects fails the run.
- The list names models, not what the account can run, so a listed model can
  still fail at the first prompt, such as an Azure model with no deployment
  behind it.
- The OpenCode worker takes any `provider/model` its session lists, the same
  catalog `opencode models` prints. Its default is an Azure OpenAI
  deployment, so OpenAI-family work can bill to an Azure resource instead of
  a ChatGPT plan.

[Runner notes](docs/runners.md) give the fail line for each case, under
"The status line" and each worker's section.

## The status line

```text
[<cli> | <status> | <model> | <detail> | session=<id> | out=<dir>]
```

Without `--answer`, `delegate run` prints that one line. A managed run and a
direct run return it once the worker has started, unless `--wait` or
`--answer` is given, and the run may already have ended by then. If a
startup wait times out, default `run` prints a live `starting` line and the
owner keeps going. `--wait` and `--answer` still wait for the final line.

`run --answer` waits for the end and prints the final line, a blank line,
then the body. The body is the worker's answer with trailing whitespace
trimmed. On a `fail` with no answer it is the last 20 lines of `stderr.log`
instead, and it may be empty.
`delegate result <run>` prints the same, and `result --quiet` prints the line
alone.

| Status | Exit | Meaning |
| --- | --- | --- |
| `starting` | 0 | The worker has not started yet |
| `running` | 0 | The worker is working |
| `waiting` | 0 | A managed run's worker asked for something the engine does not grant on its own. The line quotes the request |
| `ok` | 0 | The worker finished |
| `partial` | 0 | The worker answered but stopped early, or the parent denied a request |
| `fail` | 1 | The run failed or cleanup could not be confirmed. `result` reads any saved answer or error |

`partial` has two causes. The worker's last turn did not end cleanly, or the
engine cut the run off at its deadline or a `stop`, and the last turn has
text. Without text, those reasons make the run `fail`. Or the parent denied a
request, and the last turn still has text. Only a Devin, Grok, or OpenCode
run ends `partial`. A Codex or Cursor run ends `ok` or `fail`, and
[`engine/direct.ts`](engine/direct.ts) picks between them. An answer that
only promises more work is incomplete even when the status is `ok`, and the
status line cannot detect it.

[Runner notes](docs/runners.md#the-status-line) define every detail field.

## The run directory

Each run gets one directory, the `out=` path, under the run root. The run
root is `$DELEGATE_OUT_ROOT`, else `$XDG_CACHE_HOME/delegate`, else
`~/.cache/delegate`. [`engine/run.ts`](engine/run.ts) owns that order.
`--out <dir>` picks a directory anywhere. A run refuses an `--out` that holds
anything but a lock it may take over, and the
[runner notes](docs/runners.md) give the exact rule.

| File | Written by |
| --- | --- |
| `prompt.md`, `stdout.raw`, `stderr.log`, `answer.md`, `session_id` | Every run that reached the CLI |
| `status` | Every run, once it ends. It holds the final status line |
| `run.json` | Codex and Cursor direct runs. Identity for listing and stop, including `nonce` and `provider` |
| `spec.json`, `state.json`, `events.jsonl` | Managed runs. `events.jsonl` records each request and answer |
| `inbox/` | Managed runs. `status`, `send`, `answer`, and `stop` drop their commands here |
| `turns/` | Managed runs, one transcript per turn. When a `send` started more turns, `result` names the earlier transcripts on its last line |
| `git-before.txt`, `git-after.txt` | Managed runs inside a git work tree |
| `workspace-<nonce>/` | New Devin and Cursor read runs, the scratch workspace named for that run's nonce |
| `workspace/` | Older Devin and Cursor read scratch, still readable. Prune keeps it, and resume does not add pins |
| `workspace-pins/` | New Devin and Cursor read scratch sources. One pin file per resumed run that reuses the workspace |

Every worker can resume by session ID. `--resume <session>` starts a new run
on the same session, in the mode the session started in. Managed runs record
the session ID as soon as the session opens, so a run cut off by its deadline
can still resume. Direct runs save the session ID after execution; resume
requires that recorded ID. A Devin read session resumes only from a run
under the current run root, because the engine looks the session up there
to find its scratch workspace.

## Clean up old runs

`delegate prune --older-than 7d` removes eligible local run folders and their
answers, logs, and scratch workspaces. Cleanup runs only when invoked.
Preview with `--dry-run`; it writes nothing and reports `would delete` with
`would_delete=N deleted=0`. Apply reports `delete` only after removal succeeds.

`--older-than` is required and takes a positive whole duration in `s`, `m`,
`h`, or `d`. The cutoff is calculated once, when the command starts. Age comes
from `completedAt`, the completion time the engine stores when a run ends.
An older run without it uses its last heartbeat, then the final `status`
file's modification time. Completion must be strictly older than the cutoff.

Prune keeps a folder when:

- The run is unfinished, may still be running, or has uncertain cleanup.
- A live process is using the run folder, with its working directory or an
  open file inside it, or a live process is in the run's worker process
  group. The line names the pid.
- Prune cannot list processes, for example because `lsof` is missing. Then
  it keeps every finished run.
- Its workspace has a pin naming an active or recent completed run. The same
  completion cutoff applies to dependents, including custom output paths.
- Its identity, lock, completion time, or dependency records cannot be read
  reliably. Symlink metadata and malformed pins also keep the source.

`leftover=N` on the final line counts worker processes still alive when
cleanup started. The process check above replaces it, so it does not keep a
run.

Only immediate real directories under the [run root](#the-run-directory)
are candidates. A symlink root resolves to its real path; child symlinks
stay. Custom `--out` paths outside that root are never
swept. A missing root is empty; an unreadable or invalid root is an error.

Apply takes the run lock and, for a shared workspace, its dependency lock.
It checks eligibility again, renames the folder within the root, and removes
it. Failed removal exits 1 and names the remaining `.prune-*` path. Later
prune calls keep that path for inspection and manual cleanup.

> Older scratch workspaces without dependency tracking stay. Resuming one
> does not add tracking or make it eligible for deletion.

New scratch paths use `workspace-<nonce>/`. Resume uses the exact saved path
and refuses an expired workspace. Reusing an explicit `--out` after pruning
creates a different scratch path, so an old session cannot attach to the new
run's workspace. Provider-side conversation history is managed separately.

## Where a run may write

A worker can write its own run directory, and the Devin, Cursor, and Grok
sandboxes leave the temp directory writable. These path checks keep the
run directory separate from the target:

| Path | Restriction |
| --- | --- |
| `--out` | Outside system temp directories. Also outside the target's git root, or the target directory when outside git |
| `--cwd` | Outside `--out`. With the default `--out`, its git root or target must not contain the run root |
| Read-mode `--cwd` | Also outside system temp directories, including `$TMPDIR` and `/tmp`. A throwaway target can live under `~/.cache` |

A path refusal leaves no run directory. The checks live in
[`engine/cli.ts`](engine/cli.ts).

Each worker CLI must resolve through an absolute `PATH` entry. A CLI found
only through a relative entry counts as not installed. The engine also
excludes empty and relative entries when finding its own `git` and `ps`.
The worker keeps your `PATH` as given.

The [managed-run notes](docs/runners.md#the-engine-devin-grok-and-opencode)
cover environment filtering. The [Devin notes](docs/runners.md#devin) list
its credential restrictions. Network access can let a worker send out any
file it can read. Managed read-run briefs tell the worker that `gh` is not
logged in. The parent supplies private GitHub data.

## Read mode and write mode

`--mode read` is the default and blocks target edits. Builds and tests that
write files need `--mode write`.

Write mode edits the target in place. Ignored files such as `node_modules`
stay writable, so builds and tests can run. Write-mode `--cwd` must be
inside a git repo, except for Codex.

> [!WARNING]
> No run saves a copy to restore. Concurrent edits share the working tree,
> so `git diff` cannot separate your edits from the worker's.
> Commit or stash your work before a write run, then review its diff.

The [capability table](#what-each-worker-can-reach) lists each worker's
sandbox and tools. The [engine policy](docs/runners.md#the-policy) defines
which requests proceed without the parent's `answer`.

> [!CAUTION]
> OpenCode has no OS sandbox. Read mode has no shell or edit tool.
> Its write-mode shell can write anywhere.

The engine adds runner rules to the prompt of every Devin, Grok, OpenCode,
and Cursor run. They forbid commits, branch switches, and history changes
unless the brief asks for them. A Codex run gets the brief unchanged, so a
Codex brief must state those limits itself. The rules are instructions, not
a sandbox boundary. After every write run, check `git status`, `git log`, and
the diff, even when the run ended `partial` or `fail`. The
[Devin](docs/runners.md#devin) and [Cursor](docs/runners.md#cursor) notes
explain their different protections for `.git`.

## What each worker can reach

| Worker | OS sandbox | Shell | Network | MCP | Write mode edits |
| --- | --- | --- | --- | --- | --- |
| Codex | Codex's own | Yes | Yes | Your Codex MCP servers | The repo |
| Devin | Devin's own | Yes | Yes | None | The repo, through shell commands and its edit tool |
| Cursor | Cursor's own | Yes | Web search only. The shell has none | None | The repo |
| Grok | Grok's own. `read-only` in read mode, `workspace` in write mode | Yes | Yes | Your Grok MCP servers and Claude Code's | The repo |
| OpenCode | None | Write mode only | Yes | None | Edit tools reach the repo, and an edit outside it waits for you. The shell reaches anywhere |

A worker that could call the host's MCP servers could post, deploy, or read
private data with no human in the loop, and the sandbox does not bound a
remote call. So the Cursor owner never passes `--approve-mcps`,
[`devin-worker.json`](config/devin-worker.json) denies `mcp__*`, and the
engine denies OpenCode every tool it does not name and turns off each of the
user's MCP servers by name. The parent fetches MCP data and puts it in the
brief, or routes MCP work to a native subagent.

Grok is the exception. It loads its own MCP servers and the ones it imports
from Claude Code. The engine holds each MCP call for the parent, except under
`--full-access`.

## Full access

Some tasks need what the sandbox blocks, such as a package install that needs
the network or writes a cache outside the repo. `--full-access`, which only
write mode accepts, turns the sandbox off. Cursor gets `--force`. Devin runs
without `DEVIN_SANDBOX` and Grok without `--sandbox`, and the engine allows
every request that offers `allow_once`. The status line says `full-access`
for Cursor and `full` for a managed run, so the parent can see which runs had
no boundary. Codex does not take `--full-access`. It always runs
Codex under its read-only or workspace permission profile. OpenCode refuses
it, because it has no sandbox to turn off.

## Engine lifecycle

Every `run` starts a detached owner process, so the parent can keep working.
A managed owner holds an ACP session. A direct owner runs the vendor CLI.

- The owner process. `delegate run` writes the run directory and starts a
  detached owner process. A managed owner holds the session over ACP, the
  Agent Client Protocol, until the run ends, and it is the only process that
  writes `state.json`. If it dies, the next command ends the run with
  `engine died`. A managed run also ends at `--deadline`. A direct owner
  runs the vendor CLI, writes `run.json`, and honors `stop.json`. If it
  dies, the next command ends the run with `owner died`.
- The inbox. On a managed run, `status`, `send`, `answer`, and `stop` drop a
  file in `inbox/` and read `state.json` back. Direct `status`, `result`, and
  `stop` read `run.json` and `stop.json`. `send` and approval `answer` refuse
  a direct run. The owner is a separate process, so it outlives a host's
  shell timeout, and `delegate run --wait`, `run --answer`, or
  `result --wait` can block while another shell polls `status`.
- The policy. The engine answers the permission requests its policy allows
  and holds the rest for the parent as `waiting`, with the request quoted on
  the status line. The [runner notes](docs/runners.md#the-policy) give the
  policy and what the engine cannot enforce.
- The `dirty=` count. A managed run inside a git work tree reports the
  paths that changed during the run. The `dirty=N` row in the
  [runner notes](docs/runners.md#the-status-line) says how to read it.

## Codex and Cursor

The [status-line reference](docs/runners.md#the-status-line) describes what
`result` prints while a run works and after it dies.

`delegate run` refuses a worker on the same host CLI with exit 2, such as
`--cli codex` inside Codex. The host's native helper handles that work.
[`workers.ts`](engine/workers.ts) defines the host markers used for this
refusal.

## Host setup

The skill's [host notes](references/hosts.md)
hold the agent-facing rules for each host.
[Host setup](references/setup.md) has the one-time rules, each naming
`~/.local/bin/delegate`: the Codex execpolicy rule, the Cursor allow rule, and
the Claude Code permission rule. The Codex rule needs the absolute path, which
differs on macOS and Linux.

## Claude Code plugin

The plugin shows delegate runs in the Agents panel. Its forwarders return
only a status line. The parent reads the answer with
`~/.local/bin/delegate result <out>`.

The skill's [plugin host notes](references/hosts.md#with-the-delegate-plugin)
cover launch, monitoring, and slash commands.
[Host setup](references/setup.md#claude-code-plugin) covers installation
and permission rules. The plugin directory is `plugin/` next to this file.

## Worker notes

[Runner notes](docs/runners.md) keep the engine's permission policy, every
status-line field, and the notes for Devin, Grok, OpenCode, Codex, and
Cursor, with the sandbox probes that shaped them. Read them when a run
returns `partial` or `fail` for a reason you did not expect.

## Layout

```text
SKILL.md                 routing, the brief, and the parent's rules
bin/delegate             the entry point; a thin shim to the engine
engine/                  the TypeScript engine that owns managed and direct runs, and its tests
config/devin-worker.json the Devin worker config template
docs/runners.md          permission policy, status-line fields, per-worker notes
plugin/                  Claude Code plugin
references/              host notes and one-time setup
scripts/install.sh       links ~/.local/bin/delegate
```

## Tests

From the source repository root, `bash scripts/tests/engine.sh` loads every
engine module and runs the unit tests. Node runs the TypeScript with no build
step. `python3 scripts/generate-delegate-agents.py --check` fails when a
plugin agent drifts from `scripts/delegate-agents.json`.
