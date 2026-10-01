#!/usr/bin/env python3
"""Generate the Claude Code delegate plugin's agents from one registry.

scripts/delegate-agents.json lists one forwarding agent per worker CLI: its
name, the flags a parent must pass, and the flags it may pass. Each file in
skills/delegate/plugin/agents/ is rendered from it, with the command built from
the name. Do not edit those files by hand.

  (no flag)    write every agent file and delete any agent file the registry
               does not list
  --check      exit 1 when an agent file is missing, extra, or differs from
               its rendering, when a registry flag disagrees with the flags
               the engine prints for --print-flags, or when a
               plugin command puts $ARGUMENTS or $1 in code
  --self-test  run literal offline cases

Exit 0 when clean, 1 on a failed check, 2 on a registry error.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Literal

ROOT = Path(__file__).resolve().parents[1]
REGISTRY = Path("scripts/delegate-agents.json")
AGENTS_DIR = Path("skills/delegate/plugin/agents")
COMMANDS_DIR = Path("skills/delegate/plugin/commands")
PACKAGE = Path("skills/delegate")
ENGINE_BIN = PACKAGE / "bin/delegate"
REGENERATE = "python3 scripts/generate-delegate-agents.py"
# The path the plugin allow rule Bash(*/.local/bin/delegate *) matches, so
# every command the plugin tells a parent to run must start with it
DELEGATE = "~/.local/bin/delegate"

FlagKind = Literal["value", "boolean"]
AgentKind = Literal["engine", "direct"]


@dataclass(frozen=True)
class Agent:
    cli: str
    label: str
    kind: AgentKind
    required: dict[str, FlagKind]
    optional: dict[str, FlagKind]
    withheld: dict[str, str]

    @property
    def command(self) -> str:
        # A Bash result mixes stderr into stdout, and the usage text there
        # has the bracket shape of a status line
        return f"{DELEGATE} run --cli {self.cli} --wait <quoted flags> 2>/dev/null"

    @property
    def source(self) -> Path:
        return ENGINE_BIN

    @property
    def unknown_notice(self) -> str:
        return f"Run status unknown; check {DELEGATE} status <out> or {DELEGATE} result <out>."


class RegistryError(Exception):
    pass


def load_registry(root: Path) -> list[Agent]:
    try:
        data = json.loads((root / REGISTRY).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise RegistryError(f"{REGISTRY}: {e}") from None
    agents: list[Agent] = []
    errors: list[str] = []
    for entry in data.get("agents", []):
        cli = entry.get("cli", "?")
        try:
            agent = Agent(
                cli=entry["cli"],
                label=entry["label"],
                kind=entry["kind"],
                required=entry["requiredFlags"],
                optional=entry["optionalFlags"],
                withheld=entry["withheldFlags"],
            )
        except KeyError as e:
            errors.append(f"{cli}: missing key {e}")
            continue
        errors.extend(entry_errors(agent))
        agents.append(agent)
    clis = [a.cli for a in agents]
    if len(set(clis)) != len(clis):
        errors.append(f"duplicate cli in {clis}")
    if not agents:
        errors.append("no agents")
    if errors:
        raise RegistryError("\n".join(f"{REGISTRY}: {e}" for e in errors))
    return sorted(agents, key=lambda a: a.cli)


def entry_errors(agent: Agent) -> list[str]:
    errors: list[str] = []
    if agent.kind not in ("engine", "direct"):
        errors.append(f"{agent.cli}: kind must be engine or direct")
    # The parent reads the answer from --out, so it must choose it
    if "--out" not in agent.required:
        errors.append(
            f"{agent.cli}: requiredFlags must include --out, because the "
            "parent reads the answer with `delegate result <out>`"
        )
    if "--answer" in [*agent.required, *agent.optional]:
        errors.append(
            f"{agent.cli}: the agent must not pass --answer, because the "
            "forwarder must never see the worker's answer"
        )
    for flag, kind in {**agent.required, **agent.optional}.items():
        if kind not in ("value", "boolean"):
            errors.append(f"{agent.cli}: {flag} must be value or boolean")
    listed = [*agent.required, *agent.optional, *agent.withheld]
    for flag in sorted({f for f in listed if listed.count(f) > 1}):
        errors.append(f"{agent.cli}: {flag} is listed twice")
    return errors


def read_flags(text: str, source: Path) -> dict[str, FlagKind]:
    """Flags from `--print-flags` output, one `--name value|boolean` per line."""
    flags: dict[str, FlagKind] = {}
    for line in text.splitlines():
        name, _, kind = line.strip().partition(" ")
        if not re.fullmatch(r"--[a-z][a-z0-9-]*", name) or kind not in ("value", "boolean"):
            raise RegistryError(f"{source} --print-flags printed {line!r}, not `--name value|boolean`")
        if name in flags:
            raise RegistryError(f"{source} --print-flags printed {name} twice")
        flags[name] = kind  # type: ignore[assignment]
    if not flags:
        raise RegistryError(f"{source} --print-flags printed no flags")
    return flags


def print_flags(root: Path, agent: Agent) -> str | None:
    """What the agent's parser prints for `--print-flags`, or None when it fails."""
    command = [str(root / ENGINE_BIN), "run", "--cli", agent.cli, "--print-flags"]
    try:
        run = subprocess.run(
            command,
            capture_output=True, text=True, timeout=30, stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    return run.stdout if run.returncode == 0 else None


def flag_errors(agent: Agent, accepted: dict[str, FlagKind]) -> list[str]:
    source = agent.source
    errors: list[str] = []
    for flag, kind in {**agent.required, **agent.optional}.items():
        if flag not in accepted:
            errors.append(
                f"{agent.cli}: {flag} is in the registry, but {source} does not "
                "accept it. Remove it from scripts/delegate-agents.json"
            )
        elif accepted[flag] != kind:
            errors.append(f"{agent.cli}: {flag} is {kind} in the registry but {accepted[flag]} in {source}")
    for flag in agent.withheld:
        if flag not in accepted:
            errors.append(f"{agent.cli}: withheld {flag} is gone from {source}. Remove it from withheldFlags")
    # Agent.command passes --cli and --wait itself
    known = {"--cli", "--wait", *agent.required, *agent.optional, *agent.withheld}
    for flag in accepted:
        if flag not in known:
            errors.append(
                f"{agent.cli}: {source} accepts {flag}, which the registry does "
                "not list. Add it to optionalFlags, or to withheldFlags with the "
                "reason the agent does not forward it"
            )
    return errors


def parser_flags(root: Path, agent: Agent) -> dict[str, FlagKind]:
    printed = print_flags(root, agent)
    if printed is None:
        raise RegistryError(f"{agent.source} --print-flags failed")
    return read_flags(printed, agent.source)


def listing(flags: Iterable[str]) -> str:
    quoted = [f"`{f}`" for f in flags]
    if len(quoted) <= 2:
        return " and ".join(quoted)
    return f"{', '.join(quoted[:-1])}, and {quoted[-1]}"


def render(agent: Agent) -> str:
    required = listing(agent.required)
    booleans = [f for f, k in agent.optional.items() if k == "boolean"]
    plain_required = listing(agent.required).replace("`", "")
    others = "".join(f"`{f}`, " for f in agent.required if f not in ("--prompt-file", "--out"))
    lines = [
        "---",
        f"name: {agent.cli}",
        f"description: Forwards one {agent.label} run from a single flag line. Write the "
        "user's task to a brief file first, then send `--prompt-file` with that file, "
        f"{others}and `--out` set to a new `~/.cache/delegate/<name>` directory. Do not send prose. "
        "The reply carries only a run status line, never the worker's answer, which the "
        f"parent reads with `{DELEGATE} result <out>`.",
        "model: haiku",
        "tools: Bash",
        "background: true",
        "---",
        "",
        f"Forward one {agent.label} run. The prompt must be one flag line.",
        "Every reply you give is exactly one line, with nothing before or after it.",
        "",
        f"Require {required}, each with a value.",
        f"Allow only these other flags: {listing(agent.optional)}.",
    ]
    if booleans:
        verb = "takes" if len(booleans) == 1 else "take"
        lines.append(f"{listing(booleans)} {verb} no value. Every other flag takes one value.")
    lines += [
        "Reject prose, questions, unknown or duplicate flags, and a missing required flag or value.",
        "On rejection, make no tool call and do not answer the prompt. "
        "Your whole reply is one of these lines, with `<flag>` the flag at fault:",
        "`delegate run needs <flag>` for a missing required flag or a flag with no value",
        "`delegate run does not take <flag>` for an unknown or repeated flag",
        f"`delegate run needs a flag line with {plain_required}` for prose or a question",
        "",
        "Make exactly one Bash call, with the Bash tool's `timeout` set to 600000.",
        "Write each flag value as one shell-quoted argument.",
        "",
        "```bash",
        agent.command,
        "```",
        "",
        "Your whole reply is the final status line the command prints, unchanged.",
        "If you are asked again for visible output, repeat that line.",
        "If the call is cut off or prints no status line, your whole reply is this line:",
        f"`{agent.unknown_notice}`",
        "Do not read or relay the answer or the run files.",
        "Do not retry, poll, answer the worker's requests, or stop the run."
        if agent.kind == "engine"
        else "Do not retry, poll, or stop the run.",
    ]
    return "\n".join(lines) + "\n"


ARGUMENT = re.compile(r"\$(ARGUMENTS|\{?[0-9])")
FENCE = re.compile(r" {0,3}(`{3,}|~{3,})")


def command_errors(path: Path, text: str) -> list[str]:
    """$ARGUMENTS or $1 in code, where the user's text becomes shell.

    Code is a ``` or ~~~ fence, an indented line, or an inline span, which
    covers the !`...` form Claude Code runs before the model sees it.
    """
    errors: list[str] = []
    fence = ""
    for number, line in enumerate(text.splitlines(), 1):
        opened = FENCE.match(line)
        if opened and (not fence or opened.group(1).startswith(fence)):
            fence = "" if fence else opened.group(1)
            continue
        if fence or line.startswith(("    ", "\t")):
            code = [line]
        else:
            code = [m.group(2) for m in re.finditer(r"(`+)(.+?)\1", line)]
        found = next((m.group(0) for c in code for m in [ARGUMENT.search(c)] if m), None)
        if found:
            errors.append(
                f"{path}:{number} puts {found} in code. Claude Code pastes "
                "the user's text there as is, so the shell would run whatever it "
                "holds. Name it in prose and have the model pass it as one quoted "
                "argument"
            )
    return errors


def check(root: Path) -> list[str]:
    """Every reason the agent files or the registry are out of date."""
    agents = load_registry(root)
    errors: list[str] = []
    for agent in agents:
        errors.extend(flag_errors(agent, parser_flags(root, agent)))
    expected = {f"{a.cli}.md": render(a) for a in agents}
    on_disk = {p.name for p in (root / AGENTS_DIR).glob("*.md")}
    for name in sorted(expected.keys() - on_disk):
        errors.append(f"{AGENTS_DIR / name} is missing. Run {REGENERATE}")
    for name in sorted(on_disk - expected.keys()):
        errors.append(
            f"{AGENTS_DIR / name} has no entry in {REGISTRY}. Add one, or delete the file"
        )
    for name in sorted(expected.keys() & on_disk):
        if (root / AGENTS_DIR / name).read_text(encoding="utf-8") != expected[name]:
            errors.append(
                f"{AGENTS_DIR / name} differs from its rendering. It is generated, so "
                f"edit {REGISTRY} or the generator, then run {REGENERATE}"
            )
    for command in sorted((root / COMMANDS_DIR).glob("*.md")):
        errors.extend(command_errors(COMMANDS_DIR / command.name, command.read_text(encoding="utf-8")))
    return errors


def write(root: Path) -> list[str]:
    agents = load_registry(root)
    errors = [e for a in agents for e in flag_errors(a, parser_flags(root, a))]
    if errors:
        return errors
    out = root / AGENTS_DIR
    out.mkdir(parents=True, exist_ok=True)
    names = {f"{a.cli}.md" for a in agents}
    for stale in out.glob("*.md"):
        if stale.name not in names:
            stale.unlink()
    for agent in agents:
        (out / f"{agent.cli}.md").write_text(render(agent), encoding="utf-8")
    return []


def self_test() -> int:
    failures: list[str] = []

    def expect(label: str, got: object, want: object) -> None:
        if got != want:
            failures.append(f"{label}: expected {want!r}, got {got!r}")

    expect(
        "printed flags",
        read_flags("--cwd value\n--answer boolean\n", Path("x")),
        {"--cwd": "value", "--answer": "boolean"},
    )
    try:
        read_flags("--cwd value\n--answer boolean\n--cwd boolean\n", Path("x"))
        expect("a flag printed twice", "accepted", "RegistryError")
    except RegistryError as e:
        expect("a flag printed twice", str(e), "x --print-flags printed --cwd twice")
    try:
        read_flags("--cwd value\nusage: delegate run\n", Path("x"))
        expect("usage text is not a flag list", "accepted", "RegistryError")
    except RegistryError as e:
        expect("usage text is not a flag list", str(e), "x --print-flags printed 'usage: delegate run', not `--name value|boolean`")

    grok = Agent(
        cli="grok",
        label="Grok CLI",
        kind="engine",
        required={"--cwd": "value", "--prompt-file": "value", "--out": "value"},
        optional={"--mode": "value", "--full-access": "boolean"},
        withheld={"--answer": "r", "--fake-limit": "r"},
    )
    accepted: dict[str, FlagKind] = {
        "--cli": "value", "--wait": "boolean", "--answer": "boolean",
        "--cwd": "value", "--prompt-file": "value", "--out": "value",
        "--mode": "value", "--full-access": "boolean", "--fake-limit": "value",
    }
    expect("flags agree", flag_errors(grok, accepted), [])
    expect(
        "parser gained a flag",
        flag_errors(grok, {**accepted, "--tier": "value"}),
        [
            "grok: skills/delegate/bin/delegate accepts --tier, "
            "which the registry does not list. Add it to optionalFlags, or to "
            "withheldFlags with the reason the agent does not forward it"
        ],
    )
    expect(
        "parser lost a flag",
        flag_errors(grok, {k: v for k, v in accepted.items() if k != "--mode"}),
        [
            "grok: --mode is in the registry, but "
            "skills/delegate/bin/delegate does not accept it. "
            "Remove it from scripts/delegate-agents.json"
        ],
    )
    expect(
        "kind changed",
        flag_errors(grok, {**accepted, "--full-access": "value"}),
        [
            "grok: --full-access is boolean in the registry but value in "
            "skills/delegate/bin/delegate"
        ],
    )
    expect(
        "withheld flag removed",
        flag_errors(grok, {k: v for k, v in accepted.items() if k != "--fake-limit"}),
        [
            "grok: withheld --fake-limit is gone from "
            "skills/delegate/bin/delegate. Remove it from withheldFlags"
        ],
    )
    expect(
        "--out optional",
        entry_errors(
            Agent(**{**grok.__dict__, "required": {"--cwd": "value", "--prompt-file": "value"}})
        ),
        [
            "grok: requiredFlags must include --out, because the parent reads "
            "the answer with `delegate result <out>`"
        ],
    )
    answered = "grok: the agent must not pass --answer, because the forwarder must never see the worker's answer"
    expect(
        "--answer forwarded",
        entry_errors(Agent(**{**grok.__dict__, "optional": {**grok.optional, "--answer": "boolean"}, "withheld": {}})),
        [answered],
    )

    rendered = render(grok).splitlines()
    for line in (
        "description: Forwards one Grok CLI run from a single flag line. Write the "
        "user's task to a brief file first, then send `--prompt-file` with that file, "
        "`--cwd`, and `--out` set to a new `~/.cache/delegate/<name>` directory. Do not "
        "send prose. The reply carries only a run status line, never the worker's "
        "answer, which the parent reads with `~/.local/bin/delegate result <out>`.",
        "Allow only these other flags: `--mode` and `--full-access`.",
        "`--full-access` takes no value. Every other flag takes one value.",
        "`delegate run needs <flag>` for a missing required flag or a flag with no value",
        "`delegate run needs a flag line with --cwd, --prompt-file, and --out` for prose or a question",
        "~/.local/bin/delegate run --cli grok --wait <quoted flags> 2>/dev/null",
        "`Run status unknown; check ~/.local/bin/delegate status <out> or "
        "~/.local/bin/delegate result <out>.`",
    ):
        expect(f"grok renders {line!r}", line in rendered, True)
    cursor = Agent(**{**grok.__dict__, "cli": "cursor", "kind": "direct"})
    expect(
        "direct notice",
        "`Run status unknown; check ~/.local/bin/delegate status <out> or "
        "~/.local/bin/delegate result <out>.`" in render(cursor).splitlines(),
        True,
    )
    expect(
        "direct skips approval steering",
        "Do not retry, poll, or stop the run." in render(cursor).splitlines(),
        True,
    )

    reason = (
        " in code. Claude Code pastes the user's text there as is, so the shell "
        "would run whatever it holds. Name it in prose and have the model pass it "
        "as one quoted argument"
    )
    expect(
        "$ARGUMENTS and $1 in every code form, not in prose",
        command_errors(
            Path("c.md"),
            "Run: $ARGUMENTS, then $1\n"
            "```bash\ndelegate stop $ARGUMENTS\n```\n"
            "~~~\ndelegate stop $1\n~~~\n"
            "    delegate stop ${1}\n"
            "Run `delegate result $ARGUMENTS` now.\n"
            "!`delegate stop $ARGUMENTS`\n"
            "````\n```\n$ARGUMENTS\n````\n",
        ),
        [f"c.md:{n} puts {token}{reason}" for n, token in (
            (3, "$ARGUMENTS"), (6, "$1"), (8, "${1"), (9, "$ARGUMENTS"), (10, "$ARGUMENTS"), (13, "$ARGUMENTS"),
        )],
    )

    # check() against a copy of the real registry and engine
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        shutil.copytree(ROOT / PACKAGE, root / PACKAGE)
        (root / REGISTRY).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(ROOT / REGISTRY, root / REGISTRY)
        expect("write", write(root), [])
        expect("clean", check(root), [])
        flags_ts = root / PACKAGE / "engine" / "direct.ts"
        real = flags_ts.read_text()
        flags_ts.write_text(real.replace('valued: ["cli", "cwd"', 'valued: ["cli", "sandbox", "cwd"', 1))
        expect(
            "direct gained a flag",
            check(root),
            [
                "codex: skills/delegate/bin/delegate accepts --sandbox, which the "
                "registry does not list. Add it to optionalFlags, or to withheldFlags with "
                "the reason the agent does not forward it"
            ],
        )
        flags_ts.write_text(real)
        agents_dir = root / AGENTS_DIR
        grok_md = agents_dir / "grok.md"
        grok_md.write_text(grok_md.read_text() + "edited\n")
        expect(
            "changed file",
            check(root),
            [
                "skills/delegate/plugin/agents/grok.md differs from its rendering. It is "
                "generated, so edit scripts/delegate-agents.json or the generator, "
                "then run python3 scripts/generate-delegate-agents.py"
            ],
        )
        grok_md.unlink()
        expect(
            "missing file",
            check(root),
            [
                "skills/delegate/plugin/agents/grok.md is missing. "
                "Run python3 scripts/generate-delegate-agents.py"
            ],
        )
        write(root)
        (agents_dir / "claude.md").write_text("x\n")
        expect(
            "extra file",
            check(root),
            [
                "skills/delegate/plugin/agents/claude.md has no entry in "
                "scripts/delegate-agents.json. Add one, or delete the file"
            ],
        )
        write(root)
        expect("write removes the extra file", (agents_dir / "claude.md").exists(), False)

    for failure in failures:
        print(f"SELF-TEST FAIL: {failure}")
    if failures:
        print(f"self-test: {len(failures)} failure(s)")
        return 1
    print("self-test ok: parser, flag-agreement, registry, render, command, and check cases")
    return 0


def main(argv: Iterable[str] = sys.argv[1:]) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--check", action="store_true", help="fail on drift, write nothing")
    parser.add_argument("--self-test", action="store_true", help="run literal offline cases")
    args = parser.parse_args(list(argv))
    if args.self_test:
        return self_test()
    try:
        errors = check(ROOT) if args.check else write(ROOT)
    except RegistryError as e:
        print(e, file=sys.stderr)
        return 2
    for error in errors:
        print(f"delegate agents: {error}", file=sys.stderr)
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
