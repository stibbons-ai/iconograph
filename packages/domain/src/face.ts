import { Context, Data, Effect, Schema } from "effect";

export const Point = Schema.Struct({ x: Schema.Finite, y: Schema.Finite });

export const FaceBox = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
});

/**
 * One detected face in image pixel coordinates. Landmarks are, in image order:
 * right eye, left eye, nose tip, right mouth corner, left mouth corner (the
 * subject's right is the viewer's left).
 */
export const DetectedFace = Schema.Struct({
  box: FaceBox,
  landmarks: Schema.Tuple([Point, Point, Point, Point, Point]),
  score: Schema.Finite,
});

/** A cosine similarity, which can only lie in [-1, 1]. */
const Similarity = Schema.Finite.check(Schema.isBetween({ minimum: -1, maximum: 1 }));

/**
 * Per-face-model identity configuration (ADR-0002): thresholds differ per model
 * and are never hard-coded outside this config. Backends decode their config
 * through this schema when they start. Likeness scales from the Gate (0) to the
 * Ceiling (10), so the single-photo Ceiling may not lie below the Gate.
 */
export const IdentityThresholds = Schema.Struct({
  /** Minimum cosine similarity to count as the same person (the Identity Gate). */
  identityGate: Similarity,
  /** Identity Ceiling used when only one Reference Photo is accepted. */
  singlePhotoCeiling: Similarity,
}).check(
  Schema.makeFilter(({ identityGate, singlePhotoCeiling }) =>
    singlePhotoCeiling >= identityGate ? true : "singlePhotoCeiling must be at least identityGate",
  ),
);

export type Point = typeof Point.Type;
export type FaceBox = typeof FaceBox.Type;
export type DetectedFace = typeof DetectedFace.Type;
export type IdentityThresholds = typeof IdentityThresholds.Type;
/** An L2-normalised face embedding. */
export type Embedding = readonly number[];

/** Interleaved 8-bit RGB pixels, row-major, `width * height * 3` bytes. */
export interface RgbImage {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** The face model failed to load or run; `photo` names the photo it was running on, if any. */
export class FaceModelError extends Data.TaggedError("FaceModelError")<{
  message: string;
  photo?: string;
}> {}

/**
 * Face detection and recognition behind one seam (ADR-0003), so another backend
 * can replace the default without touching the domain.
 */
export class FaceEmbedder extends Context.Service<
  FaceEmbedder,
  {
    /** The face model's id, e.g. `sface`. */
    readonly model: string;
    /** That model's Identity Gate and single-photo Identity Ceiling. */
    readonly thresholds: IdentityThresholds;
    /**
     * Every face found, highest score first. Operators choose faces by this
     * order (numbered from 1), so it must be stable for a given image.
     */
    readonly detect: (image: RgbImage) => Effect.Effect<readonly DetectedFace[], FaceModelError>;
    /** The L2-normalised embedding of one detected face. */
    readonly embed: (
      image: RgbImage,
      face: DetectedFace,
    ) => Effect.Effect<Embedding, FaceModelError>;
  }
>()("@iconograph/domain/FaceEmbedder") {}
