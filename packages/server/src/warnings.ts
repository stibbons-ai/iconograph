import { errorChain } from "@iconograph/adapters";
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

/** A cause as `errorChain` of its squashed error. */
export function causeMessages(cause: Cause.Cause<unknown>): string | undefined {
  return cause.reasons.length === 0 ? undefined : errorChain(Cause.squash(cause));
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
