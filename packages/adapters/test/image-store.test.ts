import { expect, test } from "bun:test";
import { join } from "node:path";
import sharp from "sharp";
import { isStorableImageType, readImageAtMost } from "../src/image-store";
import { fixture } from "./face-models";
import { enlargedFixture, imageSize, solidImage } from "./large-images";
import { temporaryDirectories } from "./temporary-directory";

const temporaryDirectory = temporaryDirectories("image-store");

test("only JPEG and PNG are storable; vendor text naming an Object property is not", () => {
  expect(isStorableImageType("image/jpeg")).toBe(true);
  expect(isStorableImageType("image/png")).toBe(true);
  for (const type of ["image/heic", "image/webp", "constructor", "toString", "__proto__"]) {
    expect(isStorableImageType(type)).toBe(false);
  }
});

test("an image sent at most N px is downscaled to fit, and one already within N is sent as is", async () => {
  // A 2000 × 2500 portrait, as a Candidate from a 2K Image Model can be.
  const large = await enlargedFixture("biden-2013.jpg", 2000, 2500, await temporaryDirectory());
  const resized = await readImageAtMost(large, "image/jpeg", 1024);
  expect(resized.mimeType).toBe("image/jpeg");
  expect(await imageSize(resized.bytes)).toEqual({ width: 819, height: 1024 });

  const small = fixture("biden-2013.jpg");
  const asIs = await readImageAtMost(small, "image/jpeg", 1024);
  expect(asIs).toEqual({ bytes: await Bun.file(small).bytes(), mimeType: "image/jpeg" });
});

/** Whether an encoded image's first pixel is white. */
async function startsWhite(bytes: Uint8Array) {
  const { data } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  return [...data.subarray(0, 3)].every((channel) => channel > 250);
}

test.each([
  ["a downscaled image", 2000, false],
  ["a small image when normalising", 600, true],
] as const)("%s is upright, flattened onto white JPEG", async (_, side, normalise) => {
  const directory = await temporaryDirectory();
  // Stored sideways: EXIF orientation 6 shows a side × 0.6 side image as 0.6 side × side.
  const sideways = await solidImage(join(directory, "sideways.jpg"), {
    width: side,
    height: side * 0.6,
    orientation: 6,
  });
  const upright = await readImageAtMost(sideways, "image/jpeg", 1024, { normalise });
  const { width, height } = await imageSize(upright.bytes);
  expect(height).toBeGreaterThan(width);

  const transparent = await solidImage(join(directory, "transparent.png"), {
    width: side,
    height: side,
    alpha: true,
  });
  const flattened = await readImageAtMost(transparent, "image/png", 1024, { normalise });
  expect(flattened.mimeType).toBe("image/jpeg");
  expect(await startsWhite(flattened.bytes)).toBe(true);
});

test("normalising never enlarges: a small image keeps its size, as JPEG", async () => {
  const small = await solidImage(join(await temporaryDirectory(), "small.png"), {
    width: 400,
    height: 300,
  });
  const normalised = await readImageAtMost(small, "image/png", 1024, { normalise: true });
  expect(normalised.mimeType).toBe("image/jpeg");
  expect(await imageSize(normalised.bytes)).toEqual({ width: 400, height: 300 });
});

test("bytes that aren't an image fail", async () => {
  const garbage = join(await temporaryDirectory(), "garbage.jpg");
  await Bun.write(garbage, "not an image");
  await expect(readImageAtMost(garbage, "image/jpeg", 1024)).rejects.toThrow(
    /unsupported image format/,
  );
});
