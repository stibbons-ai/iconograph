import { describe, expect, test } from "bun:test";
import { readdir, readFile, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import sharp from "sharp";
import {
  decodeReferencePhoto,
  encodeReferencePhoto,
  HeicDecoderError,
  loadCharacterReference,
  MAX_PHOTO_BYTES,
  MAX_PHOTO_PIXELS,
  ReferencePhotoError,
  storeReferencePhoto,
} from "../src/reference-photos";
import { fixture } from "./face-models";
import { enlargedFixture, imageSize, solidImage } from "./large-images";
import { expectFullMetadata, expectStripped } from "./metadata";
import { temporaryDirectories } from "./temporary-directory";

const temporaryDirectory = temporaryDirectories("photos");

const decode = (path: string) => Effect.runPromise(decodeReferencePhoto(path));
const decodeError = (path: string) => Effect.runPromise(Effect.flip(decodeReferencePhoto(path)));

function meanAbsoluteDifference(left: Uint8Array, right: Uint8Array): number {
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference += Math.abs(left[index]! - right[index]!);
  }
  return difference / left.length;
}

describe("decoding Reference Photos", () => {
  test("decodes JPEG fully into upright RGB pixels", async () => {
    const { format, image } = await decode(fixture("biden-2021.jpg"));
    expect(format).toBe("jpeg");
    expect([image.width, image.height]).toEqual([500, 625]);
    expect(image.data.length).toBe(500 * 625 * 3);
  });

  test("decodes PNG, flattening transparency", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "transparent.png");
    // Left half opaque black, right half fully transparent.
    const pixels = new Uint8Array(4 * 2 * 4);
    for (let index = 0; index < 8; index++) pixels[index * 4 + 3] = index % 2 === 0 ? 255 : 0;
    await sharp(pixels, { raw: { width: 2, height: 4, channels: 4 } })
      .png()
      .toFile(path);
    const { format, image } = await decode(path);
    expect(format).toBe("png");
    expect(Array.from(image.data.subarray(0, 6))).toEqual([0, 0, 0, 255, 255, 255]);
  });

  test("applies EXIF orientation before detection sees the pixels", async () => {
    // The fixture's pixels are stored rotated a quarter turn with Orientation=6.
    const raw = await sharp(fixture("biden-2013-gps-rotated.jpg")).metadata();
    expect([raw.width, raw.height, raw.orientation]).toEqual([625, 500, 6]);
    const { image } = await decode(fixture("biden-2013-gps-rotated.jpg"));
    expect([image.width, image.height]).toEqual([500, 625]);
    const upright = await decode(fixture("biden-2013.jpg"));
    // Same picture as the unrotated original, up to JPEG re-encoding noise.
    expect(meanAbsoluteDifference(image.data, upright.image.data)).toBeLessThan(3);
  });

  test("decodes HEIC in software to the same picture as its JPEG source", async () => {
    const { format, image } = await decode(fixture("biden-2021.heic"));
    expect(format).toBe("heic");
    expect([image.width, image.height]).toEqual([500, 625]);
    const source = await decode(fixture("biden-2021.jpg"));
    // HEVC at quality 60 versus the JPEG it was made from.
    expect(meanAbsoluteDifference(image.data, source.image.data)).toBeLessThan(6);
  });

  test.each(["mif1", "msf1"])(
    "accepts HEIC whose major brand is the generic %s",
    async (majorBrand) => {
      const bytes = await readFile(fixture("biden-2021.heic"));
      expect(bytes.toString("latin1", 4, 12)).toBe("ftypheic");
      bytes.write(majorBrand, 8, "latin1");
      const path = join(await temporaryDirectory(), `generic-${majorBrand}.heic`);
      await writeFile(path, bytes);
      const { format, image } = await decode(path);
      expect(format).toBe("heic");
      expect([image.width, image.height]).toEqual([500, 625]);
    },
  );

  test("HEIC corruption detection is best-effort: corrupt HEVC data still decodes", async () => {
    // Pins the documented limitation (round 3, R3-1): libde265 conceals bitstream
    // errors and libheif reports none, even with strict decoding. If a future
    // decoder starts rejecting this, update the README, the help and this test.
    const bytes = new Uint8Array(await readFile(fixture("biden-2021.heic")));
    for (let index = bytes.length - 3000; index < bytes.length - 2; index += 97)
      bytes[index]! ^= 0x55;
    const path = join(await temporaryDirectory(), "corrupt-hevc.heic");
    await writeFile(path, bytes);
    const { image } = await decode(path);
    const clean = await decode(fixture("biden-2021.heic"));
    expect([image.width, image.height]).toEqual([500, 625]);
    // Visibly damaged, yet no error: the same corruption in a JPEG is rejected.
    expect(meanAbsoluteDifference(image.data, clean.image.data)).toBeGreaterThan(1);
  });

  test("rejects a truncated HEIC with libheif's reason", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "truncated.heic");
    const bytes = await readFile(fixture("biden-2021.heic"));
    await writeFile(path, bytes.subarray(0, bytes.length / 3));
    const error = await decodeError(path);
    expect(error).toBeInstanceOf(ReferencePhotoError);
    expect(error).toMatchObject({ photo: path });
    // libheif's own reason, not just the wrapper's prefix.
    expect(error.message).toMatch(/could not be decoded: Invalid input: .+/);
  });

  test("rejects a truncated JPEG with a typed error naming the photo", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "truncated.jpg");
    const bytes = await readFile(fixture("biden-2022.jpg"));
    await writeFile(path, bytes.subarray(0, bytes.length / 3));
    const error = await decodeError(path);
    expect(error).toBeInstanceOf(ReferencePhotoError);
    expect(error).toMatchObject({ photo: path });
    expect(error.message).toContain(path);
  });

  test("rejects a file that isn't an image", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "notes.jpg");
    await writeFile(path, "not an image, despite the name");
    const error = await decodeError(path);
    expect(error).toBeInstanceOf(ReferencePhotoError);
    expect(error).toMatchObject({ photo: path });
    expect(error.message).toContain("not a JPEG, PNG or HEIC image");
  });

  test("rejects an image with a valid header but corrupt data", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "corrupt.jpg");
    const bytes = new Uint8Array(await readFile(fixture("biden-2022.jpg")));
    // Keep the JPEG header, scramble the entropy-coded data.
    for (let index = 1000; index < bytes.length - 2; index += 7)
      bytes[index] = 0xff - bytes[index]!;
    await writeFile(path, bytes);
    const error = await decodeError(path);
    expect(error).toBeInstanceOf(ReferencePhotoError);
    expect(error.message).toContain(`Reference Photo ${path} could not be decoded:`);
  });

  test("rejects an oversized upload before reading it", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "huge.jpg");
    await writeFile(path, new Uint8Array([0xff, 0xd8, 0xff]));
    await truncate(path, MAX_PHOTO_BYTES + 1);
    expect((await decodeError(path)).message).toContain("exceeds");
  });

  /** A uniform-grey image of the given size: a few KB on disk however large. */
  const solid = async (name: string, width: number, height: number) =>
    solidImage(join(await temporaryDirectory(), name), { width, height });

  test.each([
    ["PNG", "huge.png"],
    ["JPEG", "huge.jpg"],
  ])("rejects a %s over the 50 MP cap from its header", async (_, name) => {
    const path = await solid(name, 9000, 6000); // 54 MP
    const error = await decodeError(path);
    expect(error).toBeInstanceOf(ReferencePhotoError);
    expect(error).toMatchObject({ photo: path });
    expect(error.message).toContain("pixel limit");
  });

  test("accepts a 48 MP photo, the size of recent iPhones' HEIC captures", async () => {
    expect(MAX_PHOTO_PIXELS).toBe(50_000_000);
    const { image } = await decode(await solid("48mp.jpg", 8000, 6000));
    expect([image.width, image.height]).toEqual([8000, 6000]);
  });

  test("rejects a HEIC over the pixel cap before decoding its pixels", async () => {
    const path = fixture("oversized-54mp.heic");
    const error = await decodeError(path);
    expect(error).toBeInstanceOf(ReferencePhotoError);
    expect(error).toMatchObject({ photo: path });
    expect(error.message).toContain(`9000×6000 pixels exceeds the ${MAX_PHOTO_PIXELS}-pixel limit`);
  });

  test.each(["avif", "mif1"])(
    "rejects AVIF as unsupported, also when its major brand is the generic %s",
    async (majorBrand) => {
      const path = join(await temporaryDirectory(), "photo.avif");
      const bytes = await sharp(fixture("biden-2021.jpg")).avif().toBuffer();
      // sharp writes major brand `avif` with `mif1` and `avif` among the compatible
      // brands; a `mif1` major brand leaves only the compatible `avif` to go on.
      expect(bytes.toString("latin1", 4, 12)).toBe("ftypavif");
      expect(bytes.toString("latin1", 16, 28)).toContain("avif");
      bytes.write(majorBrand, 8, "latin1");
      await writeFile(path, bytes);
      expect((await decodeError(path)).message).toContain("not a JPEG, PNG or HEIC image");
    },
  );

  test("a HEIC decoder that fails to load is reported as such, not as a bad photo", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        decodeReferencePhoto(fixture("biden-2021.heic"), async () => {
          throw new Error("wasm missing");
        }),
      ),
    );
    expect(error).toBeInstanceOf(HeicDecoderError);
    expect(error.message).toBe("The HEIC decoder could not be loaded: wasm missing");
    expect(error).not.toHaveProperty("photo");
  });
});

describe("storing Reference Photos", () => {
  test("strips EXIF, GPS, XMP, IPTC and ICC metadata and stores by content hash", async () => {
    const source = fixture("biden-2013-gps-rotated.jpg");
    await expectFullMetadata(source);
    const data = await temporaryDirectory();
    const { image } = await decode(source);
    const encoded = await Effect.runPromise(encodeReferencePhoto(source, image));
    const stored = await Effect.runPromise(storeReferencePhoto(source, encoded, data));

    expect(stored.path).toBe(join(data, "images", `${stored.sha256}.jpg`));
    const bytes = await readFile(stored.path);
    expect(Bun.CryptoHasher.hash("sha256", bytes, "hex")).toBe(stored.sha256);
    await expectStripped(stored.path);
    const { width, height } = await sharp(stored.path).metadata();
    expect([width, height]).toEqual([500, 625]);

    // Encoding is deterministic, so the same pixels reuse the same content-addressed file.
    const reencoded = await Effect.runPromise(encodeReferencePhoto(source, image));
    expect(reencoded.sha256).toBe(encoded.sha256);
    const again = await Effect.runPromise(storeReferencePhoto(source, reencoded, data));
    expect(again).toEqual(stored);
    expect(await readdir(join(data, "images"))).toEqual([`${stored.sha256}.jpg`]);
  });
});

describe("character references", () => {
  test("are sent as stored up to 2048 px, and downscaled to 2048 px beyond", async () => {
    const directory = await temporaryDirectory();
    const within = await enlargedFixture("biden-2013.jpg", 1200, 1500, directory);
    const sent = await Effect.runPromise(loadCharacterReference({ path: within, sha256: "x" }));
    expect(sent).toEqual({ bytes: await Bun.file(within).bytes(), mimeType: "image/jpeg" });

    const beyond = await enlargedFixture("biden-2013.jpg", 2400, 3000, directory);
    const downscaled = await Effect.runPromise(
      loadCharacterReference({ path: beyond, sha256: "y" }),
    );
    expect(downscaled.mimeType).toBe("image/jpeg");
    expect(await imageSize(downscaled.bytes)).toEqual({ width: 1638, height: 2048 });
  });
});
