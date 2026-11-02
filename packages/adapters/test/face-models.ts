import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FaceBox } from "@iconograph/domain";
import { modelsDirectory, resolveDataDirectory } from "../src/data-directory";
import { OnnxFaceEmbedder, type OnnxFaceEmbedderOptions } from "../src/face-embedder";
import { OnnxHeldOutFaceEmbedder } from "../src/held-out-embedder";
import { ensureModels, type Fetch, readModelLock } from "../src/models";

/**
 * Where `bun run models:fetch` puts the weights, resolved the same way:
 * `ICONOGRAPH_DATA_DIR` when set, else the repo's `.data` (the script's default
 * from the repo root), independent of the directory the tests run from.
 */
const weightsDataDirectory = resolveDataDirectory(undefined, {
  ICONOGRAPH_DATA_DIR:
    process.env.ICONOGRAPH_DATA_DIR || fileURLToPath(new URL("../../../.data", import.meta.url)),
});

/** The number (from 1) of the right-most face: Biden in `obama-biden-2015.jpg`. */
export function rightmostFace(faces: readonly { box: FaceBox }[]): number {
  return faces.reduce((best, { box }, index) => (box.x > faces[best]!.box.x ? index : best), 0) + 1;
}

export const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/faces/${name}`, import.meta.url));

/** Face tests need the real, locked weights: fail with the fix command, never download or skip. */
const missingWeights: Fetch = async (url) => {
  throw new Error(
    `Face-model weights are missing (${url}); run \`bun run models:fetch\` before the face tests`,
  );
};

/** The real YuNet + SFace backend on the verified local weights (or `dataDirectory`'s). */
export const realFaceEmbedder = (options: Partial<Omit<OnnxFaceEmbedderOptions, "fetch">> = {}) =>
  OnnxFaceEmbedder({ dataDirectory: weightsDataDirectory, fetch: missingWeights, ...options });

/**
 * The real YuNet + FaceNet held-out backend on the verified local weights (or
 * `dataDirectory`'s). FaceNet is built, never fetched: a missing file fails with
 * `bun run models:export-facenet`.
 */
export const realHeldOutEmbedder = (dataDirectory = weightsDataDirectory) =>
  OnnxHeldOutFaceEmbedder({ dataDirectory, fetch: missingWeights });

/**
 * Put corrupt files at every locked weight path in `dataDirectory`, so the
 * backend fails verification there and never has a missing file to download.
 */
export async function corruptAllWeights(dataDirectory: string): Promise<void> {
  const directory = modelsDirectory(dataDirectory);
  await mkdir(directory, { recursive: true });
  for (const { file } of readModelLock().models) {
    await writeFile(join(directory, file), "corrupt");
  }
}

/**
 * The verified local models folder, for a spawned CLI to link into its data
 * volume. Only `ids` are verified, so SFace tests never need the FaceNet build.
 */
export async function verifiedModelsDirectory(ids: readonly string[]): Promise<string> {
  const directory = modelsDirectory(weightsDataDirectory);
  await ensureModels({ lock: readModelLock(), directory, ids, fetch: missingWeights });
  return directory;
}

/** A fresh data volume (from `temporaryDirectory`) whose models folder links to the verified `ids`. */
export async function dataVolume(
  temporaryDirectory: () => Promise<string>,
  ids: readonly string[],
): Promise<string> {
  const data = await temporaryDirectory();
  await symlink(await verifiedModelsDirectory(ids), join(data, "models"));
  return data;
}

/** Run a CLI module (`src/<name>`) as its own Bun process, with stdout and stderr piped. */
export const spawnCli = (name: string, args: readonly string[]) =>
  Bun.spawn(
    [process.execPath, fileURLToPath(new URL(`../src/${name}`, import.meta.url)), ...args],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
