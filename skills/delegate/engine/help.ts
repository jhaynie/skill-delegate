import {
  CODEX_FLAG_ORDER,
  CODEX_RUN_FLAGS,
  CURSOR_FLAG_ORDER,
  CURSOR_RUN_FLAGS,
} from "./direct.ts";
import { CLIS, type Cli } from "./state.ts";
import { profiles } from "./workers.ts";

const PUBLIC_COMMANDS = ["run", "status", "send", "answer", "stop", "result", "prune"] as const;
type PublicCommand = (typeof PUBLIC_COMMANDS)[number];

export type FlagTable = {
  booleans: readonly string[];
  valued: readonly string[];
};

export type CommandShape = {
  positional: number;
  booleans?: readonly string[];
  valued?: readonly string[];
};

export type CommandShapes = { [C in Exclude<PublicCommand, "run">]: CommandShape };

export type HelpPick =
  | { kind: "help"; text: string; docs: boolean }
  | { kind: "pass" }
  | { kind: "error"; message: string; flags?: ReadonlyMap<string, string> };

const RUN_CLIS = [...CLIS, "codex", "cursor"] as const;
const RUN_CLI_SET = new Set<string>(RUN_CLIS);
const PUBLIC = new Set<string>(PUBLIC_COMMANDS);
const RUN_REQUIRED = new Set(["cli", "cwd", "prompt-file"]);
const VALUE_PLACEHOLDER: Record<string, string> = {
  cwd: "<repo>",
  "prompt-file": "<brief.md>",
  mode: "read|write",
  model: "M",
  effort: "E",
  deadline: "45m",
  resume: "<session>",
  out: "<dir>",
  tier: "T",
  timeout: "<seconds>",
  "older-than": "7d",
};

export const ROOT_HELP = `usage:
  delegate run --cli grok --cwd <repo> --prompt-file <brief.md>
               starts a worker in the background and prints one status line
               with out=<run>. The run may finish after this command returns.
  delegate status <run>
               prints the current line. A waiting line includes req=<id>
               for the open approval request.
  delegate answer <run> <req> allow|deny
               answers that request. Direct Codex and Cursor runs do not
               take send or answer.
  delegate result <run>
               prints the current line and any saved answer without waiting.
               A live run may have no answer yet.
  delegate result <run> --wait
               waits for the final line. Waiting does not answer approval requests.
  delegate prune --older-than 7d
               deletes completed local runs older than the cutoff. Preview with
               --dry-run. Active runs, their workspaces, and unreadable folders stay.
  delegate --print-flags
               prints each managed run flag, one per line as --name value or --name boolean

Commands: run, status, send, answer, stop, result, prune
Use delegate <command> --help for that command's flags.
flags may come before or after the other arguments`;

export function pickHelp(argv: string[], managedRun: FlagTable, shapes: CommandShapes): HelpPick {
  const [head, ...rest] = argv;
  if (head === "-h" || head === "--help") {
    const extra = rest.find((arg) => arg !== "-h" && arg !== "--help");
    if (extra !== undefined) return { kind: "error", message: `unexpected argument ${extra}\n${ROOT_HELP}` };
    return { kind: "help", text: ROOT_HELP, docs: true };
  }
  if (head === undefined || !PUBLIC.has(head)) return { kind: "pass" };
  const command = head as PublicCommand;
  if (command === "run" && rest.includes("--print-flags")) return { kind: "pass" };
  const shape = command === "run" ? runHelpShape(managedRun) : shapes[command];
  if (!hasHelpFlag(rest, shape)) return { kind: "pass" };
  const parsed = readHelpQualifiers(command, rest);
  if (parsed.error) return { kind: "error", message: parsed.error, flags: parsed.flags };
  return { kind: "help", text: helpFor(command, managedRun, parsed.cli, shapes), docs: false };
}

function runHelpShape(managed: FlagTable): CommandShape {
  return {
    positional: 0,
    booleans: [...new Set([...managed.booleans, ...CODEX_RUN_FLAGS.booleans, ...CURSOR_RUN_FLAGS.booleans])],
    valued: [...new Set([...managed.valued, ...CODEX_RUN_FLAGS.valued, ...CURSOR_RUN_FLAGS.valued])],
  };
}

function hasHelpFlag(args: readonly string[], shape: CommandShape): boolean {
  let positionals = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--") return false;
    const name = arg.startsWith("--") ? arg.slice(2) : null;
    if (name !== null && shape.booleans?.includes(name)) continue;
    if (name !== null && shape.valued?.includes(name)) {
      i++;
      continue;
    }
    if (isHelpFlag(arg)) return positionals === 0;
    positionals++;
  }
  return false;
}

function readHelpQualifiers(
  command: PublicCommand,
  args: readonly string[],
): { cli?: string; flags: Map<string, string>; error?: string } {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (isHelpFlag(arg)) continue;
    if (command === "run" && arg === "--cli") {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) return { flags, error: "--cli needs a value" };
      if (flags.has("cli")) return { flags, error: "--cli is given more than once" };
      flags.set("cli", value);
      if (!RUN_CLI_SET.has(value)) {
        return { flags, error: `--cli must be one of ${RUN_CLIS.join(", ")}, not ${value}` };
      }
      i++;
      continue;
    }
    return { flags, error: `unexpected argument ${arg}\n${ROOT_HELP}` };
  }
  return { flags, cli: flags.get("cli") };
}

function helpFor(command: PublicCommand, managed: FlagTable, cli: string | undefined, shapes: CommandShapes): string {
  switch (command) {
    case "run":
      return runHelp(managed, cli);
    case "status":
      return (
        `usage: delegate status [<run> | --cwd <dir>]${flagList(shapes.status)}\n` +
        `Prints one run's current line, or lists every live run, each line ending in cwd=<target>.\n` +
        `A waiting line includes req=<id> for the open approval request.\n` +
        `--verbose also counts runs skipped for an older state format.`
      );
    case "send":
      return (
        `usage: delegate send <run>${flagList(shapes.send)} "text"\n` +
        `Posts a message to a live managed run.\n` +
        `Unsupported on Codex and Cursor.`
      );
    case "answer":
      return (
        `usage: delegate answer <run> <req> allow|deny${flagList(shapes.answer)}\n` +
        `Answers a waiting managed run's open approval. <req> is the req= id from status.\n` +
        `Unsupported on Codex and Cursor.\n` +
        `--widen is valid only with allow.`
      );
    case "stop":
      return `usage: delegate stop <run>${flagList(shapes.stop)}\nStops a live run.`;
    case "result":
      return (
        `usage: delegate result <run>${resultFlags(shapes.result)}\n` +
        `Prints the current line and any saved answer from the out= directory.\n` +
        `A live line means the run has not completed. A live run's saved answer may be empty.\n` +
        `Waiting does not answer approval requests.\n` +
        `--wait blocks until the run ends.\n` +
        `--timeout applies only to --wait. It prints the live line and exits 0 if the run is still going.\n` +
        `--quiet prints only the status line. A direct run directory works too.`
      );
    case "prune":
      return (
        `usage: delegate prune --older-than <duration>${flagList(shapes.prune)}\n` +
        `Deletes completed run directories under the run root that are older than the cutoff.\n` +
        `Age is the completedAt the engine stores when a run ends. An older run uses its last heartbeat, then its status mtime.\n` +
        `--dry-run shows what would be removed and writes nothing.\n` +
        `Live or uncertain runs stay, and so does a run a live process is using. A workspace needed by a live or recent completed run stays too.\n` +
        `When prune cannot list processes, every finished run stays.\n` +
        `A scratch workspace created before pin tracking stays. Failed removal needs manual cleanup.\n` +
        `See README.md for the full contract.`
      );
  }
}

function runHelp(managed: FlagTable, cli: string | undefined): string {
  const hideFull = hidesFullAccess(cli);
  if (cli === "codex") {
    return (
      `usage: delegate run ${formatRunFlags(CODEX_RUN_FLAGS, CODEX_FLAG_ORDER, "codex")}\n` +
      `Starts a Codex worker in the background and prints one status line once the owner has started the worker.\n` +
      `A slow start prints starting and the owner keeps going.\n` +
      `--wait and --answer wait for the final line.\n` +
      `send and answer are unsupported on Codex.`
    );
  }
  if (cli === "cursor") {
    return (
      `usage: delegate run ${formatRunFlags(CURSOR_RUN_FLAGS, CURSOR_FLAG_ORDER, "cursor")}\n` +
      `Starts a Cursor worker in the background and prints one status line once the owner has started the worker.\n` +
      `A slow start prints starting and the owner keeps going.\n` +
      `--full-access applies only to --mode write.\n` +
      `send and answer are unsupported on Cursor.`
    );
  }
  const spec = cli ?? [...CLIS].join("|");
  const full = hideFull ? "" : `--full-access applies only to --mode write.\n`;
  return (
    `usage: delegate run ${formatRunFlags(managed, undefined, spec, hideFull ? ["full-access"] : [])}\n` +
    `Starts a ${cli ?? "managed"} worker in the background and prints one status line with out=<run>.\n` +
    `--wait prints only the final line.\n` +
    `--answer waits too, then prints a blank line and the answer.\n` +
    full +
    `Use delegate run --cli codex --help or delegate run --cli cursor --help for those workers.`
  );
}

function hidesFullAccess(cli: string | undefined): boolean {
  return cli !== undefined && (CLIS as readonly string[]).includes(cli) && !profiles[cli as Cli].fullAccess;
}

function formatRunFlags(
  table: FlagTable,
  order: readonly string[] | undefined,
  cliSpec: string,
  omit: readonly string[] = [],
): string {
  const hidden = new Set(omit);
  const names: string[] = [];
  const seen = new Set<string>();
  const push = (name: string) => {
    if (seen.has(name) || hidden.has(name)) return;
    seen.add(name);
    names.push(name);
  };
  push("cli");
  for (const name of order ?? []) push(name);
  for (const name of table.valued) push(name);
  for (const name of table.booleans) push(name);
  return names
    .map((name) => {
      if (name === "cli") return `--cli ${cliSpec}`;
      if (table.valued.includes(name)) {
        const token = `--${name} ${VALUE_PLACEHOLDER[name] ?? `<${name}>`}`;
        return RUN_REQUIRED.has(name) ? token : `[${token}]`;
      }
      return `[--${name}]`;
    })
    .join(" ");
}

function flagList(shape: CommandShape): string {
  const parts: string[] = [];
  for (const name of shape.valued ?? []) {
    if (name === "cwd" || name === "older-than") continue;
    parts.push(`[--${name} ${VALUE_PLACEHOLDER[name] ?? `<${name}>`}]`);
  }
  for (const name of shape.booleans ?? []) parts.push(`[--${name}]`);
  return parts.length ? ` ${parts.join(" ")}` : "";
}

function resultFlags(shape: CommandShape): string {
  const wait = shape.booleans?.includes("wait") ? " [--wait" : "";
  const timeout = shape.valued?.includes("timeout") ? ` [--timeout ${VALUE_PLACEHOLDER.timeout}]` : "";
  const waitEnd = wait ? "]" : "";
  const quiet = shape.booleans?.includes("quiet") ? " [--quiet]" : "";
  return `${wait}${timeout}${waitEnd}${quiet}`;
}

function isHelpFlag(arg: string): boolean {
  return arg === "-h" || arg === "--help";
}
