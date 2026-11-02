import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { imagesDirectory } from "./data-directory";
import { writeFileAtomically } from "./files";

/**
 * File extensions of the image types the store accepts: JPEG and PNG, which
 * the face pipeline decodes directly. HEIC (decodable, but not a type Image
 * Models return) and anything else are rejected, so a stored Candidate can be scored.
 */
const extensions: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
};

/** Whether the store takes this MIME type; a vendor's type is untrusted text. */
export function isStorableImageType(mimeType: string): boolean {
  return Object.hasOwn(extensions, mimeType);
}

export interface StoredImage {
  path: string;
  sha256: string;
}

/** Where an image with this content hash and type lives in the data volume. */
export function imagePath(dataDirectory: string, sha256: string, mimeType: string): string {
  if (!isStorableImageType(mimeType)) throw new Error(`Unsupported image type ${mimeType}`);
  return join(imagesDirectory(dataDirectory), `${sha256}.${extensions[mimeType]}`);
}

/**
 * Write image bytes into the content-addressed store, named by their SHA-256.
 * Writing the same content again replaces the file with identical bytes.
 */
export async function storeImage(
  bytes: Uint8Array,
  mimeType: string,
  dataDirectory: string,
): Promise<StoredImage> {
  const sha256 = Bun.CryptoHasher.hash("sha256", bytes, "hex");
  const path = imagePath(dataDirectory, sha256, mimeType);
  await mkdir(imagesDirectory(dataDirectory), { recursive: true });
  await writeFileAtomically(path, (file) => file.writeFile(bytes), { suffix: ".tmp" });
  return { path, sha256 };
}
