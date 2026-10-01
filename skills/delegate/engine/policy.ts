import path from "node:path";
import type { Answer, Approval, RunSpec, Widening } from "./state.ts";

export interface SeenTool {
  kind?: string;
  command?: string;
  scope?: string;
  paths: string[];
}

export type Decision = "allow" | "ask";

// Paths arrive canonical (acp.ts resolves symlinks), so a lexical check holds.
// Only an exact allow_once is ever sent without the parent, and only for a
// request correlated to a tool call this session announced. Every sticky
// option would widen the worker's sandbox, so anything else waits.
export function decide(
  spec: Pick<RunSpec, "preset" | "cwd" | "target">,
  approval: Approval,
  seen: ReadonlyMap<string, SeenTool>,
): Decision {
  if (!approval.options.some((o) => o.kind === "allow_once")) return "ask";
  if (spec.preset === "full") return "allow";
  const tool = approval.toolCallId === undefined ? undefined : seen.get(approval.toolCallId);
  if (!tool) return "ask";
  // A request whose command or kind differs from the announced call is not that call
  if (approval.command !== undefined && approval.command !== tool.command) return "ask";
  if (approval.toolKind !== undefined && tool.kind !== undefined && approval.toolKind !== tool.kind) return "ask";
  const paths = [...tool.paths, ...approval.paths];
  switch (approval.toolKind ?? tool.kind) {
    case "execute":
      // The OS sandbox bounds what a command can write
      return "allow";
    case "read":
      return within(paths, [spec.cwd, spec.target], spec.cwd) ? "allow" : "ask";
    case "edit":
      return editable(spec, paths) ? "allow" : "ask";
    default:
      return "ask";
  }
}

// A read-mode worker may edit its scratch workspace, never the target
function editable(spec: Pick<RunSpec, "preset" | "cwd" | "target">, paths: string[]): boolean {
  if (spec.preset === "read" && within(paths, [spec.target], spec.cwd)) return false;
  return within(paths, [spec.cwd], spec.cwd);
}

// What a parent's allow opened beyond the policy: a sticky grant, or a path
// outside the roots the policy allows on its own for that kind of call
export function widening(
  spec: Pick<RunSpec, "preset" | "cwd" | "target">,
  approval: Approval,
  seen: ReadonlyMap<string, SeenTool>,
  sent: Approval["options"][number],
): Widening | null {
  if (sent.kind === "allow_always") return "sticky";
  if (sent.kind !== "allow_once") return null;
  const tool = approval.toolCallId === undefined ? undefined : seen.get(approval.toolCallId);
  const paths = [...(tool?.paths ?? []), ...approval.paths];
  if (!paths.length) return null;
  const inside = (approval.toolKind ?? tool?.kind) === "read" ? within(paths, [spec.cwd, spec.target], spec.cwd) : editable(spec, paths);
  return inside ? null : "path";
}

function within(paths: string[], roots: string[], base: string): boolean {
  return (
    paths.length > 0 &&
    paths.every((p) => {
      const full = path.resolve(base, p);
      return roots.some((root) => full === root || full.startsWith(root + path.sep));
    })
  );
}

type Option = Approval["options"][number];

// The exact option an answer sends. allow and deny take only the once
// options. widen takes the least sticky allow on offer, never one that
// bypasses the sandbox or grants globally.
export function pickOption(options: Option[], answer: Answer): Option | null {
  const once = options.find((o) => o.kind === (answer === "deny" ? "reject_once" : "allow_once"));
  if (once || answer !== "widen") return once ?? null;
  const sticky = options.filter((o) => o.kind === "allow_always" && !/bypass|global/i.test(o.id));
  return sticky.find((o) => /session/i.test(o.id)) ?? sticky[0] ?? null;
}
