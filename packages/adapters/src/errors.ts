/**
 * Cleanup failures that happened while an operation was already failing. They
 * are attached to the original error (which is rethrown unchanged) by
 * `writeFileAtomically`, `withCleanup` and the Run application's shutdown, and
 * `errorMessage` appends them, so e.g. a stranded temp file or a failed close
 * can still be traced.
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

/**
 * Run `work`, then always `cleanup`. A cleanup failure after `work` failed is
 * attached to the original error instead of replacing it; after `work`
 * succeeded it is thrown.
 */
export async function withCleanup<A>(
  work: () => Promise<A>,
  cleanup: () => Promise<void> | void,
): Promise<A> {
  let result: A;
  try {
    result = await work();
  } catch (error) {
    await Promise.resolve()
      .then(cleanup)
      .catch((cleanupError: unknown) => attachCleanupError(error, cleanupError));
    throw error;
  }
  await cleanup();
  return result;
}

/** `value[key]` when `value` is an object that has it. */
export function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/**
 * The text of a thrown value, for error messages that name what failed. Cleanup
 * failures attached by `attachCleanupError` are appended, so they stay
 * traceable from the one-line message.
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
 * error is about one photo or one Run, that photo or `runId`.
 */
export function errorLine(error: unknown): string {
  const photo = field(error, "photo");
  const runId = field(error, "runId");
  return `${JSON.stringify({
    error: errorMessage(error),
    ...(typeof photo === "string" && photo && { photo }),
    ...(typeof runId === "string" && runId && { runId }),
  })}\n`;
}

/** The error, its `cause`, the cause's `cause`, and so on, up to `depth` links. */
function* causeChain(error: unknown, depth = 4): Generator<object> {
  for (let link = error, index = 0; index < depth; index++) {
    if (typeof link !== "object" || link === null) return;
    yield link;
    link = "cause" in link ? link.cause : undefined;
  }
}

/** The first integer HTTP `statusCode` on the error or its cause chain; undefined when none. */
export function statusOf(error: unknown): number | undefined {
  for (const link of causeChain(error)) {
    if ("statusCode" in link && Number.isInteger(Number(link.statusCode))) {
      return Number(link.statusCode);
    }
  }
  return undefined;
}

/** The first string `code` on the error or its cause chain (e.g. Bun's `ENOTFOUND`). */
export function codeOf(error: unknown): string | undefined {
  for (const link of causeChain(error)) {
    if ("code" in link && typeof link.code === "string") return link.code;
  }
  return undefined;
}
