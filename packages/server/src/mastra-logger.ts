import { errorChain, errorMessage } from "@iconograph/adapters";
import { MastraLogger } from "@mastra/core/logger";

/** How deep `loggable` follows nested plain objects and arrays. */
const MAX_DEPTH = 3;

const isPlainObject = (value: object) => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * A log detail as JSON can carry it, on one line: an error as its message chain
 * (plus Mastra's `id` and `domain` when it has them); a `stack` (as
 * `@mastra/hono` logs `{ message, stack }`) cut to its first line; a Map as an
 * object and a Set as an array; plain objects and arrays followed a few levels;
 * anything else (a Date, a URL) left to `JSON.stringify`.
 */
function loggable(value: unknown, depth = 0): unknown {
  if (value instanceof Error) {
    const { id, domain } = value as Error & { id?: unknown; domain?: unknown };
    return typeof id === "string"
      ? { message: errorChain(value), id, ...(typeof domain === "string" && { domain }) }
      : errorChain(value);
  }
  if (depth >= MAX_DEPTH || typeof value !== "object" || value === null) return value;
  if (value instanceof Map) return loggable(Object.fromEntries(value), depth);
  if (value instanceof Set) return loggable([...value], depth);
  if (Array.isArray(value)) return value.map((item) => loggable(item, depth + 1));
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === "stack" && typeof item === "string"
        ? item.split("\n", 1)[0]
        : loggable(item, depth + 1),
    ]),
  );
}

/**
 * Mastra's warnings and errors as log objects; its debug and info chatter is
 * dropped. Messages keep their first line (Mastra appends stack traces of the
 * bundle), and the details (`{ error, runId, … }`) are made `loggable`; they
 * never replace `level` or `mastra`. Logging never throws into Mastra: an entry
 * that can't be written falls back to the message and why, and a failing
 * fallback is dropped.
 */
export class JsonLineLogger extends MastraLogger {
  constructor(private readonly write: (value: Record<string, unknown>) => void) {
    super({ name: "mastra", level: "warn" });
  }
  debug(_message: string, ..._details: unknown[]) {}
  info(_message: string, ..._details: unknown[]) {}
  warn(message: string, ...details: unknown[]) {
    this.entry("warn", message, details);
  }
  error(message: string, ...details: unknown[]) {
    this.entry("error", message, details);
  }
  private entry(level: string, message: string, details: unknown[]) {
    const head = { level, mastra: message.split("\n", 1)[0] };
    try {
      this.write({
        ...Object.fromEntries(
          details
            .filter((detail): detail is object => typeof detail === "object" && detail !== null)
            .flatMap((detail) =>
              detail instanceof Error ? [["error", detail]] : Object.entries(detail),
            )
            .map(([key, value]) => [key, loggable(value)]),
        ),
        ...head,
      });
    } catch (error) {
      try {
        this.write({ ...head, loggingFailed: errorMessage(error) });
      } catch {
        // The destination itself is broken; nothing is left to tell.
      }
    }
  }
}
