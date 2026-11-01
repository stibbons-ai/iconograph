import { open, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Schema } from "effect";
import bundledLock from "../models.lock.json";

/**
 * Licences reviewed for automatically fetched weights (ADR-0002). InsightFace's
 * `buffalo_l` weights are non-commercial, so they can never be listed here.
 */
const ModelLicense = Schema.Literals(["MIT", "Apache-2.0"]);

/**
 * Names of InsightFace weights (`buffalo_*`/`antelopev2` packs and their member
 * files), rejected even if mislabelled as permissive. This catches the known
 * names only; the licence literal and the exact-list test of the shipped lock
 * are the other guards.
 */
const insightFace =
  /insightface|buffalo|antelope|scrfd|det_10g|w600k|glintr|2d106det|1k3d68|genderage/i;

const notInsightFace = Schema.makeFilter<string>((value) =>
  insightFace.test(value) ? "InsightFace weights are opt-in and never fetched automatically" : true,
);

export const ModelWeight = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*$/), notInsightFace),
  /** A bare file name inside the models folder, never a path. */
  file: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*\.onnx$/), notInsightFace),
  url: Schema.String.check(Schema.isPattern(/^https:\/\/[^\s]+$/), notInsightFace),
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  size: Schema.Int.check(Schema.isGreaterThan(0)),
  license: ModelLicense,
});

export const ModelLock = Schema.Struct({
  models: Schema.NonEmptyArray(ModelWeight).check(
    Schema.makeFilter((models) => {
      const ids = new Set(models.map((model) => model.id));
      const files = new Set(models.map((model) => model.file));
      return ids.size === models.length && files.size === models.length
        ? true
        : "Model ids and file names must be unique";
    }),
  ),
});

export type ModelWeight = typeof ModelWeight.Type;
export type ModelLock = typeof ModelLock.Type;

/** Validate a lock manifest; throws a schema error naming the offending field. */
export const decodeModelLock = Schema.decodeUnknownSync(ModelLock);

/** The committed lock manifest, validated on each read. */
export function readModelLock(): ModelLock {
  return decodeModelLock(bundledLock);
}

export type Fetch = (url: string) => Promise<Response>;

export interface EnsureModelsOptions {
  /** Usually `readModelLock()`. */
  lock: ModelLock;
  /** The models folder, usually `modelsDirectory(resolveDataDirectory())`. */
  directory: string;
  /** Model ids to ensure; defaults to every model in the lock. */
  ids?: readonly string[];
  fetch?: Fetch;
}

export interface EnsuredModel {
  id: string;
  path: string;
  sha256: string;
  downloaded: boolean;
}

/**
 * Return verified local paths for the requested models, downloading any that are
 * missing. A path is only returned after its SHA-256 matches the lock.
 */
export async function ensureModels(options: EnsureModelsOptions): Promise<EnsuredModel[]> {
  const { lock, directory, fetch: fetchModel = fetch } = options;
  const models = options.ids
    ? options.ids.map((id) => {
        const model = lock.models.find((candidate) => candidate.id === id);
        if (!model) throw new Error(`Unknown model ${id}; not in the lock manifest`);
        return model;
      })
    : lock.models;
  await mkdir(directory, { recursive: true });
  const ensured: EnsuredModel[] = [];
  for (const model of models) {
    const path = join(directory, model.file);
    // ensureModels may get an undecoded lock, so re-check the schema's bare-name rule here.
    if (dirname(resolve(path)) !== resolve(directory)) {
      throw new ModelWeightError(
        `Model ${model.id} file ${model.file} is not a bare file name inside ${directory}`,
      );
    }
    const present = await hashFile(path).catch((error: unknown) => {
      throw new ModelWeightError(
        `Model ${model.id} at ${path} could not be read: ${message(error)}`,
        {
          cause: error,
        },
      );
    });
    if (present === undefined) {
      await download(model, path, fetchModel);
    } else if (present !== model.sha256) {
      throw new ModelWeightError(
        `Model ${model.id} at ${path} failed SHA-256 verification: expected ${model.sha256}, actual ${present}. Delete the file to re-download it.`,
      );
    }
    ensured.push({ id: model.id, path, sha256: model.sha256, downloaded: present === undefined });
  }
  return ensured;
}

/** A failure that already names the model and its path or URL. */
class ModelWeightError extends Error {}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** SHA-256 of a file, or undefined when it does not exist. */
async function hashFile(path: string): Promise<string | undefined> {
  const hasher = new Bun.CryptoHasher("sha256");
  try {
    for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return hasher.digest("hex");
}

/**
 * Stream into a temp file in the same directory, capped at the locked size, then
 * hash the stored file and rename only after it verifies, so no caller ever sees
 * a partial or unverified file.
 */
async function download(model: ModelWeight, path: string, fetchModel: Fetch): Promise<void> {
  const temp = `${path}.${crypto.randomUUID()}.partial`;
  try {
    // Open first so a local failure (EACCES, ENOSPC) never strands a response body.
    const handle = await open(temp, "wx");
    let size = 0;
    try {
      const response = await fetchModel(model.url);
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw new ModelWeightError(
          `Model ${model.id} download failed: HTTP ${response.status} from ${model.url}`,
        );
      }
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > model.size) {
          throw new ModelWeightError(
            `Model ${model.id} download from ${model.url} exceeded the locked size of ${model.size} bytes`,
          );
        }
        await handle.write(chunk);
      }
      await handle.sync();
    } catch (error) {
      // The original failure wins over a close error on the way out.
      await handle.close().catch(() => undefined);
      throw error;
    }
    await handle.close();
    if (size !== model.size) {
      throw new ModelWeightError(
        `Model ${model.id} download from ${model.url} ended after ${size} of ${model.size} bytes`,
      );
    }
    // Hash what was stored, not what was received, so a short write cannot pass.
    const actual = await hashFile(temp);
    if (actual !== model.sha256) {
      throw new ModelWeightError(
        `Model ${model.id} download to ${path} failed SHA-256 verification: expected ${model.sha256}, actual ${actual ?? "missing file"}`,
      );
    }
    await rename(temp, path);
  } catch (error) {
    // A leftover .partial is never at the final path, so a cleanup failure must
    // not replace the original error.
    await rm(temp, { force: true }).catch(() => undefined);
    if (error instanceof ModelWeightError) throw error;
    throw new ModelWeightError(
      `Model ${model.id} download from ${model.url} to ${path} failed: ${message(error)}`,
      { cause: error },
    );
  }
}
