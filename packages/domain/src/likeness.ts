import { Schema } from "effect";
import type { Embedding } from "./face";
import { cosineSimilarity } from "./identity";

/** Likeness runs from 0 at the Identity Gate to 10 at the Identity Ceiling. */
export const MAX_LIKENESS = 10;

export interface LikenessScale {
  /** The face model's Identity Gate (cosine similarity). */
  gate: number;
  /** The Run's Identity Ceiling (cosine similarity). */
  ceiling: number;
}

/**
 * A Candidate's Likeness: its cosine similarity to the Identity Anchor, scaled
 * linearly from the Gate (0) to the Ceiling (10) and clamped to [0, 10].
 *
 * When the Ceiling is at or below the Gate (the accepted photos barely agree,
 * reported as `ceiling-below-gate`), there is no range to scale over: anything
 * that reaches the Gate already matches the Subject as well as their own photos
 * match each other, so it scores 10, and anything below scores 0.
 */
export function likeness(similarity: number, { gate, ceiling }: LikenessScale): number {
  if (ceiling <= gate) return similarity >= gate ? MAX_LIKENESS : 0;
  const scaled = ((similarity - gate) / (ceiling - gate)) * MAX_LIKENESS;
  return Math.min(MAX_LIKENESS, Math.max(0, scaled));
}

const Likeness = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: MAX_LIKENESS }));
const Similarity = Schema.Finite.check(Schema.isBetween({ minimum: -1, maximum: 1 }));

/**
 * How a Candidate ended (GLOSSARY "Candidate Outcome"). Until the Judge exists,
 * `Scored` means the Candidate passed the Identity Gate and has a Likeness.
 * `similarity` is the raw cosine similarity to the Identity Anchor; Likeness is
 * that similarity scaled to 0–10.
 */
export const CandidateOutcome = Schema.Union([
  /** The Image Model declined; `reason` is the vendor's. */
  Schema.TaggedStruct("Refused", { reason: Schema.String }),
  /**
   * The Candidate couldn't be produced or scored: the call errored after any
   * retries, a retry didn't fit the Budget, or the response or image was unusable.
   */
  Schema.TaggedStruct("Failed", { reason: Schema.String }),
  /** No face, or the best face is below the Identity Gate; never judged. */
  Schema.TaggedStruct("Gated", {
    reason: Schema.Literals(["no-face", "below-gate"]),
    /** The best face's similarity to the Identity Anchor; null when there is no face. */
    similarity: Schema.NullOr(Similarity),
  }),
  Schema.TaggedStruct("Scored", { similarity: Similarity, likeness: Likeness }),
]);
export type CandidateOutcome = typeof CandidateOutcome.Type;

/**
 * Score a generated Candidate from the embeddings of every face found in it.
 * With several faces, the one most similar to the Identity Anchor counts: a
 * Candidate showing the Subject beside someone else isn't Gated for it (the
 * Judge, later, scores the composition). An embedding that can't be compared
 * (zero or non-finite) fails this Candidate, not the Run.
 */
export function scoreCandidate(
  faces: readonly Embedding[],
  anchor: Embedding,
  scale: LikenessScale,
): CandidateOutcome {
  if (faces.length === 0) return { _tag: "Gated", reason: "no-face", similarity: null };
  let similarities: number[];
  try {
    similarities = faces.map((face) => cosineSimilarity(face, anchor));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { _tag: "Failed", reason: `A face in the Candidate couldn't be compared: ${reason}` };
  }
  // Clamped: rounding can put the cosine of identical unit vectors a hair above 1.
  const similarity = Math.min(1, Math.max(...similarities));
  if (similarity < scale.gate) return { _tag: "Gated", reason: "below-gate", similarity };
  return { _tag: "Scored", similarity, likeness: likeness(similarity, scale) };
}
