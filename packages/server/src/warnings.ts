import { Cause, Logger, References } from "effect";

/**
 * An engine warning: its level and message, the log annotations (`runId`,
 * `lane`, `iteration`, `candidate`) and the cause's chain of error messages.
 */
export interface RunWarning {
  readonly level: string;
  readonly warning: string;
  readonly cause?: string;
  readonly [annotation: string]: unknown;
}

/** One value as a line of JSON, the CLI's stderr format. */
export const jsonLine = (value: unknown) => `${JSON.stringify(value)}\n`;

/** The default destination: a JSON line on stderr, never stdout. */
export const printWarning = (warning: RunWarning) => process.stderr.write(jsonLine(warning));

/** How many links of an error's `cause` chain a warning shows. */
const MAX_CAUSE_DEPTH = 8;

const messageOf = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : String(error);

/**
 * A cause as the chain of its error messages (error, its `cause`, and so on),
 * without stack traces; a message already contained in an earlier one (an
 * error quoting its cause) is left out.
 */
export function causeMessages(cause: Cause.Cause<unknown>): string | undefined {
  if (cause.reasons.length === 0) return undefined;
  const messages: string[] = [];
  let error: unknown = Cause.squash(cause);
  for (let depth = 0; error !== undefined && depth < MAX_CAUSE_DEPTH; depth++) {
    const message = messageOf(error);
    if (!messages.some((earlier) => earlier.includes(message))) messages.push(message);
    error =
      typeof error === "object" && error !== null && "cause" in error ? error.cause : undefined;
  }
  return messages.join(": ");
}

/** A logger handing every log event to `warn` as a `RunWarning`. */
export const warningLogger = (warn: (warning: RunWarning) => void) =>
  Logger.make(({ message, logLevel, cause, fiber }) => {
    const causeText = causeMessages(cause);
    warn({
      level: logLevel,
      warning: (Array.isArray(message) ? message : [message]).map(String).join(" "),
      ...fiber.getRef(References.CurrentLogAnnotations),
      ...(causeText !== undefined && { cause: causeText }),
    });
  });
