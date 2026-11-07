import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Schema } from "effect";
import bundledLock from "../models.lock.json";
import { errorMessage } from "./errors";
import { isTemporaryFileOf, writeFileAtomically } from "./files";

/**
 * Licences reviewed for locked weights, downloaded or built (ADR-0002,
 * ADR-0011). InsightFace's `buffalo_l` weights are non-commercial, so they can
 * never be listed here.
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

const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const HttpsUrl = Schema.String.check(Schema.isPattern(/^https:\/\/[^\s]+$/), notInsightFace);
const Size = Schema.Int.check(Schema.isGreaterThan(0));

const weightFields = {
  id: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*$/), notInsightFace),
  /** A bare file name inside the models folder, never a path. */
  file: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*\.onnx$/), notInsightFace),
  sha256: Sha256,
  size: Size,
  license: ModelLicense,
};

/** Weights downloaded from `url` by `ensureModels`; never also a `build` entry. */
export const DownloadedWeight = Schema.Struct({
  ...weightFields,
  url: HttpsUrl,
  build: Schema.optionalKey(Schema.Never),
});

/**
 * Weights that are never downloaded: we choose not to redistribute them (their
 * training data's terms are unsettled, ADR-0011), so each operator builds the
 * file locally with `build.command` from the upstream `build.source`, verified
 * by its SHA-256. `sha256` pins the build's output, so a build must be
 * byte-identical wherever it runs (for FaceNet see scripts/export-facenet.py).
 */
export const BuiltWeight = Schema.Struct({
  ...weightFields,
  /** Never downloaded, so never a `url`. */
  url: Schema.optionalKey(Schema.Never),
  build: Schema.Struct({
    /** The root command that builds `file` into the models folder. */
    command: Schema.String.check(Schema.isPattern(/^bun run [a-z][a-z0-9:-]*$/)),
    /** The export script, relative to the repository root. */
    script: Schema.String.check(Schema.isPattern(/^scripts\/[A-Za-z0-9][A-Za-z0-9._-]*\.py$/)),
    /** The upstream weights the script exports from. */
    source: Schema.Struct({ url: HttpsUrl, sha256: Sha256, size: Size }),
  }),
});

/** Exactly one kind: an entry with both `url` and `build` matches neither. */
export const ModelWeight = Schema.Union([DownloadedWeight, BuiltWeight]);

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
export type DownloadedWeight = typeof DownloadedWeight.Type;
export type BuiltWeight = typeof BuiltWeight.Type;
export type ModelLock = typeof ModelLock.Type;

/** Validate a lock manifest; throws a schema error naming the offending field. */
export const decodeModelLock = Schema.decodeUnknownSync(ModelLock);

/** The committed lock manifest, validated on each read. */
export function readModelLock(): ModelLock {
  return decodeModelLock(bundledLock);
}

/** The models `ensureModels` may download; built ones (FaceNet, ADR-0011) are never among them. */
export function downloadableModelIds(lock: ModelLock): string[] {
  return lock.models.flatMap((model) => (model.url ? [model.id] : []));
}

/** Global `fetch` fits; `signal` aborts the request when the download stalls. */
export type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

/** How long a download may receive nothing (no headers, no body bytes) before it is aborted. */
export const modelDownloadIdleTimeoutMs = 30_000;

/** A `.partial` temp file of a model is stale, and removed, once unmodified this long. */
const staleTempMinimumMs = 10 * 60_000;

export interface EnsureModelsOptions {
  /** Usually `readModelLock()`. */
  lock: ModelLock;
  /** The models folder, usually `modelsDirectory(resolveDataDirectory())`. */
  directory: string;
  /** Model ids to ensure; defaults to every model in the lock. */
  ids?: readonly string[];
  fetch?: Fetch;
  /**
   * A download that receives no data for this long fails; defaults to
   * `modelDownloadIdleTimeoutMs`. There is no limit on its total duration.
   */
  idleTimeoutMs?: number;
}

export interface EnsuredModel {
  id: string;
  path: string;
  sha256: string;
  downloaded: boolean;
}

/**
 * Return verified local paths for the requested models, downloading any missing
 * downloadable ones; a missing built one fails with its build command. A path
 * is only returned after its SHA-256 matches the lock.
 */
export async function ensureModels(options: EnsureModelsOptions): Promise<EnsuredModel[]> {
  const {
    lock,
    directory,
    fetch: fetchModel = fetch,
    idleTimeoutMs = modelDownloadIdleTimeoutMs,
  } = options;
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
        `Model ${model.id} at ${path} could not be read: ${errorMessage(error)}`,
        {
          cause: error,
        },
      );
    });
    if (present === undefined) {
      if (model.build) {
        throw new ModelWeightError(
          `Model ${model.id} is missing at ${path}; it is never downloaded. Build it with \`${model.build.command}\` (pass the same --data-dir).`,
        );
      }
      // A live writer's temp file is touched by every chunk or aborted within the idle
      // period, so one unmodified for far longer was left by a killed process.
      await removeStaleTemps(
        directory,
        model.file,
        Math.max(staleTempMinimumMs, 10 * idleTimeoutMs),
      );
      await download(model, path, fetchModel, idleTimeoutMs);
    } else if (present !== model.sha256) {
      throw new ModelWeightError(
        `Model ${model.id} at ${path} failed SHA-256 verification: expected ${model.sha256}, actual ${present}. ${model.build ? `Rebuild it with \`${model.build.command}\`.` : "Delete the file to re-download it."}`,
      );
    }
    ensured.push({ id: model.id, path, sha256: model.sha256, downloaded: present === undefined });
  }
  return ensured;
}

/** A failure that already names the model and its path or URL. */
class ModelWeightError extends Error {}

/** SHA-256 of a file, or undefined when it does not exist. */
export async function hashFile(path: string): Promise<string | undefined> {
  const hasher = new Bun.CryptoHasher("sha256");
  try {
    for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return hasher.digest("hex");
}

/** Suffix of a download's temp file, `<file>.<uuid>.partial`. */
const partialSuffix = ".partial";

/**
 * Best effort: remove `<file>.<uuid>.partial` temp files in `directory` not
 * modified for `olderThanMs`. Any other file is never touched, and a failure
 * (e.g. another caller removed it first) is ignored.
 */
async function removeStaleTemps(directory: string, file: string, olderThanMs: number) {
  const cutoff = Date.now() - olderThanMs;
  const names = await readdir(directory).catch(() => []);
  for (const name of names) {
    if (!isTemporaryFileOf(name, file, partialSuffix)) continue;
    const temp = join(directory, name);
    try {
      const stats = await lstat(temp);
      if (stats.isFile() && stats.mtimeMs < cutoff) await rm(temp);
    } catch {
      // Best effort: a temp file that can't be removed never fails the download.
    }
  }
}

/**
 * Aborts `signal` with `reason` once `touch` was not called for `ms`; `guard`
 * makes a promise reject with `reason` too, even when its source ignores the
 * signal. `stop` must run on every exit so no timer outlives the download.
 */
function idleWatchdog(ms: number, reason: Error) {
  const controller = new AbortController();
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  aborted.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => clearTimeout(timer);
  return {
    signal: controller.signal,
    touch() {
      stop();
      timer = setTimeout(() => {
        reject(reason);
        controller.abort(reason);
      }, ms);
    },
    stop,
    guard: <A>(promise: Promise<A>) => Promise.race([promise, aborted]),
  };
}

/**
 * Stream into a temp file in the same directory, capped at the locked size, then
 * hash the stored file and rename only after it verifies, so no caller ever sees
 * a partial or unverified file. Receiving nothing for `idleTimeoutMs` (headers
 * or body) aborts the request.
 */
async function download(
  model: DownloadedWeight,
  path: string,
  fetchModel: Fetch,
  idleTimeoutMs: number,
): Promise<void> {
  const idle = idleWatchdog(
    idleTimeoutMs,
    new ModelWeightError(
      `Model ${model.id} download from ${model.url} stalled: no data for ${idleTimeoutMs / 1000} s`,
    ),
  );
  let size = 0;
  try {
    await writeFileAtomically(
      path,
      async (handle) => {
        try {
          idle.touch();
          const response = await idle.guard(fetchModel(model.url, { signal: idle.signal }));
          if (!response.ok || !response.body) {
            await response.body?.cancel().catch(() => undefined);
            throw new ModelWeightError(
              `Model ${model.id} download failed: HTTP ${response.status} from ${model.url}`,
            );
          }
          const reader = response.body.getReader();
          try {
            for (;;) {
              const { done, value: chunk } = await idle.guard(reader.read());
              if (done) break;
              idle.touch();
              size += chunk.byteLength;
              if (size > model.size) {
                throw new ModelWeightError(
                  `Model ${model.id} download from ${model.url} exceeded the locked size of ${model.size} bytes`,
                );
              }
              await handle.write(chunk);
            }
          } catch (error) {
            // Frees the connection; a fetch that honoured the signal already errored the body.
            await reader.cancel().catch(() => undefined);
            throw error;
          }
        } finally {
          idle.stop();
        }
      },
      {
        suffix: partialSuffix,
        verify: async (temp) => {
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
        },
      },
    );
  } catch (error) {
    if (error instanceof ModelWeightError) throw error;
    // A stall that fired during a write surfaces later as the fetch's own AbortError.
    if (idle.signal.aborted) throw idle.signal.reason;
    throw new ModelWeightError(
      `Model ${model.id} download from ${model.url} to ${path} failed: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}
