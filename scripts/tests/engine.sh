#!/usr/bin/env bash
# Run the delegate engine's unit tests, then load every engine module under
# node. Node runs the engine's TypeScript with no build step, and only
# erasable syntax strips, so an enum or a parameter property fails here.
set -uo pipefail

engine="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)/skills/delegate/engine"
fail=0

if ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)'; then
  echo "FAIL: node $(node --version) cannot run the engine; it needs 22.18 or newer"
  exit 1
fi

# Importing a test file runs its tests, and node --test loads those below
for module in "$engine"/*.ts; do
  [[ "$module" == *.test.ts ]] && continue
  if ! out="$(ENGINE_MODULE="$module" node --input-type=module -e 'await import(process.env.ENGINE_MODULE)' 2>&1)"; then
    printf 'FAIL: %s does not load under node\n%s\n' "${module#"$engine"/}" "$(printf '%s\n' "$out" | head -5)"
    fail=1
  fi
done

# The Devin worker copies this template at launch, so a syntax error fails
# every Devin run before its first prompt
if ! out="$(node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$engine/../config/devin-worker.json" 2>&1)"; then
  printf 'FAIL: config/devin-worker.json is not JSON\n%s\n' "$(printf '%s\n' "$out" | grep -m1 Error)"
  fail=1
fi

# Each failing test prints its TAP diagnostic block, with the error,
# expected, actual, and location, so a CI-only failure reads from the log.
# Cursor process-lifecycle and public CLI tests have their own gate check.
tests=()
for f in "$engine"/*.test.ts; do
  case "${f##*/}" in
    cursor-lifecycle.test.ts | cursor-cli.test.ts) continue ;;
  esac
  tests+=("$f")
done
if ! out="$(node --test --test-reporter=tap "${tests[@]}" 2>&1)"; then
  printf '%s\n' "$out" | python3 -c '
import re, sys
end = None
for line in sys.stdin:
    m = re.match(r"( *)not ok ", line)
    if m:
        end = " " * (len(m.group(1)) + 2) + "..."
    if end is not None:
        sys.stdout.write(line)
        if line.rstrip("\n") == end:
            end = None' | head -n 200
  echo "FAIL: engine unit tests"
  fail=1
fi

# Every scratch path is checked before use, so a failed mktemp can never
# leave an empty path for the cleanup to delete
tmp="" home=""
# shellcheck disable=SC2329 # the EXIT trap calls it
cleanup() {
  [[ -n "$tmp" && -d "$tmp" ]] && rm -rf "$tmp"
  [[ -n "$home" && -d "$home" ]] && rm -rf "$home"
}
trap cleanup EXIT
tmp="$(mktemp -d)" && [[ -d "$tmp" ]] || { echo "FAIL: cannot make a temp dir"; exit 1; }
printf 'brief\n' > "$tmp/brief.md"

# Fake worker CLIs: each reads its prompt and answers the way the real one
# reports, so the runners can be checked without a login. Codex rejects
# bad-model with the events a real unknown model produced, and fails
# odd-model on a sign-in error after a warning and an error whose inner
# message is not text, neither of which is a rejection. Cursor's
# rejection text is made up, since no real one was captured, and
# needs-login fails the way a signed-out cursor-agent does.
mkdir -p "$tmp/bin" "$HOME/.cache"
cat > "$tmp/bin/codex" << 'SH'
#!/bin/sh
[ -z "${FAKE_ARGV:-}" ] || printf '%s ' "$@" > "$FAKE_ARGV"
[ -z "${FAKE_SLOW:-}" ] || sleep "$FAKE_SLOW"
model="" answer=""
while [ $# -gt 0 ]; do
  case "$1" in -m) model="$2" ;; -o) answer="$2" ;; esac
  shift
done
cat > /dev/null
if [ "$model" = bad-model ]; then
  cat << 'JSON'
{"type":"thread.started","thread_id":"t-2"}
{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `bad-model` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."}}
{"type":"turn.started"}
{"type":"error","message":"{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'bad-model' model is not supported when using Codex with a ChatGPT account.\"}}"}
{"type":"turn.failed","error":{"message":"{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'bad-model' model is not supported when using Codex with a ChatGPT account.\"}}"}}
JSON
  exit 1
fi
if [ "$model" = odd-model ]; then
  cat << 'JSON'
{"type":"thread.started","thread_id":"t-3"}
{"type":"warning","message":"Using cached metadata for odd-model"}
{"type":"error","message":"{\"error\":{\"message\":[\"odd-model\"]}}"}
{"type":"turn.failed","error":{"message":"Authentication required"}}
JSON
  exit 1
fi
[ -z "${FAKE_SILENT:-}" ] && printf 'hello from codex\n' > "$answer"
[ -z "${FAKE_PROBE:-}" ] || "$FAKE_PROBE" result "$(dirname "$answer")" --quiet > "$(dirname "$answer")/probe"
[ -n "${FAKE_LOCK:-}" ] && chmod a-w "$(dirname "$answer")"
printf '%s\n' '{"type":"thread.started","thread_id":"t-1"}' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}'
SH
cat > "$tmp/bin/cursor-agent" << 'SH'
#!/bin/sh
[ -z "${FAKE_SLOW:-}" ] || sleep "$FAKE_SLOW"
model=""
while [ $# -gt 0 ]; do [ "$1" = --model ] && model="$2"; shift; done
cat > /dev/null
[ -z "${FAKE_FORCE_FAIL:-}" ] || { printf 'forced failure\n' >&2; exit 1; }
case "$model" in
  bad-model) printf '%s\n' '{"is_error":true,"session_id":"c-2","result":"Cannot use this model: bad-model. Available models: auto"}' ;;
  needs-login) printf '%s\n' "Error: Authentication required. Run 'agent login', pass --api-key/--auth-token, or set CURSOR_API_KEY/CURSOR_AUTH_TOKEN." >&2; exit 1 ;;
  *) printf '%s\n' '{"is_error":false,"session_id":"c-1","result":"hello from cursor"}' ;;
esac
SH
chmod +x "$tmp/bin/codex" "$tmp/bin/cursor-agent"
scratch="$(mktemp -d "$HOME/.cache/delegate-engine-test-XXXX")" && home="$(cd "$scratch" && pwd -P)" && [[ -d "$home" ]] ||
  { echo "FAIL: cannot make a scratch dir under $HOME/.cache"; exit 1; }
# Every call below goes through a link to bin/delegate, the way
# ~/.local/bin/delegate reaches it
mkdir -p "$tmp/link"
ln -s "$engine/../bin/delegate" "$tmp/link/delegate"
runner() {
  env -u DELEGATE_OUT_ROOT -u XDG_CACHE_HOME -u CODEX_SESSION_ID -u CURSOR_AGENT HOME="$home" XDG_CONFIG_HOME="$home/.config" \
    PATH="$tmp/bin:$PATH" "$tmp/link/delegate" run --cli "$1" "${@:2}"
}
# Direct default run returns a live line. Tests that need the final line pass --wait.
mkdir -p "$home/target"
git -C "$home" init -q
git -C "$home/target" init -q

# A host never starts a run of its own family. The run root sits outside
# --cwd, so no path refusal can stand in for the host refusal.
for host in GROK_AGENT:grok OPENCODE:opencode CODEX_SESSION_ID:codex CURSOR_AGENT:cursor; do
  cli="${host#*:}"
  env "${host%%:*}=1" HOME="$home" DELEGATE_OUT_ROOT="$home/host-runs" PATH="$tmp/bin:$PATH" "$tmp/link/delegate" run --cli "$cli" \
    --cwd "$home/target" --prompt-file "$tmp/brief.md" > "$tmp/host.out" 2> /dev/null
  code=$?
  if [[ $code -ne 2 || "$(cat "$tmp/host.out")" != "[$cli | fail | - | usage: "*"this host is $cli"*" | session=- | out=-]" || -e "$home/host-runs" ]]; then
    printf 'FAIL: a %s host must not start a %s run: exit %s, run root %s, stdout %s\n' "$cli" "$cli" "$code" \
      "$([[ -e "$home/host-runs" ]] && echo created || echo absent)" "$(cat "$tmp/host.out")"
    fail=1
  fi
done

# bin/delegate runs only the package that holds it. With a readlink that
# prints nothing, it fails instead of running the caller's ../engine.
mkdir -p "$tmp/noreadlink" "$tmp/other/sub" "$tmp/other/engine"
printf '#!/bin/sh\nexit 1\n' > "$tmp/noreadlink/readlink"
chmod +x "$tmp/noreadlink/readlink"
printf 'console.log("other engine")\n' > "$tmp/other/engine/cli.ts"
got="$(cd "$tmp/other/sub" && PATH="$tmp/noreadlink:$PATH" "$tmp/link/delegate" status 2>&1)"
code=$?
if [[ $code -ne 1 || "$got" != "[- | fail | - | delegate cannot find its package from $tmp/link/delegate | session=- | out=-]" ]]; then
  printf 'FAIL: bin/delegate without readlink -f: exit %s, output %s\n' "$code" "$got"
  fail=1
fi

# --help names the docs of the package the link resolves to
pkg="${engine%/engine}"
got="$("$tmp/link/delegate" --help 2> /dev/null | tail -n 1)"
if [[ "$got" != "docs: $pkg/README.md $pkg/docs/runners.md" || ! -f "$pkg/docs/runners.md" ]]; then
  printf 'FAIL: delegate --help through a link printed %s\n' "$got"
  fail=1
fi

# A valued flag at the end must exit instead of repeating the same loop arm.
for cli in codex cursor; do
  if ! python3 - "$tmp/link/delegate" "$cli" <<'PY'
import os, subprocess, sys
delegate, cli = sys.argv[1:]
env = {k: v for k, v in os.environ.items() if k not in ("CODEX_SESSION_ID", "CURSOR_AGENT", "GROK_AGENT", "OPENCODE")}
cmd = [delegate, "run", "--cli", cli, "--cwd"]
try:
    run = subprocess.run(cmd, capture_output=True, text=True, timeout=3, env=env)
except subprocess.TimeoutExpired:
    print(f"FAIL: {cli} --cwd looped instead of exiting 2")
    sys.exit(1)
want = f"[{cli} | fail | - | usage: --cwd needs a value | session=- | out=-]\n"
if run.returncode != 2 or run.stdout != want:
    print(f"FAIL: {cli} --cwd: exit {run.returncode}, stdout {run.stdout!r}, want {want!r}")
    sys.exit(1)
PY
  then
    fail=1
  fi
done

# User fields cannot add a physical status line, in stdout or status.
for cli in codex cursor; do
  bad_model=$'m\rnext\tpart\nlast'
  bad_out="$home/runs/$cli"$'\nsecond|]'
  runner "$cli" --cwd "$home/target" --prompt-file "$tmp/brief.md" --model "$bad_model" --wait --out "$bad_out" > "$tmp/control.out" 2>&1
  code=$?
  flat_out="${bad_out//$'\n'/ }"
  line="[$cli | ok | m next part last | "
  if [[ $code -ne 0 || "$(wc -l < "$tmp/control.out" | tr -d ' ')" != 1 || "$(cat "$tmp/control.out")" != "$line"* ||
    "$(cat "$bad_out/status")" != "$(cat "$tmp/control.out")" || "$(cat "$tmp/control.out")" != *"out=$flat_out]" ]]; then
    printf 'FAIL: delegate run --cli %s final status contains controls or differs from status: exit %s, stdout %q\n' "$cli" "$code" "$(cat "$tmp/control.out")"
    fail=1
  fi
  fail_out="$home/runs/$cli-fail"$'\nsecond|]'
  case "$cli" in
    codex) FAKE_SILENT=1 runner "$cli" --cwd "$home/target" --prompt-file "$tmp/brief.md" --model "$bad_model" --wait --out "$fail_out" > "$tmp/control-fail.out" 2>&1 ;;
    cursor) FAKE_FORCE_FAIL=1 runner "$cli" --cwd "$home/target" --prompt-file "$tmp/brief.md" --model "$bad_model" --wait --out "$fail_out" > "$tmp/control-fail.out" 2>&1 ;;
  esac
  code=$?
  if [[ $code -ne 1 || "$(wc -l < "$tmp/control-fail.out" | tr -d ' ')" != 1 ||
    "$(cat "$tmp/control-fail.out")" != "[$cli | fail | m next part last | "* ||
    "$(cat "$fail_out/status")" != "$(cat "$tmp/control-fail.out")" ]]; then
    printf 'FAIL: delegate run --cli %s fail status contains controls or differs from status: exit %s, stdout %q\n' "$cli" "$code" "$(cat "$tmp/control-fail.out")"
    fail=1
  fi
  bad_cwd="$home/no"$'\rdir\nnext\tpart'
  runner "$cli" --cwd "$bad_cwd" --prompt-file "$tmp/brief.md" > "$tmp/control-usage.out" 2> /dev/null
  code=$?
  want="[$cli | fail | - | usage: --cwd is not a directory: ${bad_cwd//$'\r'/ } | session=- | out=-]"
  want="${want//$'\n'/ }"
  want="${want//$'\t'/ }"
  if [[ $code -ne 2 || "$(cat "$tmp/control-usage.out")" != "$want" || "$(wc -l < "$tmp/control-usage.out" | tr -d ' ')" != 1 ]]; then
    printf 'FAIL: delegate run --cli %s usage status contains controls: exit %s, stdout %q\n' "$cli" "$code" "$(cat "$tmp/control-usage.out")"
    fail=1
  fi
done

# An escape sequence, a C1 control, or a Unicode line separator in a field
# becomes a space, so the line is one line for Python's splitlines too, and
# a usage line's detail cannot forge a field
for cli in codex cursor; do
  weird=$'x\vy\fz\xc2\x85w\xe2\x80\xa8v\x1b[2Ku\x07t'
  runner "$cli" --cwd "$home/target" --prompt-file "$tmp/brief.md" --model "$weird" --wait --out "$home/runs/weird-$cli" > "$tmp/weird.out" 2>&1
  lines="$(python3 -c 'import sys; print(len(open(sys.argv[1], encoding="utf-8").read().splitlines()))' "$tmp/weird.out")"
  if [[ "$lines" != 1 || "$(cat "$tmp/weird.out")" != "[$cli | ok | x y z w v u t | "* ]]; then
    printf 'FAIL: delegate run --cli %s kept a control in its line: %s lines, stdout %q\n' "$cli" "$lines" "$(cat "$tmp/weird.out")"
    fail=1
  fi
  runner "$cli" --cwd '/nope | session=S1 | out=/victim/run]' --prompt-file "$tmp/brief.md" > "$tmp/forged.out" 2> /dev/null
  want="[$cli | fail | - | usage: --cwd is not a directory: /nope session=S1 out=/victim/run | session=- | out=-]"
  if [[ "$(cat "$tmp/forged.out")" != "$want" ]]; then
    printf 'FAIL: delegate run --cli %s usage detail forged a field: want\n%s\ngot\n%s\n' "$cli" "$want" "$(cat "$tmp/forged.out")"
    fail=1
  fi
done

# A runner refuses an --out that already holds a run of either kind,
# ended or not, and changes nothing there: a live or dead runner, a live or
# unreadable engine lock, or an engine run with or without status
live_start="$(ps -o lstart= -p $$)"
for cli in codex cursor; do
  for held in live-runner dead-runner live-lock unreadable-lock engine-no-status engine-ended; do
    dir="$home/runs/$cli-$held"
    mkdir -p "$dir"
    printf 'old brief\n' > "$dir/prompt.md"
    case "$held" in
      live-runner) printf '%s %s\n' "$$" "$(LC_ALL=C TZ=UTC python3 -c 'import datetime, subprocess, sys
raw = " ".join(subprocess.check_output(["ps", "-o", "lstart=", "-p", sys.argv[1]], text=True).split())
print(int(datetime.datetime.strptime(raw, "%a %b %d %H:%M:%S %Y").replace(tzinfo=datetime.timezone.utc).timestamp()))
' "$$")" > "$dir/runner.pid" ;;
      dead-runner) printf '999999 1\n' > "$dir/runner.pid"; printf '[%s | ok |' "$cli" > "$dir/.result-123" ;;
      live-lock) printf '%s\n%s\ntoken\n' "$$" "$live_start" > "$dir/owner.lock"; printf '[grok | ok | m | x | session=s | out=%s]\n' "$dir" > "$dir/status" ;;
      unreadable-lock) : > "$dir/owner.lock"; printf '{}\n' > "$dir/spec.json"; printf 'old\n' > "$dir/status" ;;
      engine-no-status) printf '{}\n' > "$dir/spec.json" ;;
      engine-ended) printf '{}\n' > "$dir/spec.json"; printf '999999\n%s\ntoken\n' "$live_start" > "$dir/owner.lock"
        printf '[grok | ok | m | x | session=s | out=%s]\n' "$dir" > "$dir/status" ;;
    esac
    before="$(ls -A "$dir")"
    runner "$cli" --cwd "$home/target" --prompt-file "$tmp/brief.md" --out "$dir" > "$tmp/held.out" 2> /dev/null
    code=$?
    out="$(cat "$tmp/held.out")"
    if [[ $code -ne 2 || "$out" != "[$cli | fail | - | usage: --out already holds a run: "*"$held. Pass a new --out. | session=- | out=-]" ||
      "$(cat "$dir/prompt.md")" != 'old brief' || "$(ls -A "$dir")" != "$before" ]]; then
      printf 'FAIL: delegate run --cli %s over a %s directory: exit %s, stdout %s\n' "$cli" "$held" "$code" "$out"
      fail=1
    fi
  done
  # An empty directory, or one with only a dead run's lock and claim file, is free
  for free in empty dead-lock; do
    dir="$home/runs/$cli-$free"
    mkdir -p "$dir"
    if [[ "$free" == dead-lock ]]; then
      printf '999999\n%s\ntoken\nutc\n' "$live_start" > "$dir/owner.lock"
      printf '999999\n%s\nother\nutc\n' "$live_start" > "$dir/owner.lock.0123456789abcdef0123456789abcdef01234567.0"
    fi
    runner "$cli" --cwd "$home/target" --prompt-file "$tmp/brief.md" --wait --out "$dir" > "$tmp/free.out" 2> /dev/null
    code=$?
    if [[ $code -ne 0 || "$(cat "$tmp/free.out")" != "[$cli | ok | "* ]]; then
      printf 'FAIL: delegate run --cli %s over a %s directory: exit %s, stdout %s\n' "$cli" "$free" "$code" "$(cat "$tmp/free.out")"
      fail=1
    fi
  done
  # Anything but a lock holds the directory, dotfiles and symlinks included
  for held in workspace runner-pid-temp state-temp workspace-link dangling-answer fifo-lock dir-claim; do
    dir="$home/runs/$cli-$held"
    mkdir -p "$dir"
    case "$held" in
      workspace) mkdir -p "$dir/workspace/.git" ;;
      runner-pid-temp) printf '123 1\n' > "$dir/.runner.pid-123" ;;
      state-temp) printf '{}\n' > "$dir/.tmp-1-state.json" ;;
      workspace-link) ln -s "$home/target" "$dir/workspace" ;;
      dangling-answer) ln -s "$home/nowhere" "$dir/answer.md" ;;
      fifo-lock) mkfifo "$dir/owner.lock" ;;
      dir-claim) mkdir "$dir/owner.lock.$(printf 'a%.0s' {1..40}).0" ;;
    esac
    before="$(ls -A "$dir")"
    # Opening a FIFO lock for writing frees a runner that blocked reading it
    ( sleep 20; [[ -p "$dir/owner.lock" ]] && : > "$dir/owner.lock" ) &
    watchdog=$!
    runner "$cli" --cwd "$home/target" --prompt-file "$tmp/brief.md" --out "$dir" > "$tmp/held.out" 2> /dev/null
    code=$?
    kill "$watchdog" 2> /dev/null
    wait "$watchdog" 2> /dev/null
    out="$(cat "$tmp/held.out")"
    if [[ $code -ne 2 || "$out" != "[$cli | fail | - | usage: --out already holds a run: $dir. Pass a new --out. | session=- | out=-]" ||
      "$(ls -A "$dir")" != "$before" ]]; then
      printf 'FAIL: delegate run --cli %s over a %s directory: exit %s, stdout %s\n' "$cli" "$held" "$code" "$out"
      fail=1
    fi
  done
done
rm -rf "$home/runs"

# A flag the runner does not take fails with its name before anything is
# created, wherever --cli sits, with a fail line on stdout
for case in "codex --deadline 45m" "codex --full-access" "cursor --effort low" "cursor --max-turns 3"; do
  read -r cli flag value <<< "$case"
  env -u CODEX_SESSION_ID -u CURSOR_AGENT HOME="$home" PATH="$tmp/bin:$PATH" "$tmp/link/delegate" run \
    --cwd "$home" --cli "$cli" "$flag" ${value:+"$value"} --prompt-file "$tmp/brief.md" --out "$home/runs/rejected" \
    > "$tmp/rejected.out" 2> "$tmp/rejected.err"
  code=$?
  reason="usage: delegate run --cli $cli does not take $flag. It takes --cwd, --prompt-file,"
  out="$(cat "$tmp/rejected.out")"
  if [[ $code -ne 2 || "$out" != "[$cli | fail | - | $reason "*" | session=- | out=-]" || "$(wc -l < "$tmp/rejected.out" | tr -d ' ')" != 1 ||
    "$(cat "$tmp/rejected.err")" != "$reason "* || -e "$home/runs" ]]; then
    printf 'FAIL: delegate run --cli %s %s: exit %s, runs %s\nstdout\n%s\nstderr\n%s\n' "$cli" "$flag" "$code" \
      "$([[ -e "$home/runs" ]] && echo created || echo absent)" "$out" "$(cat "$tmp/rejected.err")"
    fail=1
  fi
done

# A valued flag followed by another flag, or by a value that starts with
# -, has no value, so it exits 2 before anything is created instead of
# passing an option on to the worker CLI
for case in "codex --model --wait" "cursor --model --wait" "codex --resume -x" "cursor --resume -x"; do
  read -r cli flag next <<< "$case"
  runner "$cli" --cwd "$home/target" --prompt-file "$tmp/brief.md" "$flag" "$next" --out "$home/runs/novalue" \
    > "$tmp/novalue.out" 2> /dev/null
  code=$?
  want="[$cli | fail | - | usage: $flag needs a value | session=- | out=-]"
  if [[ $code -ne 2 || "$(cat "$tmp/novalue.out")" != "$want" || -e "$home/runs/novalue" ]]; then
    printf 'FAIL: delegate run --cli %s %s %s: exit %s, run directory %s, want\n%s\ngot\n%s\n' "$cli" "$flag" "$next" "$code" \
      "$([[ -e "$home/runs/novalue" ]] && echo created || echo absent)" "$want" "$(cat "$tmp/novalue.out")"
    fail=1
  fi
done

# A repeated valued flag exits 2 before anything is created, so the last
# value never silently wins
for cli in codex cursor; do
  runner "$cli" --cwd "$home/target" --prompt-file "$tmp/brief.md" --mode read --mode write --out "$home/runs/repeated" \
    > "$tmp/repeated.out" 2> /dev/null
  code=$?
  want="[$cli | fail | - | usage: --mode is given more than once | session=- | out=-]"
  if [[ $code -ne 2 || "$(cat "$tmp/repeated.out")" != "$want" || -e "$home/runs/repeated" ]]; then
    printf 'FAIL: delegate run --cli %s --mode read --mode write: exit %s, run directory %s, want\n%s\ngot\n%s\n' "$cli" "$code" \
      "$([[ -e "$home/runs/repeated" ]] && echo created || echo absent)" "$want" "$(cat "$tmp/repeated.out")"
    fail=1
  fi
done

# A second --cli is a usage error for every worker, so the run never goes to
# the worker the first --cli names while a later one names another
for pair in "cursor codex" "codex codex" "grok codex" "codex grok"; do
  read -r first second <<< "$pair"
  runner "$first" --cwd "$home/target" --cli "$second" --prompt-file "$tmp/brief.md" --out "$home/runs/twice" \
    > "$tmp/twice.out" 2> "$tmp/twice.err"
  code=$?
  want="[$first | fail | - | usage: --cli is given more than once | session=- | out=-]"
  if [[ $code -ne 2 || "$(cat "$tmp/twice.out")" != "$want" || "$(cat "$tmp/twice.err")" != "--cli is given more than once" ||
    -e "$home/runs/twice" ]]; then
    printf 'FAIL: delegate run --cli %s --cli %s: exit %s\nstdout\n%s\nstderr\n%s\n' "$first" "$second" "$code" \
      "$(cat "$tmp/twice.out")" "$(cat "$tmp/twice.err")"
    fail=1
  fi
done

# A direct run refuses a --cwd that contains its run root before it creates
# anything, with the reason on stderr and a fail line on stdout
for cli in codex cursor; do
  runner "$cli" --cwd "$home" --prompt-file "$tmp/brief.md" > "$tmp/usage.out" 2> "$tmp/usage.err"
  code=$?
  why="--cwd puts the worker in $home, which contains $home/.cache/delegate, where run directories go. Pass --cwd the repo or scratch directory the task is about, not a directory above it. Do not add --out to get around this."
  line="[$cli | fail | - | usage: $why | session=- | out=-]"
  if [[ $code -ne 2 || "$(cat "$tmp/usage.err")" != "$why" || "$(cat "$tmp/usage.out")" != "$line" || -e "$home/.cache" ]]; then
    printf 'FAIL: %s with --cwd above its run root: exit %s, run root %s\nstdout\n%s\nstderr\n%s\n' "$cli" "$code" \
      "$([[ -e "$home/.cache" ]] && echo created || echo absent)" "$(cat "$tmp/usage.out")" "$(cat "$tmp/usage.err")"
    fail=1
  fi
done

# A resumed Codex run passes the thread id after --, so codex never reads
# it as an option
FAKE_ARGV="$tmp/argv" runner codex --wait --cwd "$home/target" --prompt-file "$tmp/brief.md" --resume t-9 --out "$home/runs/resume" > /dev/null 2>&1
if [[ "$(cat "$tmp/argv" 2> /dev/null)" != "exec resume "*" -- t-9 - " ]]; then
  printf 'FAIL: codex --resume passed %s\n' "$(cat "$tmp/argv" 2> /dev/null)"
  fail=1
fi

# Only absolute PATH entries count, so a codex in the directory the worker
# starts in never runs: alone it is not installed, and beside a real one
# the real one runs. The cwd is its own git repo so --out under $home/runs
# is outside that git root; $home itself is a git repo for other cases.
# Node lives in a directory that holds only `node`, so a missing-codex PATH
# cannot pick up a real vendor binary next to the interpreter.
mkdir -p "$home/shadow" "$tmp/node-only"
git -C "$home/shadow" init -q
printf '#!/bin/sh\ntouch "%s/shadow-ran"\n' "$tmp" > "$home/shadow/codex"
chmod +x "$home/shadow/codex"
ln -s "$(command -v node)" "$tmp/node-only/node"
for path in ".:/usr/bin:/bin" ".:$tmp/bin:/usr/bin:/bin"; do
  (cd "$home/shadow" && env -u CODEX_SESSION_ID HOME="$home" PATH="$path:$tmp/node-only" "$tmp/link/delegate" run --cli codex \
    --wait --cwd "$home/shadow" --prompt-file "$tmp/brief.md" --out "$home/runs/relpath") > "$tmp/relpath.out" 2> /dev/null
  code=$?
  case "$path" in
    .:/usr/bin:/bin) want_code=1 want="[codex | fail | - | codex is not installed | session=- | out=-]" ;;
    *) want_code=0 want="[codex | ok | gpt-6.1-sol | high read in=1 out=2 | session=t-1 | out=$home/runs/relpath]" ;;
  esac
  if [[ $code -ne $want_code || "$(cat "$tmp/relpath.out")" != "$want" || -e "$tmp/shadow-ran" ]]; then
    printf 'FAIL: codex with PATH=%s: exit %s, shadow %s, stdout %s\n' "$path" "$code" \
      "$([[ -e "$tmp/shadow-ran" ]] && echo ran || echo idle)" "$(cat "$tmp/relpath.out")"
    fail=1
  fi
  rm -rf "$home/runs/relpath" "$tmp/shadow-ran"
done
got="$(env -u CODEX_SESSION_ID HOME="$home" PATH="$tmp/node-only:/usr/bin:/bin" "$tmp/link/delegate" run --cli codex \
  --cwd "$home/target" --prompt-file "$tmp/brief.md" --answer 2> /dev/null; printf x)"
if [[ "$got" != $'[codex | fail | - | codex is not installed | session=- | out=-]\n\nx' ]]; then
  printf 'FAIL: codex --answer with no codex printed %q\n' "$got"
  fail=1
fi

# A run directory the runner cannot make is a usage error before anything
# is written: an --out that is a file, a run root it cannot write, or an
# empty --out it cannot write, where it cannot take the lock
printf 'a file\n' > "$home/notadir"
mkdir -p "$home/ro"
chmod a-w "$home/ro"
for case in file root readonly; do
  case "$case" in
    file) runner codex --cwd "$home/target" --prompt-file "$tmp/brief.md" --out "$home/notadir" > "$tmp/mk.out" 2> "$tmp/mk.err" ;;
    root) env -u CODEX_SESSION_ID HOME="$home" DELEGATE_OUT_ROOT="$home/ro/sub" PATH="$tmp/bin:$PATH" "$tmp/link/delegate" run --cli codex \
      --cwd "$home/target" --prompt-file "$tmp/brief.md" > "$tmp/mk.out" 2> "$tmp/mk.err" ;;
    readonly) runner codex --cwd "$home/target" --prompt-file "$tmp/brief.md" --out "$home/ro" > "$tmp/mk.out" 2> "$tmp/mk.err" ;;
  esac
  code=$?
  out_line="$(cat "$tmp/mk.out")"
  err_line="$(cat "$tmp/mk.err")"
  if [[ $code -ne 2 || "$out_line" != "[codex | fail | - | usage: cannot create"* ||
    "$err_line" != "cannot create"* || "$err_line" == *Traceback* ||
    "$(cat "$home/notadir")" != 'a file' || -n "$(ls "$home/ro")" ]]; then
    printf 'FAIL: codex with an --out it cannot make (%s): exit %s, stdout %s\n' "$case" "$code" "$(cat "$tmp/mk.out")"
    fail=1
  fi
done
chmod u+w "$home/ro"

# A run claims --out by creating owner.lock, so of two runners on one fresh
# --out only one runs, a runner refuses a live engine lock in the current
# format, the engine refuses a runner's lock, and a runner leaves no lock
utc_start="$(LC_ALL=C TZ=UTC ps -o lstart= -p $$ | xargs)"
race="$home/runs/race"
for n in 1 2; do
  FAKE_SLOW=2 runner codex --wait --cwd "$home/target" --prompt-file "$tmp/brief.md" --out "$race" > "$tmp/race-$n.out" 2> /dev/null &
done
wait
codes="$(cat "$tmp/race-1.out" "$tmp/race-2.out" | cut -c1-80 | sort)"
if [[ "$(grep -c '^\[codex | ok | ' <<< "$codes")" != 1 ||
  "$(grep -c "^\[codex | fail | - | usage: --out already holds a run: $race. " <<< "$(cat "$tmp/race-1.out" "$tmp/race-2.out")")" != 1 ||
  -e "$race/owner.lock" ]]; then
  printf 'FAIL: two runners on one fresh --out: %s, lock %s\n' "$(cat "$tmp/race-1.out" "$tmp/race-2.out")" \
    "$([[ -e "$race/owner.lock" ]] && echo left || echo gone)"
  fail=1
fi
# In an --out that holds only owner.lock, the lock decides, and it holds
# unless kill reports no such pid or ps proves the pid has another start.
# Each shim directory gives a run another ps: none, one that fails for the
# pid in $HOLDER, one that prints no start time for it, one that prints
# another start for it but fails, and one that pads the day, as ps does
# early in a month, where a runner's lock collapses it
mkdir -p "$tmp/ps-real" "$tmp/ps-blind" "$tmp/ps-garbage" "$tmp/ps-failing" "$tmp/ps-pad"
cat > "$tmp/ps-blind/ps" << 'SH'
#!/bin/sh
for a; do last=$a; done
[ "$last" = "$HOLDER" ] && exit 1
exec /bin/ps "$@"
SH
cat > "$tmp/ps-garbage/ps" << 'SH'
#!/bin/sh
for a; do last=$a; done
[ "$last" = "$HOLDER" ] && { echo garbage 12; exit 0; }
exec /bin/ps "$@"
SH
cat > "$tmp/ps-failing/ps" << 'SH'
#!/bin/sh
for a; do last=$a; done
[ "$last" = "$HOLDER" ] && { echo "Thu Jan  1 00:00:00 2026"; exit 1; }
exec /bin/ps "$@"
SH
cat > "$tmp/ps-pad/ps" << 'SH'
#!/bin/sh
for a; do last=$a; done
case "$1 $2" in
  "-o pid=,stat=,lstart="|"-o lstart=")
    echo "$last Ss Thu Jan  1 00:00:00 2026   "
    exit 0
    ;;
esac
exec /bin/ps "$@"
SH
chmod +x "$tmp/ps-blind/ps" "$tmp/ps-garbage/ps" "$tmp/ps-failing/ps" "$tmp/ps-pad/ps"
held="$home/runs/utc-lock"
mkdir -p "$held"
printf '%s\n%s\nabc\nutc\n' "$$" "$utc_start" > "$held/owner.lock"
for shim in real blind garbage failing; do
  HOLDER=$$ PATH="$tmp/ps-$shim:$PATH" runner cursor --cwd "$home/target" --prompt-file "$tmp/brief.md" --out "$held" > "$tmp/held.out" 2> /dev/null
  code=$?
  if [[ $code -ne 2 || "$(ls -A "$held")" != owner.lock ||
    "$(cat "$tmp/held.out")" != "[cursor | fail | - | usage: --out already holds a run: $held. owner.lock names pid $$, started $utc_start UTC. Pass a new --out, or remove owner.lock once pid $$ is gone. | session=- | out=-]" ]]; then
    printf 'FAIL: a runner over a live engine lock, ps %s: exit %s, stdout %s\n' "$shim" "$code" "$(cat "$tmp/held.out")"
    fail=1
  fi
done
for lock in legacy unreadable; do
  dir="$home/runs/$lock-lock"
  mkdir -p "$dir"
  case "$lock" in
    legacy) printf '%s\n%s\ntoken\n' "$$" "$live_start" > "$dir/owner.lock"; why="owner.lock names pid $$. Pass a new --out, or remove owner.lock once pid $$ is gone." ;;
    unreadable) : > "$dir/owner.lock"; why="owner.lock cannot be read. Pass a new --out, or remove owner.lock once no run uses the directory." ;;
  esac
  runner codex --cwd "$home/target" --prompt-file "$tmp/brief.md" --out "$dir" > "$tmp/held.out" 2> /dev/null
  code=$?
  if [[ $code -ne 2 || "$(ls -A "$dir")" != owner.lock || "$(cat "$tmp/held.out")" != "[codex | fail | - | usage: --out already holds a run: $dir. $why | session=- | out=-]" ]]; then
    printf 'FAIL: a runner over a %s lock: exit %s, stdout %s\n' "$lock" "$code" "$(cat "$tmp/held.out")"
    fail=1
  fi
done
# Only ESRCH proves a pid gone, so another kill error keeps a dead pid's lock.
# Codex is Node, so intercept process.kill; a Python sitecustomize cannot.
cat > "$tmp/kill-eio.mjs" << 'JS'
const kill = process.kill;
process.kill = (pid, sig) => {
  if (sig === 0) {
    const err = new Error("kill EIO");
    err.code = "EIO";
    throw err;
  }
  return kill(pid, sig);
};
JS
dead="$(sh -c 'echo $$')"
eio="$home/runs/kill-eio"
mkdir -p "$eio"
printf '%s\n%s\nabc\nutc\n' "$dead" "$utc_start" > "$eio/owner.lock"
NODE_OPTIONS="--import file://$tmp/kill-eio.mjs" runner codex --cwd "$home/target" --prompt-file "$tmp/brief.md" --out "$eio" > "$tmp/held.out" 2> "$tmp/held.err"
code=$?
if [[ $code -ne 2 || "$(cat "$tmp/held.out")" != "[codex | fail | - | usage: --out already holds a run: $eio. owner.lock names pid $dead, started $utc_start UTC. Pass a new --out, or remove owner.lock once pid $dead is gone. | session=- | out=-]" ||
  "$(cat "$eio/owner.lock")" != "$(printf '%s\n%s\nabc\nutc' "$dead" "$utc_start")" ]]; then
  printf 'FAIL: a runner when kill fails with EIO: exit %s, stdout %s, stderr %s\n' "$code" "$(cat "$tmp/held.out")" "$(cat "$tmp/held.err")"
  fail=1
fi
printf '#!/bin/sh\nexit 1\n' > "$tmp/bin/grok"
chmod +x "$tmp/bin/grok"
# A runner's lock, day collapsed, still matches a ps that pads the day
padded="$home/runs/padded"
mkdir -p "$padded"
printf '%s\nThu Jan 1 00:00:00 2026\nrunner-x\nutc\n' "$$" > "$padded/owner.lock"
for second in codex grok; do
  PATH="$tmp/ps-pad:$PATH" runner "$second" --cwd "$home/target" --prompt-file "$tmp/brief.md" --out "$padded" > "$tmp/padded.out" 2> /dev/null
  code=$?
  if [[ $code -ne 2 || "$(ls -A "$padded")" != owner.lock || "$(sed -n 3p "$padded/owner.lock")" != runner-x ||
    "$(cat "$tmp/padded.out")" != "[$second | fail | - | usage: --out already holds a run: $padded. owner.lock names pid $$, started Thu Jan 1 00:00:00 2026 UTC. Pass a new --out, or remove owner.lock once pid $$ is gone. | session=- | out=-]" ]]; then
    printf 'FAIL: a %s run over a live runner lock while ps pads the day: exit %s, left %s, stdout %s\n' "$second" "$code" "$(ls -A "$padded")" "$(cat "$tmp/padded.out")"
    fail=1
  fi
done
FAKE_SLOW=3 runner codex --cwd "$home/target" --prompt-file "$tmp/brief.md" --out "$home/runs/runner-held" > /dev/null 2>&1 &
# The client writes run.json before the owner takes the lock. startedAt is
# set only after takeover, so the lock bytes are then the owner's.
for _ in $(seq 1 50); do
  grep -q '"startedAt"' "$home/runs/runner-held/run.json" 2> /dev/null && break
  sleep 0.1
done
lock_body="$(cat "$home/runs/runner-held/owner.lock" 2> /dev/null)"
env -u DELEGATE_OUT_ROOT HOME="$home" PATH="$tmp/bin:$PATH" "$tmp/link/delegate" run --cli grok --cwd "$home/target" \
  --prompt-file "$tmp/brief.md" --out "$home/runs/runner-held" --wait > "$tmp/engine-held.out" 2> /dev/null
code=$?
wait
if [[ $code -ne 2 || "$(cat "$tmp/engine-held.out")" != "[grok | fail | - | usage: --out already holds a run: $home/runs/runner-held. Pass a new --out. | session=- | out=-]" ||
  "$(cat "$home/runs/runner-held/owner.lock" 2> /dev/null)" != "$lock_body" ]]; then
  printf 'FAIL: the engine over a live Codex lock: exit %s, stdout %s, lock %q\n' "$code" "$(cat "$tmp/engine-held.out")" "$lock_body"
  fail=1
fi
rm -f "$tmp/bin/grok"

# A slow Codex default run returns a live line while the worker is still going
FAKE_SLOW=3 runner codex --cwd "$home/target" --prompt-file "$tmp/brief.md" --out "$home/runs/codex-live" > "$tmp/live.out" 2>&1 &
live_pid=$!
for _ in $(seq 1 50); do
  [[ -s "$tmp/live.out" ]] && break
  sleep 0.1
done
if [[ "$(cat "$tmp/live.out")" != "[codex | running | gpt-6.1-sol | high read | session=- | out=$home/runs/codex-live]" ||
  -e "$home/runs/codex-live/status" ]]; then
  printf 'FAIL: default Codex run did not return live: stdout %s, status %s\n' "$(cat "$tmp/live.out")" \
    "$([[ -e "$home/runs/codex-live/status" ]] && echo present || echo absent)"
  fail=1
fi
wait "$live_pid"

# A slow Cursor default run returns a live line while the worker is still going
FAKE_SLOW=3 runner cursor --cwd "$home/target" --prompt-file "$tmp/brief.md" --out "$home/runs/cursor-live" > "$tmp/cursor-live.out" 2>&1 &
cursor_live_pid=$!
for _ in $(seq 1 50); do
  [[ -s "$tmp/cursor-live.out" ]] && break
  sleep 0.1
done
if [[ "$(cat "$tmp/cursor-live.out")" != "[cursor | running | auto | read | session=- | out=$home/runs/cursor-live]" ||
  -e "$home/runs/cursor-live/status" ]]; then
  printf 'FAIL: default Cursor run did not return live: stdout %s, status %s\n' "$(cat "$tmp/cursor-live.out")" \
    "$([[ -e "$home/runs/cursor-live/status" ]] && echo present || echo absent)"
  fail=1
fi
wait "$cursor_live_pid"

# Direct --wait prints only the final line, and status keeps it.
# --answer adds a blank line and the answer, as delegate result does.
mkdir -p "$home/target"
git -C "$home/target" init -q
for cli in codex cursor; do
  case "$cli" in
    codex) flags=(--model m1 --effort low) fields="[codex | ok | m1 | low read in=1 out=2 | session=t-1" ;;
    cursor) flags=(--model m1) fields="[cursor | ok | m1 | read | session=c-1" ;;
  esac
  dir="$home/runs/$cli-line--wait"
  line="$fields | out=$dir]"
  runner "$cli" --cwd "$home/target" --prompt-file "$tmp/brief.md" "${flags[@]}" --wait --out "$dir" > "$tmp/line.out" 2>&1
  code=$?
  if [[ $code -ne 0 || "$(cat "$tmp/line.out"; printf x)" != "$line"$'\nx' ]]; then
    printf 'FAIL: %s --wait: exit %s, want one line\n%s\ngot\n%s\n' "$cli" "$code" "$line" "$(cat "$tmp/line.out")"
    fail=1
  fi
  if ! python3 -c 'import sys; sys.exit(open(sys.argv[1], encoding="utf-8").read() != sys.argv[2] + "\n")' "$dir/status" "$line"; then
    printf 'FAIL: %s status is not exactly its line: %q\n' "$cli" "$(cat "$dir/status" 2> /dev/null)"
    fail=1
  fi
  dir="$home/runs/$cli-answer"
  line="$fields | out=$dir]"
  runner "$cli" --cwd "$home/target" --prompt-file "$tmp/brief.md" "${flags[@]}" --answer --out "$dir" > "$tmp/answer.out" 2>&1
  code=$?
  printf -v want '%s\n\nhello from %s\nx' "$line" "$cli"
  if [[ $code -ne 0 || "$(cat "$tmp/answer.out"; printf x)" != "$want" ]]; then
    printf 'FAIL: delegate run --cli %s --answer: exit %s, want\n%s\ngot\n%s\n' "$cli" "$code" "$want" "$(cat "$tmp/answer.out")"
    fail=1
  fi
  "$tmp/link/delegate" result "$dir" > "$tmp/result.out" 2>&1
  if ! cmp -s "$tmp/answer.out" "$tmp/result.out"; then
    printf 'FAIL: delegate result on a %s run directory differs from run --answer\n%s\n' "$cli" "$(cat "$tmp/result.out")"
    fail=1
  fi
done

# A fail with no answer and no stderr prints the line and a blank line, the
# same bytes delegate result prints for that directory
FAKE_SILENT=1 runner codex --cwd "$home/target" --prompt-file "$tmp/brief.md" --answer --out "$home/runs/silent" > "$tmp/answer.out" 2> /dev/null
code=$?
"$tmp/link/delegate" result "$home/runs/silent" > "$tmp/result.out" 2>&1
want="[codex | fail | gpt-6.1-sol | high exit=0 in=1 out=2 | session=t-1 | out=$home/runs/silent]"
if [[ $code -ne 1 || "$(cat "$tmp/answer.out"; printf x)" != "$want"$'\n\nx' ]] || ! cmp -s "$tmp/answer.out" "$tmp/result.out"; then
  printf 'FAIL: an empty --answer body: exit %s, run printed %q, result printed %q\n' "$code" "$(cat "$tmp/answer.out")" "$(cat "$tmp/result.out")"
  fail=1
fi

# While the worker runs, result prints a live Codex line. After the owner
# is gone and status is removed, result reports owner death.
FAKE_PROBE="$tmp/link/delegate" runner codex --wait --cwd "$home/target" --prompt-file "$tmp/brief.md" --out "$home/runs/pid" > /dev/null 2>&1
rm -f "$home/runs/pid/status"
after="$("$tmp/link/delegate" result "$home/runs/pid" --quiet 2>&1)"
if [[ "$(cat "$home/runs/pid/probe" 2> /dev/null)" != "[codex | running | gpt-6.1-sol | high read | session=- | out=$home/runs/pid]" ||
  "$after" != "[codex | fail | gpt-6.1-sol | high read owner died"* ||
  ! -s "$home/runs/pid/run.json" ]]; then
  printf 'FAIL: live Codex result %s, after %s, run.json %q\n' "$(cat "$home/runs/pid/probe" 2> /dev/null)" "$after" "$(cat "$home/runs/pid/run.json" 2> /dev/null)"
  fail=1
fi
# A runner that died in a default run directory, named for its CLI, reads as
# a dead run of that CLI
mkdir -p "$home/runs/codex-20260101-000000-dead"
printf 'brief\n' > "$home/runs/codex-20260101-000000-dead/prompt.md"
sleep 0 &
gone=$!
wait "$gone"
printf '%s 1\n' "$gone" > "$home/runs/codex-20260101-000000-dead/runner.pid"
got="$("$tmp/link/delegate" result "$home/runs/codex-20260101-000000-dead" --quiet 2>&1)"
if [[ "$got" != "[codex | fail | - | runner died | session=- | out=$home/runs/codex-20260101-000000-dead]" ]]; then
  printf 'FAIL: result on a dead runner printed %s\n' "$got"
  fail=1
fi
mkdir -p "$home/runs/recycled"
printf 'brief\n' > "$home/runs/recycled/prompt.md"
printf '%s 1\n' "$$" > "$home/runs/recycled/runner.pid"
got="$("$tmp/link/delegate" result "$home/runs/recycled" --quiet 2>&1)"
if [[ "$got" != "[- | fail | - | runner died | session=- | out=$home/runs/recycled]" ]]; then
  printf 'FAIL: result took a live pid with another start time for the runner: %s\n' "$got"
  fail=1
fi

# A quoted ~/ in --cwd, --prompt-file, or --out still means the home
# directory, so a caller that quotes every value gets the path it meant
cp "$tmp/brief.md" "$home/brief.md"
for cli in codex cursor; do
  # shellcheck disable=SC2088 # the ~ is literal on purpose
  runner "$cli" --cwd '~/target' --prompt-file '~/brief.md' --wait --out "~/runs/tilde-$cli" > "$tmp/tilde.out" 2>&1
  code=$?
  if [[ $code -ne 0 || "$(cat "$tmp/tilde.out")" != "[$cli | ok | "*" | out=$home/runs/tilde-$cli]" || ! -s "$home/runs/tilde-$cli/status" ]]; then
    printf 'FAIL: delegate run --cli %s with quoted ~/ paths: exit %s, stdout %s\n' "$cli" "$code" "$(cat "$tmp/tilde.out")"
    fail=1
  fi
done

# A Cursor usage error found after the path checks still creates no run
# directory: an unknown read session, or a repo config that widens the sandbox
mkdir -p "$home/wtarget/.cursor"
git -C "$home/wtarget" init -q
printf '{"permissions":{"allow":["Shell(ls)"]}}\n' > "$home/wtarget/.cursor/cli.json"
for refusal in bad-resume widened; do
  case "$refusal" in
    bad-resume) argv=(--cwd "$home/target" --resume no-such-session) ;;
    widened) argv=(--cwd "$home/wtarget" --mode write) ;;
  esac
  runner cursor --prompt-file "$tmp/brief.md" "${argv[@]}" --out "$home/runs/$refusal" > "$tmp/refusal.out" 2> /dev/null
  code=$?
  case "$refusal" in
    bad-resume) want="usage: no workspace recorded for Cursor read session no-such-session. Start a new run." ;;
    widened) want="usage: $home/wtarget/.cursor/cli.json allows commands, which would widen the sandbox. Remove it first." ;;
  esac
  if [[ $code -ne 2 || "$(cat "$tmp/refusal.out")" != "[cursor | fail | - | $want | session=- | out=-]" || -e "$home/runs/$refusal" ]]; then
    printf 'FAIL: cursor %s: exit %s, run directory %s, stdout %s\n' "$refusal" "$code" \
      "$([[ -e "$home/runs/$refusal" ]] && echo created || echo absent)" "$(cat "$tmp/refusal.out")"
    fail=1
  fi
done

# An owner that cannot write status must not report ok, must print a fail
# line, and must not dump a stack trace. The answer stays on disk.
FAKE_LOCK=1 runner codex --wait --cwd "$home/target" --prompt-file "$tmp/brief.md" --out "$home/runs/locked" > "$tmp/locked.out" 2> "$tmp/locked.err"
code=$?
if [[ $code -ne 1 || "$(cat "$tmp/locked.out")" != "[- | fail | - | cannot update run: "*" | out=$home/runs/locked]" ||
  "$(cat "$tmp/locked.err")" == *"    at "* || "$(cat "$tmp/locked.err")" == *"node:fs"* ||
  ! -s "$home/runs/locked/answer.md" ]]; then
  printf 'FAIL: a Codex owner whose status write fails: exit %s, stdout\n%s\nstderr\n%s\n' "$code" "$(cat "$tmp/locked.out")" "$(cat "$tmp/locked.err")"
  fail=1
fi
for command in status result; do
  "$tmp/link/delegate" "$command" "$home/runs/locked" > "$tmp/locked-read.out" 2> "$tmp/locked-read.err"
  code=$?
  if [[ $code -ne 1 || "$(head -n 1 "$tmp/locked-read.out")" != "[- | fail | - | cannot update run: "*" | out=$home/runs/locked]" ||
    "$(cat "$tmp/locked-read.err")" == *"    at "* ||
    ( "$command" == result && "$(tail -n +2 "$tmp/locked-read.out")" != $'\nhello from codex' ) ]]; then
    printf 'FAIL: %s on an unwritable ended run: exit %s, stdout %q, stderr %q\n' "$command" "$code" "$(cat "$tmp/locked-read.out")" "$(cat "$tmp/locked-read.err")"
    fail=1
  fi
done
chmod -R u+w "$home/runs/locked"

# A model the CLI names in its error shows on the fail line as model
# rejected, and a sign-in error does not
for case in "codex bad-model t-2 low exit=1 turn.failed model rejected: The 'bad-model' model is not supported when using Codex with a ChatGPT account." \
  "cursor bad-model c-2 read exit=0 is_error=True model rejected: Cannot use this model: bad-model. Available models: auto" \
  "codex odd-model t-3 low exit=1 turn.failed" \
  "cursor needs-login - read exit=1 is_error=unknown"; do
  read -r cli model session detail <<< "$case"
  flags=(--model "$model")
  [[ "$cli" == codex ]] && flags+=(--effort low)
  runner "$cli" --cwd "$home/target" --prompt-file "$tmp/brief.md" "${flags[@]}" --wait --out "$home/runs/$cli-$model" > "$tmp/fail.out" 2>&1
  code=$?
  line="[$cli | fail | $model | $detail | session=$session | out=$home/runs/$cli-$model]"
  if [[ $code -ne 1 || "$(cat "$tmp/fail.out")" != "$line" ]]; then
    printf 'FAIL: delegate run --cli %s --model %s: exit %s, want\n%s\ngot\n%s\n' "$cli" "$model" "$code" "$line" "$(cat "$tmp/fail.out")"
    fail=1
  fi
done

[[ $fail -eq 0 ]] && echo "PASS: engine"
exit $fail
