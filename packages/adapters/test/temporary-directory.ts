import { afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Call at the top of a test file: returns a factory for fresh temporary
 * directories that are removed after each test.
 */
export function temporaryDirectories(prefix: string): () => Promise<string> {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });
  return async () => {
    const path = await mkdtemp(join(tmpdir(), `iconograph-${prefix}-`));
    directories.push(path);
    return path;
  };
}
