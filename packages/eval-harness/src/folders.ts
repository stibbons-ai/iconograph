import { mkdir, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { codeOf, errorMessage, REPOSITORY_ROOT } from "@iconograph/adapters";

/**
 * `path` with symlinks resolved, also when it doesn't exist yet: its nearest
 * existing ancestor resolved, plus the rest as given.
 */
async function realLocation(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (codeOf(error) !== "ENOENT" || dirname(path) === path) throw error;
    return join(await realLocation(dirname(path)), basename(path));
  }
}

/**
 * Refuse `path` (named `what` in the error) when it lies inside the
 * repository's checkout, ignored folders included: Subject photos, Runs,
 * images and reports never go into the repository. macOS and Windows file
 * systems ignore case by default, so there paths compare without it.
 */
export async function refuseInsideRepository(path: string, what: string): Promise<void> {
  const ignoreCase = process.platform === "darwin" || process.platform === "win32";
  const [location, repository] = (
    await Promise.all([realLocation(path), realpath(REPOSITORY_ROOT)])
  ).map((real) => (ignoreCase ? real.toLowerCase() : real));
  if (location === repository || location!.startsWith(repository + sep)) {
    throw new Error(
      `${what} ${path} is inside the repository; keep Subjects and eval output outside it`,
    );
  }
}

/** Where an eval puts everything, inside its output folder. */
export interface OutputLayout {
  readonly folder: string;
  /** The Runs' LibSQL database. */
  readonly database: string;
  /** The Runs' data volume: their images (the price cache stays in a scratch folder). */
  readonly dataDirectory: string;
  /** Every Arm Run, one JSON line each, appended as soon as it is evaluated. */
  readonly runs: string;
  readonly report: string;
}

export const outputLayout = (folder: string): OutputLayout => ({
  folder,
  database: join(folder, "runs.db"),
  dataDirectory: join(folder, "data"),
  runs: join(folder, "runs.jsonl"),
  report: join(folder, "report.json"),
});

/**
 * Refuse an output folder that holds anything, so no earlier eval is mixed in;
 * one that doesn't exist yet, or is empty, is fine. Writes nothing.
 */
export async function checkOutputFolder(path: string): Promise<void> {
  const existing = await readdir(path).catch((error: unknown) => {
    if (codeOf(error) === "ENOENT") return [];
    throw new Error(`The output folder ${path} could not be read: ${errorMessage(error)}`);
  });
  if (existing.length > 0) {
    throw new Error(`The output folder ${path} is not empty; give a new or empty folder`);
  }
}

/** Create the output folder (`checkOutputFolder` passed), and its data volume; never removes anything. */
export async function createOutputFolder(layout: OutputLayout): Promise<void> {
  await checkOutputFolder(layout.folder);
  await mkdir(layout.dataDirectory, { recursive: true });
}
