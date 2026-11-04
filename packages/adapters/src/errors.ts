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
  return withCleanupErrors(error, error instanceof Error ? error.message : String(error));
}

/** `message` with the cleanup failures attached to `error` appended. */
function withCleanupErrors(error: unknown, message: string): string {
  const cleanup = field(error, "cleanupErrors" satisfies keyof CleanupErrors);
  return Array.isArray(cleanup) && cleanup.length > 0
    ? `${message} (cleanup also failed: ${cleanup.map(errorMessage).join("; ")})`
    : message;
}

/** How many links of an error's `cause` chain `errorChain` shows. */
const MAX_CAUSE_DEPTH = 8;

/**
 * The error, its `cause`, the cause's `cause`, and so on, up to `depth` links.
 * The thrown value itself always counts; a `cause` of null or undefined ends the chain.
 */
function* causeChain(error: unknown, depth: number): Generator<unknown> {
  for (let link = error, index = 0; index < depth; index++) {
    yield link;
    link = field(link, "cause");
    if (link === undefined || link === null) return;
  }
}

/**
 * An error as the chain of its messages (error, its `cause`, and so on), each
 * with its attached cleanup failures (`errorMessage`), without stack traces. A
 * message already contained in an earlier one (an error quoting its cause) is
 * left out. Non-`Error` values with a `message` (some Effect errors) count by it.
 */
export function errorChain(error: unknown): string {
  const messages: string[] = [];
  for (const link of causeChain(error, MAX_CAUSE_DEPTH)) {
    const own = field(link, "message");
    const message =
      link instanceof Error || typeof own !== "string"
        ? errorMessage(link)
        : withCleanupErrors(link, own);
    if (!messages.some((earlier) => earlier.includes(message))) messages.push(message);
  }
  return messages.join(": ");
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

/** How many links of an error's `cause` chain `statusOf`, `codeOf`, `responseBodyOf` and `hasErrorNamed` search. */
const LOOKUP_DEPTH = 4;

/** The first integer HTTP `statusCode` on the error or its cause chain; undefined when none. */
export function statusOf(error: unknown): number | undefined {
  for (const link of causeChain(error, LOOKUP_DEPTH)) {
    const status = Number(field(link, "statusCode"));
    if (Number.isInteger(status)) return status;
  }
  return undefined;
}

/**
 * The first string `responseBody` (the vendor's raw error body, as the AI
 * SDK's `APICallError` keeps it) on the error or its cause chain.
 */
export function responseBodyOf(error: unknown): string | undefined {
  for (const link of causeChain(error, LOOKUP_DEPTH)) {
    const body = field(link, "responseBody");
    if (typeof body === "string") return body;
  }
  return undefined;
}

/** The first string `code` on the error or its cause chain (e.g. Bun's `ENOTFOUND`). */
export function codeOf(error: unknown): string | undefined {
  for (const link of causeChain(error, LOOKUP_DEPTH)) {
    const code = field(link, "code");
    if (typeof code === "string") return code;
  }
  return undefined;
}

/** Whether the error or its cause chain holds an error named `name` (e.g. fetch's `TimeoutError`). */
export function hasErrorNamed(error: unknown, name: string): boolean {
  for (const link of causeChain(error, LOOKUP_DEPTH)) {
    if (field(link, "name") === name) return true;
  }
  return false;
}
