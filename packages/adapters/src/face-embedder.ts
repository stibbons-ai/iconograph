import {
  type DetectedFace,
  type Embedding,
  FaceEmbedder,
  FaceModelError,
  IdentityThresholds,
  normalize,
  type Point,
  type RgbImage,
} from "@iconograph/domain";
import { Effect, Layer, Schema } from "effect";
import { env, InferenceSession, Tensor } from "onnxruntime-node";
import sharp from "sharp";
import { estimateSimilarity, warpAffine } from "./alignment";
import { modelsDirectory } from "./data-directory";
import { errorMessage } from "./errors";
import { ensureModels, type Fetch, readModelLock } from "./models";

/**
 * Configuration of the default YuNet + SFace backend (ADR-0002, ADR-0008). Every
 * threshold the pipeline uses lives here, never inline.
 */
export const sfaceConfig = {
  model: "sface",
  detection: {
    /** YuNet 2023mar takes a fixed 640×640 input. */
    inputSize: 640,
    /** OpenCV `FaceDetectorYN` defaults. */
    scoreThreshold: 0.9,
    nmsThreshold: 0.3,
  },
  thresholds: {
    /** ADR-0008; to be calibrated on real pairs in Milestone 0 (issue #1). */
    identityGate: 0.4,
    /**
     * Provisional single-photo Identity Ceiling, between the Gate and typical
     * same-person SFace similarity on good portraits; to be calibrated with the
     * Gate in Milestone 0 (issue #1).
     */
    singlePhotoCeiling: 0.6,
  } satisfies IdentityThresholds,
} as const;

/** SFace's 112×112 five-point template (OpenCV `FaceRecognizerSF::alignCrop`). */
const sfaceTemplate: readonly Point[] = [
  { x: 38.2946, y: 51.6963 },
  { x: 73.5318, y: 51.5014 },
  { x: 56.0252, y: 71.7366 },
  { x: 41.5493, y: 92.3655 },
  { x: 70.7299, y: 92.2041 },
];
const sfaceSize = 112;
const yunetStrides = [8, 16, 32] as const;

const modelError = (action: string) => (cause: unknown) =>
  new FaceModelError({ message: `${action} failed: ${errorMessage(cause)}` });

const clamp = (value: number) => Math.min(Math.max(value, 0), 1);

function intersectionOverUnion(left: DetectedFace["box"], right: DetectedFace["box"]): number {
  const width = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x);
  const height = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y);
  if (width <= 0 || height <= 0) return 0;
  const intersection = width * height;
  return intersection / (left.width * left.height + right.width * right.height - intersection);
}

/**
 * Decode YuNet's per-stride heads (OpenCV `FaceDetectorYNImpl::postProcess`),
 * map them back to image pixels by `scale`, then apply non-maximum suppression.
 */
function decodeDetections(
  outputs: InferenceSession.OnnxValueMapType,
  scale: number,
): DetectedFace[] {
  const { inputSize, scoreThreshold, nmsThreshold } = sfaceConfig.detection;
  const candidates: DetectedFace[] = [];
  for (const stride of yunetStrides) {
    const head = (name: string) => outputs[`${name}_${stride}`]!.data as Float32Array;
    const [cls, obj, bbox, kps] = [head("cls"), head("obj"), head("bbox"), head("kps")];
    const columns = inputSize / stride;
    for (let index = 0; index < cls.length; index++) {
      const score = Math.sqrt(clamp(cls[index]!) * clamp(obj[index]!));
      if (score < scoreThreshold) continue;
      const column = index % columns;
      const row = Math.floor(index / columns);
      const centreX = (column + bbox[index * 4]!) * stride;
      const centreY = (row + bbox[index * 4 + 1]!) * stride;
      const width = Math.exp(bbox[index * 4 + 2]!) * stride;
      const height = Math.exp(bbox[index * 4 + 3]!) * stride;
      const landmark = (n: number): Point => ({
        x: ((kps[index * 10 + 2 * n]! + column) * stride) / scale,
        y: ((kps[index * 10 + 2 * n + 1]! + row) * stride) / scale,
      });
      candidates.push({
        box: {
          x: (centreX - width / 2) / scale,
          y: (centreY - height / 2) / scale,
          width: width / scale,
          height: height / scale,
        },
        landmarks: [landmark(0), landmark(1), landmark(2), landmark(3), landmark(4)],
        score,
      });
    }
  }
  candidates.sort((left, right) => right.score - left.score);
  const kept: DetectedFace[] = [];
  for (const candidate of candidates) {
    if (kept.every((face) => intersectionOverUnion(face.box, candidate.box) <= nmsThreshold)) {
      kept.push(candidate);
    }
  }
  return kept;
}

/**
 * Resize to fit YuNet's square input (never upscaling), pad right and bottom
 * with black, and lay out as a 1×3×H×W BGR float tensor of raw 0–255 values,
 * matching OpenCV's `blobFromImage` defaults.
 */
async function detectorInput(image: RgbImage): Promise<{ tensor: Tensor; scale: number }> {
  const { inputSize } = sfaceConfig.detection;
  const scale = Math.min(1, inputSize / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const resized =
    scale === 1
      ? image.data
      : await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 3 } })
          .resize(width, height, { fit: "fill" })
          .raw()
          .toBuffer();
  const plane = inputSize * inputSize;
  const input = new Float32Array(3 * plane);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = (y * width + x) * 3;
      const offset = y * inputSize + x;
      input[offset] = resized[pixel + 2]!;
      input[plane + offset] = resized[pixel + 1]!;
      input[2 * plane + offset] = resized[pixel]!;
    }
  }
  return {
    tensor: new Tensor("float32", input, [1, 3, inputSize, inputSize]),
    scale: width / image.width,
  };
}

/** Warp a face onto SFace's 112×112 five-point template. */
function alignFace(image: RgbImage, face: DetectedFace): RgbImage {
  return warpAffine(image, estimateSimilarity(face.landmarks, sfaceTemplate), sfaceSize, sfaceSize);
}

/**
 * Lay out an aligned face as a 1×3×112×112 float tensor of raw 0–255 values in
 * **RGB** order. YuNet takes BGR (`detectorInput`) but SFace takes RGB: OpenCV's
 * `FaceRecognizerSF` calls `blobFromImage(..., swapRB=true)` on its BGR image.
 */
function recognizerInput(aligned: RgbImage): Tensor {
  const plane = sfaceSize * sfaceSize;
  const input = new Float32Array(3 * plane);
  for (let offset = 0; offset < plane; offset++) {
    for (let channel = 0; channel < 3; channel++) {
      input[channel * plane + offset] = aligned.data[offset * 3 + channel]!;
    }
  }
  return new Tensor("float32", input, [1, 3, sfaceSize, sfaceSize]);
}

/** Decoded pixels must fill the image exactly; short data would warp to black silently. */
function checkImage({ data, width, height }: RgbImage): void {
  if (data.length !== width * height * 3) {
    throw new Error(
      `expected ${width}×${height}×3 = ${width * height * 3} bytes, got ${data.length}`,
    );
  }
}

export interface OnnxFaceEmbedderOptions {
  dataDirectory: string;
  /**
   * Fetch for missing weights; defaults to the network. Tests pass one that
   * fails with the `models:fetch` fix command instead.
   */
  fetch?: Fetch;
  /** Overrides `sfaceConfig.thresholds`, e.g. while calibrating; validated like it. */
  thresholds?: IdentityThresholds;
}

const openSession = (path: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => {
        // ORT's process-wide environment is created on the first session and logs at its
        // own level, not the session's: on CI VMs it printed a coloured device-discovery
        // warning to stderr ahead of the CLI's JSON error. Errors only, for both.
        env.logLevel = "error";
        // Severity 3 (errors only) hides ORT's harmless initializer warnings for these models.
        return InferenceSession.create(path, { logSeverityLevel: 3 });
      },
      catch: modelError(`Loading ${path}`),
    }),
    (session) => releaseSession(path, () => session.release()),
  );

/**
 * Release a model session. A failure is logged as a warning with its real
 * reason, never raised, so it can't turn a finished run into a defect.
 */
export const releaseSession = (path: string, release: () => Promise<void>) =>
  Effect.tryPromise({ try: release, catch: (error) => error }).pipe(
    Effect.catch((error) =>
      Effect.logWarning(`Releasing the face model ${path} failed: ${errorMessage(error)}`),
    ),
  );

/**
 * YuNet detection, 5-point similarity alignment and SFace embedding in-process
 * via onnxruntime-node (ADR-0003). Weights come only from `ensureModels`, which
 * returns a path only after its SHA-256 matches the lock.
 */
export const OnnxFaceEmbedder = (options: OnnxFaceEmbedderOptions) =>
  Layer.effect(FaceEmbedder)(
    Effect.gen(function* () {
      const thresholds = yield* Schema.decodeUnknownEffect(IdentityThresholds)(
        options.thresholds ?? sfaceConfig.thresholds,
      ).pipe(
        Effect.mapError(
          (error) =>
            new FaceModelError({
              message: `Invalid ${sfaceConfig.model} identity thresholds: ${error.message}`,
            }),
        ),
      );
      const models = yield* Effect.tryPromise({
        try: () =>
          ensureModels({
            lock: readModelLock(),
            directory: modelsDirectory(options.dataDirectory),
            ids: ["yunet", "sface"],
            ...(options.fetch && { fetch: options.fetch }),
          }),
        catch: modelError("Verifying face-model weights"),
      });
      const path = (id: string) => models.find((model) => model.id === id)!.path;
      const detector = yield* openSession(path("yunet"));
      const recognizer = yield* openSession(path("sface"));

      return {
        model: sfaceConfig.model,
        thresholds,
        detect: (image: RgbImage) =>
          Effect.tryPromise({
            try: async () => {
              checkImage(image);
              const { tensor, scale } = await detectorInput(image);
              const outputs = await detector.run({ [detector.inputNames[0]!]: tensor });
              return decodeDetections(outputs, scale);
            },
            catch: modelError("Face detection"),
          }),
        embed: (image: RgbImage, face: DetectedFace) =>
          Effect.tryPromise({
            try: async (): Promise<Embedding> => {
              checkImage(image);
              const input = recognizerInput(alignFace(image, face));
              const outputs = await recognizer.run({ [recognizer.inputNames[0]!]: input });
              return normalize(
                Array.from(outputs[recognizer.outputNames[0]!]!.data as Float32Array),
              );
            },
            catch: modelError("Face embedding"),
          }),
      };
    }),
  );
