/**
 * Cleanup failures that happened while a write was already failing. They are
 * attached to the original error (which is rethrown unchanged) by
 * `writeFileAtomically`, and `errorMessage` appends them, so a stranded temp
 * file can still be traced.
 */
export interface CleanupErrors {
  cleanupErrors?: unknown[];
}

/** Attach a cleanup failure to `error`, unless it can't carry one (frozen, not an object). */
export function attachCleanupError(error: unknown, cleanupError: unknown): void {
  // Never let a failed attachment replace the original error.
  if (typeof error !== "object" || error === null || !Object.isExtensible(error)) return;
  const target = error as CleanupErrors;
  target.cleanupErrors = [...(target.cleanupErrors ?? []), cleanupError];
}

/** `error[key]` when `error` is an object that has it. */
function field(error: unknown, key: string): unknown {
  return typeof error === "object" && error !== null ? Reflect.get(error, key) : undefined;
}

/**
 * The text of a thrown value, for error messages that name what failed. Cleanup
 * failures attached by `writeFileAtomically` are appended, so a stranded temp
 * file stays traceable from the one-line message.
 */
export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cleanup = field(error, "cleanupErrors" satisfies keyof CleanupErrors);
  return Array.isArray(cleanup) && cleanup.length > 0
    ? `${message} (cleanup also failed: ${cleanup.map(errorMessage).join("; ")})`
    : message;
}

/**
 * A command's stderr line for a failure: JSON with the message and, when the
 * error is about one photo, that photo.
 */
export function errorLine(error: unknown): string {
  const photo = field(error, "photo");
  return `${JSON.stringify({ error: errorMessage(error), ...(typeof photo === "string" && photo && { photo }) })}\n`;
}
