import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * The one place the data volume is resolved: flag, then `ICONOGRAPH_DATA_DIR`,
 * then `./.data`. Empty values count as unset.
 */
export function resolveDataDirectory(
  override?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return resolve(override || env.ICONOGRAPH_DATA_DIR || "./.data");
}

/** Downloaded model weights live in the data volume, never in git or an image. */
export function modelsDirectory(dataDirectory: string): string {
  return join(dataDirectory, "models");
}

/** The LiteLLM price cache and manual price overrides, a LibSQL file in the data volume. */
export function pricesDatabase(dataDirectory: string): string {
  return join(dataDirectory, "prices.db");
}

/** The HTTP server's Runs and Mastra's workflow snapshots, a LibSQL file in the data volume. */
export function runsDatabase(dataDirectory: string): string {
  return join(dataDirectory, "iconograph.db");
}

/** Content-addressed image files (Reference Photos) in the data volume. */
export function imagesDirectory(dataDirectory: string): string {
  return join(dataDirectory, "images");
}

/** `child` is strictly below `parent`; both absolute and normalised. */
const isInside = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

/**
 * The real path of `path` (relative to the data volume, or absolute) when it
 * names a file inside the data volume, also after following symlinks; for
 * paths from an untrusted client, so they can't read arbitrary files. A `..`
 * segment is rejected outright, and a path that is outside lexically is
 * rejected before the file system is touched. Every way the path can fail to
 * resolve (missing, a file used as a directory, a symlink loop, no permission)
 * gets the same error as an outside file, and errors name only the path as
 * given, so they never tell which files exist outside the volume, not even
 * through a symlink leading out of it.
 */
export async function resolveInsideDataDirectory(
  path: string,
  dataDirectory: string,
): Promise<string> {
  const outside = () => new Error(`${path} is not a file inside the data volume`);
  if (path.split(/[\\/]/).includes("..")) throw outside();
  const root = resolve(dataDirectory);
  const lexical = resolve(root, path);
  if (!isInside(root, lexical)) throw outside();
  const [realRoot, real] = await Promise.all([
    realpath(root),
    // ENOENT, ENOTDIR, ELOOP, EACCES, …: all look alike from outside, and carry absolute paths.
    realpath(lexical).catch(() => {
      throw outside();
    }),
  ]);
  if (!isInside(realRoot, real)) throw outside();
  if (!(await stat(real)).isFile()) throw new Error(`${path} is not a file`);
  return real;
}
