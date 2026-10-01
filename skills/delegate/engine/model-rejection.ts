import { clean } from "./state.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

function errorFields(line: string): { message: string | null; codes: Set<string> }[] {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return line.startsWith("Error:") ? [{ message: line, codes: new Set() }] : [];
  }
  if (!isObject(event)) return [];
  const item = event.item;
  if (isObject(item)) {
    const said = item.message;
    const skip = typeof said !== "string" || said.startsWith("Model metadata for");
    return item.type !== "error" || skip ? [] : [{ message: typeof said === "string" ? said : null, codes: new Set() }];
  }
  const found: { message: string | null; codes: Set<string> }[] = [];
  if (event.type === "error") found.push({ message: typeof event.message === "string" ? event.message : null, codes: new Set() });
  if (isObject(event.error)) {
    const rec = event.error;
    const codes = new Set<string>();
    if (typeof rec.code === "string") codes.add(rec.code);
    if (typeof rec.type === "string") codes.add(rec.type);
    found.push({ message: typeof rec.message === "string" ? rec.message : null, codes });
  }
  if (truthy(event.is_error)) found.push({ message: typeof event.result === "string" ? event.result : null, codes: new Set() });
  return found;
}

function unwrap(message: string | null, codes: Set<string>): [string | null, Set<string>] {
  if (message === null) return [null, codes];
  try {
    const inner: unknown = JSON.parse(message);
    const error = isObject(inner) && "error" in inner ? inner.error : undefined;
    if (!isObject(error)) return [null, codes];
    const next = new Set(codes);
    if (typeof error.code === "string") next.add(error.code);
    if (typeof error.type === "string") next.add(error.type);
    return [typeof error.message === "string" ? error.message : null, next];
  } catch {
    return [message, codes];
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// "model rejected: <message>" for the first error in the texts that rejects
// the model, else null. Only error fields count: an error event's message,
// an error object's message, a failed result, a Codex error item, and a
// line that starts with Error:. A message that is itself JSON gives its
// error object instead. An error rejects the model when its code or type is
// model_not_found, or when it names the model in any case and says it is
// unsupported, unknown, or unavailable. One with that code and no message
// reads model_not_found. A rate limit or a sign-in error that names the
// model does not count, and neither does Codex's item about a model with no
// local metadata.
export function modelRejection(model: string, texts: readonly string[]): string | null {
  const names = new RegExp(`(?<![\\w.-])${escapeRegExp(model)}(?![\\w-]|\\.\\w)`, "i");
  const says = /not supported|not found|does not exist|unsupported|unknown model|invalid model|cannot use|not available|do not have access/i;
  for (const text of texts) {
    for (const line of text.split("\n")) {
      for (const found of errorFields(line)) {
        const [message, codes] = unwrap(found.message, found.codes);
        if (codes.has("model_not_found") || (message && names.test(message) && says.test(message))) {
          return `model rejected: ${clean(message || "model_not_found", 200)}`;
        }
      }
    }
  }
  return null;
}
