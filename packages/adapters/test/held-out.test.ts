import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { cosineSimilarity, FaceModelError } from "@iconograph/domain";
import { Effect, Layer, ManagedRuntime } from "effect";
import { modelsDirectory } from "../src/data-directory";
import {
  cropFace,
  facenetConfig,
  facenetInput,
  HeldOutFaceEmbedder,
  scoreHeldOut,
  squareCrop,
} from "../src/held-out-embedder";
import { readModelLock } from "../src/models";
import { decodeReferencePhoto } from "../src/reference-photos";
import { fixture, realHeldOutEmbedder, verifiedModelsDirectory } from "./face-models";
import { temporaryDirectories } from "./temporary-directory";

const runtime = ManagedRuntime.make(realHeldOutEmbedder());
afterAll(() => runtime.dispose());
const temporaryDirectory = temporaryDirectories("held-out");

const embedding = (name: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const embedder = yield* HeldOutFaceEmbedder;
      const { image } = yield* decodeReferencePhoto(fixture(name));
      const faces = yield* embedder.detect(image);
      expect(faces).toHaveLength(1);
      return yield* embedder.embed(image, faces[0]!);
    }),
  );

const startupError = (dataDirectory: string) =>
  Effect.runPromise(Effect.flip(Effect.scoped(Layer.build(realHeldOutEmbedder(dataDirectory)))));

describe("square margin crop", () => {
  test("is centred on the box, its side the longer box side over 128/160", () => {
    // 64 px tall box: side 64 × 160 / 128 = 80 around the centre (30, 52).
    expect(squareCrop({ x: 10, y: 20, width: 40, height: 64 })).toEqual({
      left: -10,
      top: 12,
      size: 80,
    });
    expect(squareCrop({ x: 0, y: 0, width: 100, height: 60 }).size).toBe(125);
  });

  // A 200×150 gradient (R = x, G = y, B = 77), so every source pixel is identifiable.
  // Crops of side 160 need no resize, so output pixels must equal source pixels exactly.
  const gradient = {
    data: Uint8Array.from({ length: 200 * 150 * 3 }, (_, index) => {
      const pixel = Math.floor(index / 3);
      return [pixel % 200, Math.floor(pixel / 200), 77][index % 3]!;
    }),
    width: 200,
    height: 150,
  };
  const black = [0, 0, 0];
  const source = (x: number, y: number) => [x, y, 77];
  const pixelOf =
    ({ data, width }: { data: Uint8Array; width: number }) =>
    (x: number, y: number) =>
      Array.from(data.subarray((y * width + x) * 3, (y * width + x) * 3 + 3));

  test("maps source pixels and pads black past the top and left edges", async () => {
    const pixel = pixelOf(await cropFace(gradient, { left: -20, top: -30, size: 160 }));
    expect(pixel(0, 0)).toEqual(black);
    expect(pixel(19, 29)).toEqual(black);
    expect(pixel(19, 100)).toEqual(black);
    expect(pixel(100, 29)).toEqual(black);
    expect(pixel(20, 30)).toEqual(source(0, 0));
    expect(pixel(57, 41)).toEqual(source(37, 11));
    expect(pixel(159, 159)).toEqual(source(139, 129));
  });

  test("pads black past the right and bottom edges, never wrapping into the next row", async () => {
    const pixel = pixelOf(await cropFace(gradient, { left: 100, top: 50, size: 160 }));
    expect(pixel(0, 0)).toEqual(source(100, 50));
    expect(pixel(99, 99)).toEqual(source(199, 149));
    expect(pixel(42, 7)).toEqual(source(142, 57));
    expect(pixel(100, 0)).toEqual(black);
    expect(pixel(159, 50)).toEqual(black);
    expect(pixel(0, 100)).toEqual(black);
    expect(pixel(159, 159)).toEqual(black);
  });

  test("resizes any square to 160×160", async () => {
    const crop = await cropFace(gradient, { left: -10, top: -10, size: 20 });
    expect([crop.width, crop.height, crop.data.length]).toEqual([160, 160, 160 * 160 * 3]);
    // The top-left quarter is padding; the bottom-right quarter is image.
    expect(pixelOf(crop)(20, 20)).toEqual(black);
    expect(pixelOf(crop)(150, 150)[2]).toBe(77);
  });

  test.each([
    ["right of", { left: 200, top: 0, size: 10 }],
    ["left of", { left: -10, top: 0, size: 10 }],
    ["below", { left: 0, top: 150, size: 10 }],
    ["above", { left: 0, top: -10, size: 10 }],
  ])("rejects a crop entirely %s the image", async (_, crop) => {
    await expect(cropFace(gradient, crop)).rejects.toThrow("outside the image");
  });
});

describe("FaceNet input", () => {
  test("is RGB planar, normalised as (x − 127.5) / 128", () => {
    const data = new Uint8Array(160 * 160 * 3);
    data.set([255, 0, 128], 0);
    data.set([10, 20, 30], 3);
    const tensor = facenetInput({ data, width: 160, height: 160 });
    expect(tensor.dims).toEqual([1, 3, 160, 160]);
    const values = tensor.data as Float32Array;
    const plane = 160 * 160;
    expect([values[0], values[plane], values[2 * plane]]).toEqual([
      127.5 / 128,
      -127.5 / 128,
      0.5 / 128,
    ]);
    expect([values[1], values[plane + 1], values[2 * plane + 1]]).toEqual([
      -117.5 / 128,
      -107.5 / 128,
      -97.5 / 128,
    ]);
  });

  test("rejects a crop of another size", () => {
    expect(() =>
      facenetInput({ data: new Uint8Array(112 * 112 * 3), width: 112, height: 112 }),
    ).toThrow("160×160");
  });
});

test("the held-out score passes at the threshold and fails just below it", () => {
  const at = (degrees: number) => [
    Math.cos((degrees * Math.PI) / 180),
    Math.sin((degrees * Math.PI) / 180),
  ];
  const score = scoreHeldOut(at(0), [at(10), at(-10)], Math.cos((10 * Math.PI) / 180));
  // The references' anchor is at 0°, so the anchor similarity is 1 even though
  // each single reference only reaches cos 10°.
  expect(score.anchorSimilarity).toBeCloseTo(1, 12);
  expect(score.similarities.map((value) => value.toFixed(12))).toEqual(
    [Math.cos(Math.PI / 18), Math.cos(Math.PI / 18)].map((value) => value.toFixed(12)),
  );
  expect(scoreHeldOut(at(0), [at(10)], Math.cos(Math.PI / 18)).pass).toBe(true);
  expect(scoreHeldOut(at(0), [at(10)], Math.cos(Math.PI / 18) + 1e-9).pass).toBe(false);
});

describe("YuNet + FaceNet on licence-clear fixtures", () => {
  test("the same person scores at or above the starting threshold across years and photographers", async () => {
    const [a, b, c, heic] = await Promise.all(
      ["biden-2022.jpg", "biden-2013.jpg", "biden-2021.jpg", "biden-2021.heic"].map(embedding),
    );
    for (const [left, right] of [
      [a, b],
      [a, c],
      [b, c],
      [heic, b],
    ] as const) {
      expect(cosineSimilarity(left!, right!)).toBeGreaterThanOrEqual(facenetConfig.threshold);
    }
  });

  test("a different person scores below the starting threshold", async () => {
    const [obama, ...biden] = await Promise.all(
      ["obama-2012.jpg", "biden-2013.jpg", "biden-2021.jpg", "biden-2022.jpg"].map(embedding),
    );
    for (const subject of biden) {
      expect(cosineSimilarity(obama!, subject!)).toBeLessThan(facenetConfig.threshold);
    }
  });

  test("embeddings are L2-normalised 512-d vectors", async () => {
    const vector = await embedding("biden-2021.jpg");
    expect(vector).toHaveLength(512);
    expect(Math.hypot(...vector)).toBeCloseTo(1, 5);
  });
});

describe("held-out weights", () => {
  /** A data volume with only the verified YuNet weights, plus `facenet` contents if given. */
  async function volumeWithYunet(facenet?: string) {
    const dataDirectory = await temporaryDirectory();
    const directory = modelsDirectory(dataDirectory);
    await mkdir(directory, { recursive: true });
    const lock = readModelLock().models;
    const yunet = lock.find(({ id }) => id === "yunet")!;
    await symlink(
      join(await verifiedModelsDirectory(["yunet"]), yunet.file),
      join(directory, yunet.file),
    );
    if (facenet !== undefined) {
      await Bun.write(join(directory, lock.find(({ id }) => id === "facenet")!.file), facenet);
    }
    return dataDirectory;
  }

  test("a missing FaceNet export fails with the build command and is never downloaded", async () => {
    const error = await startupError(await volumeWithYunet());
    expect(error).toBeInstanceOf(FaceModelError);
    expect(error.message).toContain("Model facenet is missing");
    expect(error.message).toContain("Build it with `bun run models:export-facenet`");
    // The test's fetch throws "Face-model weights are missing": it was never called.
    expect(error.message).not.toContain("Face-model weights are missing");
  });

  test("a tampered FaceNet export fails SHA-256 verification", async () => {
    const error = await startupError(await volumeWithYunet("tampered"));
    expect(error).toBeInstanceOf(FaceModelError);
    expect(error.message).toContain("Model facenet at");
    expect(error.message).toContain("failed SHA-256 verification");
    expect(error.message).toContain("Rebuild it with `bun run models:export-facenet`");
  });
});
