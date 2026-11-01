import { join, resolve } from "node:path";

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

/** Content-addressed image files (Reference Photos) in the data volume. */
export function imagesDirectory(dataDirectory: string): string {
  return join(dataDirectory, "images");
}
