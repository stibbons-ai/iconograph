import { join } from "node:path";
import sharp from "sharp";
import { fixture } from "./face-models";

/**
 * A face fixture enlarged to `width` × `height` and written as JPEG into
 * `directory`, for tests that need an image larger than a vendor limit (every
 * committed fixture is under 700 px). Returns its path.
 */
export async function enlargedFixture(
  name: string,
  width: number,
  height: number,
  directory: string,
): Promise<string> {
  const path = join(directory, `${width}x${height}-${name}`);
  await sharp(await Bun.file(fixture(name)).bytes())
    .resize(width, height, { fit: "fill" })
    .jpeg({ quality: 90 })
    .toFile(path);
  return path;
}

/** An encoded image's width and height. */
export async function imageSize(bytes: Uint8Array): Promise<{ width: number; height: number }> {
  const { width = 0, height = 0 } = await sharp(bytes).metadata();
  return { width, height };
}

/**
 * A uniform image written to `path`: grey, or fully transparent with `alpha`
 * (as PNG); PNG when `path` ends in `.png`, else JPEG, with an EXIF
 * `orientation` if given. A few KB on disk however large.
 */
export async function solidImage(
  path: string,
  {
    width,
    height,
    alpha = false,
    orientation,
  }: { width: number; height: number; alpha?: boolean; orientation?: number },
): Promise<string> {
  const image = sharp({
    create: {
      width,
      height,
      channels: alpha ? 4 : 3,
      background: alpha ? { r: 0, g: 0, b: 0, alpha: 0 } : "#808080",
    },
    limitInputPixels: false,
  });
  const encoded = alpha || path.endsWith(".png") ? image.png() : image.jpeg();
  await (orientation ? encoded.withMetadata({ orientation }) : encoded).toFile(path);
  return path;
}
