import {
  cosineSimilarity,
  type DetectedFace,
  type Embedding,
  type FaceBox,
  type FaceModelError,
  identityAnchor,
  type RgbImage,
} from "@iconograph/domain";
import { Context, Effect, Layer } from "effect";
import { Tensor } from "onnxruntime-node";
import sharp from "sharp";
import { checkImage, modelError, openFacePipeline } from "./face-embedder";
import type { Fetch } from "./models";

/*
 * Held-out face model (ADR-0008). The Optimizer must never see this model, or it
 * would drift towards it as it does towards its own scorer. Isolation is
 * structural: `HeldOutFaceEmbedder` is its own service, not a `FaceEmbedder`,
 * and nothing here is exported from the `@iconograph/adapters` index. This
 * module is also reachable as `@iconograph/adapters/held-out`, for the eval
 * harness, which scores a Run's Candidates after the Run has ended; that
 * subpath resolves from the server too, so lint forbids it there and the
 * server's import-graph test fails on any import of it. Only the
 * `faces:heldout` and `faces:calibrate` commands (`heldout-cli.ts`,
 * `calibrate-cli.ts`) and `bun run eval` use it.
 * `packages/server/test/held-out-isolation.test.ts` checks this.
 */

/** Configuration of the held-out FaceNet backend; its thresholds live here only. */
export const facenetConfig = {
  model: "facenet",
  /** The export's input: 160×160 RGB (scripts/export-facenet.py). */
  inputSize: 160,
  /**
   * Margin around the face, in pixels of the 160×160 crop, as facenet-pytorch's
   * MTCNN `margin` (whose default is 0): the box's longer side fills 128 of the
   * 160 pixels. 32 is our choice, after davidsandberg's LFW validation setting
   * (`--margin 32` at 160), which applies it in source-image pixels instead.
   */
  margin: 32,
  /** Equal error rate of `faces:calibrate` on real anchor pairs (issue #11); ADR-0008 started at 0.70. */
  threshold: 0.52,
} as const;

/** A square in image pixels; it may extend past the image's edges. */
export interface SquareCrop {
  left: number;
  top: number;
  size: number;
}

/**
 * The square crop for a detected face: centred on the box, its side the box's
 * longer side scaled so that `margin` of the `inputSize` output pixels are
 * margin, rounded to whole pixels. Two deliberate deviations from
 * facenet-pytorch's `extract_face`, which adds the margin per axis, clamps the
 * box to the image and resizes that (usually non-square) box to 160×160:
 * - the crop is square, so faces are never stretched; for YuNet's boxes, which
 *   are usually taller than wide, that adds some horizontal context;
 * - it is never clamped: the part outside the image is padded black.
 */
export function squareCrop(box: FaceBox): SquareCrop {
  const { inputSize, margin } = facenetConfig;
  const size = Math.max(
    1,
    Math.round((Math.max(box.width, box.height) * inputSize) / (inputSize - margin)),
  );
  return {
    left: Math.round(box.x + box.width / 2 - size / 2),
    top: Math.round(box.y + box.height / 2 - size / 2),
    size,
  };
}

/**
 * Cut `crop` out of `image` (black outside the image) and resize it to
 * `inputSize`² with bilinear interpolation, like facenet-pytorch's PIL path
 * (not pixel-equal to it).
 */
export async function cropFace(image: RgbImage, crop: SquareCrop): Promise<RgbImage> {
  const { left, top, size } = crop;
  const square = new Uint8Array(size * size * 3);
  const fromX = Math.max(left, 0);
  const toX = Math.min(left + size, image.width);
  if (toX <= fromX || top >= image.height || top + size <= 0) {
    throw new Error("The face crop lies outside the image");
  }
  for (let y = Math.max(top, 0); y < Math.min(top + size, image.height); y++) {
    const row = image.data.subarray((y * image.width + fromX) * 3, (y * image.width + toX) * 3);
    square.set(row, ((y - top) * size + (fromX - left)) * 3);
  }
  const { inputSize } = facenetConfig;
  const data = await sharp(square, { raw: { width: size, height: size, channels: 3 } })
    .resize(inputSize, inputSize, { kernel: "linear" })
    .raw()
    .toBuffer();
  return { data, width: inputSize, height: inputSize };
}

/**
 * Lay out a 160×160 crop as the export's input: a 1×3×160×160 float tensor in
 * RGB order, each value normalised as (x − 127.5) / 128 (facenet-pytorch's
 * `fixed_image_standardization`).
 */
export function facenetInput(crop: RgbImage): Tensor {
  const { inputSize } = facenetConfig;
  const plane = inputSize * inputSize;
  if (crop.width !== inputSize || crop.height !== inputSize || crop.data.length !== plane * 3) {
    throw new Error(`expected a ${inputSize}×${inputSize} RGB crop`);
  }
  const input = new Float32Array(3 * plane);
  for (let offset = 0; offset < plane; offset++) {
    for (let channel = 0; channel < 3; channel++) {
      input[channel * plane + offset] = (crop.data[offset * 3 + channel]! - 127.5) / 128;
    }
  }
  return new Tensor("float32", input, [1, 3, inputSize, inputSize]);
}

/**
 * The held-out face model behind its own seam, deliberately not a
 * `FaceEmbedder` (see the isolation note at the top of this file).
 */
export class HeldOutFaceEmbedder extends Context.Service<
  HeldOutFaceEmbedder,
  {
    /** The held-out model's id, `facenet`. */
    readonly model: string;
    /** Minimum cosine similarity to the held-out anchor that confirms identity. */
    readonly threshold: number;
    /** YuNet, as in the SFace pipeline: every face found, highest score first. */
    readonly detect: (image: RgbImage) => Effect.Effect<readonly DetectedFace[], FaceModelError>;
    /** The L2-normalised 512-d FaceNet embedding of one detected face. */
    readonly embed: (
      image: RgbImage,
      face: DetectedFace,
    ) => Effect.Effect<Embedding, FaceModelError>;
  }
>()("@iconograph/adapters/HeldOutFaceEmbedder") {}

export interface OnnxHeldOutFaceEmbedderOptions {
  dataDirectory: string;
  /** Fetch for missing weights; defaults to the network. */
  fetch?: Fetch;
}

/** YuNet detection, square margin crop and FaceNet embedding in-process via onnxruntime-node. */
export const OnnxHeldOutFaceEmbedder = (options: OnnxHeldOutFaceEmbedderOptions) =>
  Layer.effect(HeldOutFaceEmbedder)(
    Effect.gen(function* () {
      const { detect, recognize } = yield* openFacePipeline(options, facenetConfig.model);
      return {
        model: facenetConfig.model,
        threshold: facenetConfig.threshold,
        detect,
        embed: (image: RgbImage, face: DetectedFace) =>
          Effect.tryPromise({
            try: async () => {
              checkImage(image);
              return recognize(facenetInput(await cropFace(image, squareCrop(face.box))));
            },
            catch: modelError("Held-out face embedding"),
          }),
      };
    }),
  );

export interface HeldOutScore {
  /** Cosine similarity of the candidate to each reference, in reference order. */
  similarities: number[];
  /** Cosine similarity of the candidate to the held-out anchor of the references. */
  anchorSimilarity: number;
  pass: boolean;
}

/**
 * Score a candidate embedding against reference embeddings: per reference, and
 * against their held-out anchor (normalised mean, as the Identity Anchor). It
 * passes when the anchor similarity reaches `threshold`.
 */
export function scoreHeldOut(
  candidate: Embedding,
  references: readonly Embedding[],
  threshold: number,
): HeldOutScore {
  const anchorSimilarity = cosineSimilarity(candidate, identityAnchor(references));
  return {
    similarities: references.map((reference) => cosineSimilarity(candidate, reference)),
    anchorSimilarity,
    pass: anchorSimilarity >= threshold,
  };
}
