import { afterAll, describe, expect, test } from "bun:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative as relativePath } from "node:path";
import {
  cosineSimilarity,
  type DetectedFace,
  FaceEmbedder,
  FaceModelError,
  type Point,
} from "@iconograph/domain";
import { Effect, Layer, ManagedRuntime } from "effect";
import sharp from "sharp";
import { sfaceConfig } from "../src/face-embedder";
import { readModelLock } from "../src/models";
import { decodeReferencePhoto, validateReferencePhotos } from "../src/reference-photos";
import { corruptAllWeights, fixture, realFaceEmbedder, rightmostFace } from "./face-models";
import { expectFullMetadata, expectStripped } from "./metadata";
import { temporaryDirectories } from "./temporary-directory";

const runtime = ManagedRuntime.make(realFaceEmbedder());
afterAll(() => runtime.dispose());
const temporaryDirectory = temporaryDirectories("faces");

const validate = async (names: string[], faceChoices?: Map<number, number>) => {
  const dataDirectory = await temporaryDirectory();
  const report = await runtime.runPromise(
    validateReferencePhotos({
      paths: names.map(fixture),
      dataDirectory,
      ...(faceChoices && { faceChoices }),
    }),
  );
  return { report, dataDirectory };
};

/** The error `validateReferencePhotos` fails with, for paths (not fixture names). */
const validationError = (
  paths: string[],
  dataDirectory: string,
  faceChoices?: Map<number, number>,
) =>
  runtime.runPromise(
    Effect.flip(
      validateReferencePhotos({ paths, dataDirectory, ...(faceChoices && { faceChoices }) }),
    ),
  );

/** The error the real backend fails with while starting up. */
const startupError = (options: Parameters<typeof realFaceEmbedder>[0]) =>
  Effect.runPromise(Effect.flip(Effect.scoped(Layer.build(realFaceEmbedder(options)))));

const facesIn = (name: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const embedder = yield* FaceEmbedder;
      const { image } = yield* decodeReferencePhoto(fixture(name));
      const faces = yield* embedder.detect(image);
      return { embedder, image, faces };
    }),
  );

const embedding = async (name: string) => {
  const { embedder, image, faces } = await facesIn(name);
  expect(faces).toHaveLength(1);
  return runtime.runPromise(embedder.embed(image, faces[0]!));
};

describe("YuNet + SFace on licence-clear fixtures", () => {
  test("the same person passes the Identity Gate across years and photographers", async () => {
    const [a, b, c] = await Promise.all(
      ["biden-2022.jpg", "biden-2013.jpg", "biden-2021.jpg"].map(embedding),
    );
    for (const [left, right] of [
      [a, b],
      [a, c],
      [b, c],
    ] as const) {
      expect(cosineSimilarity(left!, right!)).toBeGreaterThanOrEqual(
        sfaceConfig.thresholds.identityGate,
      );
    }
  });

  test("a different person is gated", async () => {
    const [subject, other] = await Promise.all(["biden-2013.jpg", "obama-2012.jpg"].map(embedding));
    expect(cosineSimilarity(subject!, other!)).toBeLessThan(sfaceConfig.thresholds.identityGate);
  });

  test("a HEIC photo matches the Subject's other photos", async () => {
    const [heic, jpeg] = await Promise.all(["biden-2021.heic", "biden-2013.jpg"].map(embedding));
    expect(cosineSimilarity(heic!, jpeg!)).toBeGreaterThanOrEqual(
      sfaceConfig.thresholds.identityGate,
    );
  });

  test("embeddings are L2-normalised 128-d vectors", async () => {
    const vector = await embedding("biden-2021.jpg");
    expect(vector).toHaveLength(128);
    expect(Math.hypot(...vector)).toBeCloseTo(1, 5);
  });

  test("detection finds no face in a photo without one", async () => {
    expect((await facesIn("earth-apollo17.jpg")).faces).toEqual([]);
  });

  test("small landmark jitter barely moves the embedding", async () => {
    const { embedder, image, faces } = await facesIn("biden-2021.jpg");
    const face = faces[0]!;
    const original = await runtime.runPromise(embedder.embed(image, face));
    // Shift each landmark by up to 1.5 px (a few percent of the eye distance).
    const [rightEye, leftEye, nose, rightMouth, leftMouth] = face.landmarks;
    const shift = ({ x, y }: Point, dx: number, dy: number): Point => ({ x: x + dx, y: y + dy });
    const jittered: DetectedFace = {
      ...face,
      landmarks: [
        shift(rightEye, 1.5, -1),
        shift(leftEye, -1, 1.5),
        shift(nose, 1, 1),
        shift(rightMouth, -1.5, -0.5),
        shift(leftMouth, 0.5, -1.5),
      ],
    };
    const moved = await runtime.runPromise(embedder.embed(image, jittered));
    expect(cosineSimilarity(original, moved)).toBeGreaterThan(0.95);
  });

  test("detection is consistent across resolutions", async () => {
    // A 2× upscale exercises the resize-to-640 path; boxes scale back to the input.
    const { embedder, image, faces } = await facesIn("biden-2021.jpg");
    const larger = await sharp(image.data, {
      raw: { width: image.width, height: image.height, channels: 3 },
    })
      .resize(image.width * 2, image.height * 2)
      .raw()
      .toBuffer();
    const scaled = await runtime.runPromise(
      embedder.detect({
        data: new Uint8Array(larger),
        width: image.width * 2,
        height: image.height * 2,
      }),
    );
    expect(scaled).toHaveLength(1);
    expect(scaled[0]!.box.x / 2).toBeCloseTo(faces[0]!.box.x, -1);
    expect(scaled[0]!.box.width / 2).toBeCloseTo(faces[0]!.box.width, -1);
  });
});

describe("Reference Photo validation", () => {
  test("reports each verdict: accepted, flagged, rejected with no face, choice required", async () => {
    const { report, dataDirectory } = await validate([
      "biden-2022.jpg",
      "biden-2013-gps-rotated.jpg",
      "biden-2021.jpg",
      "obama-2012.jpg",
      "earth-apollo17.jpg",
      "obama-biden-2015.jpg",
    ]);
    expect(report.photos.map(({ photo, verdict }) => [photo, verdict])).toEqual([
      [1, "accepted"],
      [2, "accepted"],
      [3, "accepted"],
      [4, "flagged"],
      [5, "rejected"],
      [6, "choice-required"],
    ]);
    const flagged = report.photos[3]!;
    expect(flagged.verdict === "flagged" && flagged.similarity).toBeLessThan(
      sfaceConfig.thresholds.identityGate,
    );
    const group = report.photos[5]!;
    expect(group.verdict === "choice-required" && group.faces.map(({ face }) => face)).toEqual([
      1, 2,
    ]);
    expect(report.identity?.photos).toEqual([1, 2, 3]);
    expect(report.identity?.anchor).toHaveLength(128);
    expect(report.identity?.ceiling.source).toBe("median-pairwise");
    expect(report.identity!.ceiling.value).toBeGreaterThan(sfaceConfig.thresholds.identityGate);
    expect(report.warnings).toEqual([]);
    // Only the three accepted photos were stored, and none carries the upload's metadata.
    const stored = report.photos.flatMap((photo) =>
      photo.verdict === "accepted" ? [photo.stored] : [],
    );
    expect((await readdir(join(dataDirectory, "images"))).sort()).toEqual(
      stored.map(({ sha256 }) => `${sha256}.jpg`).sort(),
    );
    await expectFullMetadata(fixture("biden-2013-gps-rotated.jpg"));
    for (const { path } of stored) await expectStripped(path);
  });

  test("choosing the Subject's face in a group photo lets it proceed", async () => {
    // Biden (the Subject) stands on the right of the group photo, Obama on the left;
    // pick by position, not by the near-equal detection scores.
    const { faces } = await facesIn("obama-biden-2015.jpg");
    expect(faces).toHaveLength(2);
    const subjectFace = rightmostFace(faces);
    const otherFace = 3 - subjectFace;
    const subject = await validate(
      ["biden-2022.jpg", "obama-biden-2015.jpg"],
      new Map([[2, subjectFace]]),
    );
    expect(subject.report.photos.map(({ verdict }) => verdict)).toEqual(["accepted", "accepted"]);
    const chosen = subject.report.photos[1]!;
    expect(chosen.verdict === "accepted" && chosen.face.face).toBe(subjectFace);
    expect(subject.report.warnings).toEqual([
      "Only 2 accepted Reference Photos; Likeness is less reliable below 3",
    ]);

    const someoneElse = await validate(
      ["biden-2022.jpg", "biden-2021.jpg", "obama-biden-2015.jpg"],
      new Map([[3, otherFace]]),
    );
    expect(someoneElse.report.photos.map(({ verdict }) => verdict)).toEqual([
      "accepted",
      "accepted",
      "flagged",
    ]);
  });

  test("a single photo uses the face model's default Identity Ceiling", async () => {
    const { report } = await validate(["biden-2021.jpg"]);
    expect(report.identity?.ceiling).toEqual({
      value: sfaceConfig.thresholds.singlePhotoCeiling,
      source: "single-photo-default",
    });
    expect(report.photos[0]).toMatchObject({ verdict: "accepted", similarity: null });
  });

  test("a face choice must name a detected face and a given photo", async () => {
    const group = [fixture("obama-biden-2015.jpg")];
    const dataDirectory = await temporaryDirectory();
    expect((await validationError(group, dataDirectory, new Map([[1, 3]]))).message).toContain(
      "Face 3 was chosen",
    );
    expect((await validationError(group, dataDirectory, new Map([[2, 1]]))).message).toContain(
      "Face choice for photo 2, but only 1 photos were given",
    );
    for (const photo of [0, -1]) {
      expect((await validationError(group, dataDirectory, new Map([[photo, 1]]))).message).toBe(
        `Face choice for photo ${photo}: photos are numbered from 1`,
      );
    }
  });

  test("rejects the same file given twice and two files with identical pixels", async () => {
    const dataDirectory = await temporaryDirectory();
    const original = fixture("biden-2021.jpg");
    const run = (paths: string[]) => validationError(paths, dataDirectory);

    const samePath = await run([original, fixture("biden-2013.jpg"), original]);
    expect(samePath).toMatchObject({ photo: original });
    expect(samePath.message).toBe(`Reference Photos ${original} and ${original} are the same file`);
    // The same file under another spelling of its path is still the same file.
    const relative = relativePath(process.cwd(), original);
    const sameResolved = await run([original, `./${relative}`]);
    expect(sameResolved.message).toBe(
      `Reference Photos ${original} and ./${relative} are the same file`,
    );

    const copy = join(dataDirectory, "copy-with-new-metadata.jpg");
    // Same pixels, different bytes: a JPEG comment segment (FFFE) inserted after SOI.
    const bytes = await readFile(original);
    const comment = Buffer.from("a copy");
    const segment = Buffer.from([0xff, 0xfe, 0, comment.length + 2]);
    await writeFile(
      copy,
      Buffer.concat([bytes.subarray(0, 2), segment, comment, bytes.subarray(2)]),
    );
    const samePixels = await run([original, copy]);
    expect(samePixels).toMatchObject({ photo: copy });
    expect(samePixels.message).toBe(`Reference Photos ${original} and ${copy} are the same image`);
  });
});

describe("face-model failures", () => {
  test("missing weights fail with a FaceModelError and never reach the network", async () => {
    const error = await startupError({ dataDirectory: await temporaryDirectory() });
    expect(error).toBeInstanceOf(FaceModelError);
    expect(error.message).toStartWith("Verifying face-model weights failed:");
    // The download went to the test's stubbed fetch, with the locked YuNet URL.
    const yunet = readModelLock().models.find(({ id }) => id === "yunet")!;
    expect(error.message).toContain(`Face-model weights are missing (${yunet.url})`);
  });

  test("a corrupt weight file fails SHA-256 verification and is never loaded", async () => {
    const dataDirectory = await temporaryDirectory();
    await corruptAllWeights(dataDirectory);
    const error = await startupError({ dataDirectory });
    expect(error).toBeInstanceOf(FaceModelError);
    expect(error.message).toContain("failed SHA-256 verification");
  });

  test("thresholds outside [-1, 1] are rejected when the backend starts", async () => {
    const error = await startupError({
      thresholds: { identityGate: 2, singlePhotoCeiling: 0.6 },
    });
    expect(error).toBeInstanceOf(FaceModelError);
    expect(error.message).toContain("Invalid sface identity thresholds");
  });

  test("an image whose pixel data doesn't match its size is rejected, not read short", async () => {
    const error = await runtime.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          const embedder = yield* FaceEmbedder;
          return yield* embedder.detect({ data: new Uint8Array(10), width: 4, height: 4 });
        }),
      ),
    );
    expect(error.message).toContain("expected 4×4×3 = 48 bytes, got 10");
  });

  test.each(["detect", "embed"] as const)(
    "a face-model failure in %s names the photo, in the error and its message",
    async (step) => {
      const face: DetectedFace = {
        box: { x: 0, y: 0, width: 10, height: 10 },
        landmarks: [
          { x: 2, y: 3 },
          { x: 8, y: 3 },
          { x: 5, y: 5 },
          { x: 3, y: 8 },
          { x: 7, y: 8 },
        ],
        score: 0.99,
      };
      const boom = Effect.fail(new FaceModelError({ message: `Face ${step} failed: boom` }));
      const failing = Layer.succeed(FaceEmbedder)({
        model: "failing",
        thresholds: sfaceConfig.thresholds,
        detect: () => (step === "detect" ? boom : Effect.succeed([face])),
        embed: () => boom,
      });
      const path = fixture("biden-2021.jpg");
      const error = await Effect.runPromise(
        Effect.flip(
          validateReferencePhotos({
            paths: [path],
            dataDirectory: await temporaryDirectory(),
          }).pipe(Effect.provide(failing)),
        ),
      );
      expect(error).toBeInstanceOf(FaceModelError);
      expect(error).toMatchObject({
        photo: path,
        message: `Reference Photo ${path}: Face ${step} failed: boom`,
      });
    },
  );
});
