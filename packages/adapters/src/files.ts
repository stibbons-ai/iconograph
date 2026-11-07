import { type FileHandle, open, rename, rm } from "node:fs/promises";
import { attachCleanupError } from "./errors";

export interface WriteFileAtomicallyOptions {
  /** Suffix of the temp file created beside the destination, e.g. `.partial`. */
  suffix: string;
  /** Checks the closed temp file before it is renamed into place; throw to reject it. */
  verify?: (temporary: string) => Promise<void>;
}

/**
 * Write `path` so no reader ever sees a partial or unverified file: `write`
 * fills a new temp file beside it, which is fsynced, closed, verified and only
 * then renamed into place. The temp file is opened before `write` runs, so a
 * local failure such as EACCES surfaces before any work (e.g. a download). On
 * failure the temp file is removed; the original error is rethrown, with any
 * close or cleanup error attached as `cleanupErrors`.
 */
export async function writeFileAtomically(
  path: string,
  write: (file: FileHandle) => Promise<void>,
  options: WriteFileAtomicallyOptions,
): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}${options.suffix}`;
  try {
    const file = await open(temporary, "wx");
    try {
      await write(file);
      await file.sync();
    } catch (error) {
      await file.close().catch((closeError: unknown) => attachCleanupError(error, closeError));
      throw error;
    }
    await file.close();
    await options.verify?.(temporary);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch((rmError: unknown) =>
      attachCleanupError(error, rmError),
    );
    throw error;
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether `name` is a temp file `writeFileAtomically` creates for the file named `file`. */
export function isTemporaryFileOf(name: string, file: string, suffix: string): boolean {
  return (
    name.startsWith(`${file}.`) &&
    name.endsWith(suffix) &&
    uuid.test(name.slice(file.length + 1, name.length - suffix.length))
  );
}
