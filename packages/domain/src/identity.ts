import { Schema } from "effect";
import type { DetectedFace, Embedding, IdentityThresholds } from "./face";

/** A Run takes 1 to 8 Reference Photos (GLOSSARY). */
export const MAX_REFERENCE_PHOTOS = 8;

/** Below this many accepted Reference Photos, Likeness is less reliable (issue #1, user story 14). */
export const RECOMMENDED_REFERENCE_PHOTOS = 3;

export function normalize(vector: readonly number[]): number[] {
  const norm = Math.hypot(...vector);
  if (!vector.every(Number.isFinite) || !(norm > 0)) {
    throw new Error("Cannot normalise a zero or non-finite vector");
  }
  return vector.map((value) => value / norm);
}

/** Cosine similarity; both inputs are normalised first. */
export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) throw new Error("Embeddings differ in length");
  const a = normalize(left);
  const b = normalize(right);
  return a.reduce((sum, value, index) => sum + value * b[index]!, 0);
}

/** The Identity Anchor: the normalised mean of the normalised embeddings. */
export function identityAnchor(embeddings: readonly Embedding[]): Embedding {
  const [first] = embeddings;
  if (!first) throw new Error("An Identity Anchor needs at least one embedding");
  const sum = Array.from({ length: first.length }, () => 0);
  for (const embedding of embeddings) {
    if (embedding.length !== first.length) throw new Error("Embeddings differ in length");
    normalize(embedding).forEach((value, index) => (sum[index]! += value));
  }
  return normalize(sum);
}

/** The middle value, or the mean of the two middle values; `values` must not be empty. */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export const IdentityCeiling = Schema.Struct({
  value: Schema.Finite,
  source: Schema.Literals(["median-pairwise", "single-photo-default"]),
});
export type IdentityCeiling = typeof IdentityCeiling.Type;

/**
 * Cosine similarity of `embedding` to the Identity Anchor of `references`: a
 * Candidate's Likeness, or a Reference Photo against the others' anchor.
 */
export function anchorSimilarity(embedding: Embedding, references: readonly Embedding[]): number {
  return cosineSimilarity(embedding, identityAnchor(references));
}

/** Cosine similarity of every pair of `embeddings` (i < j, in order). */
export function pairwiseSimilarities(embeddings: readonly Embedding[]): number[] {
  const pairs: number[] = [];
  for (let i = 0; i < embeddings.length; i++) {
    for (let j = i + 1; j < embeddings.length; j++) {
      pairs.push(cosineSimilarity(embeddings[i]!, embeddings[j]!));
    }
  }
  return pairs;
}

/**
 * The Identity Ceiling: the median pairwise similarity among the accepted
 * photos, or the face model's default when only one photo is accepted.
 */
export function identityCeiling(
  embeddings: readonly Embedding[],
  thresholds: IdentityThresholds,
): IdentityCeiling {
  if (embeddings.length === 0) throw new Error("An Identity Ceiling needs at least one embedding");
  if (embeddings.length === 1) {
    return { value: thresholds.singlePhotoCeiling, source: "single-photo-default" };
  }
  return { value: median(pairwiseSimilarities(embeddings)), source: "median-pairwise" };
}

/** What the face model found in one Reference Photo, after any operator face choice. */
export type PhotoFaces =
  | { kind: "no-face" }
  | { kind: "several-faces"; faces: readonly DetectedFace[] }
  | { kind: "face"; face: DetectedFace; embedding: Embedding };

/**
 * What a photo's `similarity` was measured against: `accepted-anchor` is the
 * Identity Anchor of the other accepted photos; `best-photo` is the best match
 * to any single other photo with a face, used only when nothing was accepted.
 */
export const SimilarityBasis = Schema.Literals(["accepted-anchor", "best-photo"]);
export type SimilarityBasis = typeof SimilarityBasis.Type;

/** The fields of an accepted photo compared with the other accepted photos. */
export const comparedSimilarity = {
  similarity: Schema.Finite,
  similarityTo: Schema.Literal("accepted-anchor"),
};
/** The fields of an accepted photo that is the only one: nothing to compare with. */
export const aloneSimilarity = { similarity: Schema.Null, similarityTo: Schema.Null };

/** An accepted photo's similarity to the others, or none when it is the only one. */
export const AcceptedSimilarity = Schema.Union([
  Schema.Struct(comparedSimilarity),
  Schema.Struct(aloneSimilarity),
]);
export type AcceptedSimilarity = typeof AcceptedSimilarity.Type;

export type PhotoVerdict =
  | { verdict: "rejected"; reason: "no-face" }
  | { verdict: "choice-required"; faces: readonly DetectedFace[] }
  | ({ verdict: "accepted"; face: DetectedFace } & AcceptedSimilarity)
  /**
   * `similarity` is against the anchor of the accepted photos. When none was
   * accepted, it is the photo's best similarity to any single other photo with
   * a face (for two photos, their similarity to each other); no pair reached
   * the Gate, so it is always below it. `similarityTo` says which.
   */
  | {
      verdict: "flagged";
      reason: "not-the-same-person";
      face: DetectedFace;
      similarity: number;
      similarityTo: SimilarityBasis;
    };

/** Consumers branch on `code`; `message` is for people and may change. */
export const ReferencePhotoWarning = Schema.Struct({
  code: Schema.Literals(["few-photos", "none-accepted", "ceiling-below-gate"]),
  message: Schema.String,
});
export type ReferencePhotoWarning = typeof ReferencePhotoWarning.Type;
export type ReferencePhotoWarningCode = ReferencePhotoWarning["code"];

export interface ReferencePhotoAssessment {
  /** One verdict per input photo, in input order. */
  photos: PhotoVerdict[];
  /** Absent when no photo was accepted. */
  identity?: { anchor: Embedding; ceiling: IdentityCeiling; accepted: number[] };
  warnings: ReferencePhotoWarning[];
}

/**
 * Judge each photo with one face "against the others": its similarity to the
 * Identity Anchor of the other accepted photos (leave-one-out), so an outlier
 * can't pull the anchor towards itself.
 *
 * Repeated until nothing changes:
 * 1. Flag the lowest accepted photo below the Identity Gate and leave it out,
 *    so one outlier can't drag the others below the Gate. When only two photos
 *    remain and they disagree, neither can be singled out, so both are flagged.
 * 2. Otherwise re-admit the flagged photo most similar to the anchor of the
 *    accepted ones, if it now reaches the Gate (an earlier outlier may have
 *    pulled it down when it was flagged).
 * 3. If nothing is accepted, re-admit the most similar flagged pair that
 *    reaches the Gate, so an agreeing pair isn't lost to flagging order.
 *
 * A re-admitted photo is never flagged again, so each photo changes state at
 * most twice and the loop ends. Accepted and flagged similarities are against
 * the final anchor of the other accepted photos; see `PhotoVerdict` for the
 * case where nothing is accepted.
 *
 * A warning is added when the median-pairwise Identity Ceiling lies below the
 * Gate: every photo passed against the others' anchor, but the photos barely
 * agree with each other. The Ceiling is reported as measured, not clamped
 * (issue #1 defines it as the median pairwise similarity).
 */
export function assessReferencePhotos(
  photos: readonly PhotoFaces[],
  thresholds: IdentityThresholds,
): ReferencePhotoAssessment {
  const { identityGate } = thresholds;
  const embeddings = new Map(
    photos.flatMap((photo, index) =>
      photo.kind === "face" ? [[index, photo.embedding] as const] : [],
    ),
  );
  const embeddingOf = (index: number) => embeddings.get(index)!;
  const candidates = new Set(embeddings.keys());
  const flagged = new Set<number>();
  const readmitted = new Set<number>();
  /** Similarity of `index` to the anchor of the other accepted photos. */
  const againstOthers = (index: number) =>
    anchorSimilarity(
      embeddingOf(index),
      [...candidates].filter((other) => other !== index).map(embeddingOf),
    );
  /** Similarity of two photos to each other. */
  const pairSimilarity = (first: number, second: number) =>
    cosineSimilarity(embeddingOf(first), embeddingOf(second));

  for (;;) {
    if (candidates.size >= 2) {
      const below = [...candidates]
        .filter((index) => !readmitted.has(index))
        .map((index) => ({ index, similarity: againstOthers(index) }))
        .filter(({ similarity }) => similarity < identityGate)
        .sort((a, b) => a.similarity - b.similarity);
      if (below.length > 0) {
        for (const { index } of candidates.size === 2 ? below : below.slice(0, 1)) {
          candidates.delete(index);
          flagged.add(index);
        }
        continue;
      }
    }
    // Re-admit the flagged photo most similar to the accepted ones or, with
    // nothing accepted, the most similar flagged pair, if it reaches the Gate.
    const options =
      candidates.size === 0
        ? [...flagged].flatMap((first) =>
            [...flagged]
              .filter((second) => second > first)
              .map((second) => ({
                indices: [first, second],
                similarity: pairSimilarity(first, second),
              })),
          )
        : [...flagged].map((index) => ({ indices: [index], similarity: againstOthers(index) }));
    const [best] = options
      .filter(({ similarity }) => similarity >= identityGate)
      .sort((a, b) => b.similarity - a.similarity);
    if (!best) break;
    for (const index of best.indices) {
      flagged.delete(index);
      readmitted.add(index);
      candidates.add(index);
    }
  }

  const accepted = [...embeddings.keys()].filter((index) => candidates.has(index));
  // With nothing accepted, every photo with a face is flagged: report the best
  // match to any one other photo, which stays below the Gate (no pair reached it).
  const flaggedSimilarity = (index: number) => {
    if (candidates.size > 0) return againstOthers(index);
    const others = [...flagged].filter((other) => other !== index);
    return Math.max(...others.map((other) => pairSimilarity(index, other)));
  };
  const verdicts = photos.map((photo, index): PhotoVerdict => {
    if (photo.kind === "no-face") return { verdict: "rejected", reason: "no-face" };
    if (photo.kind === "several-faces") return { verdict: "choice-required", faces: photo.faces };
    if (flagged.has(index)) {
      return {
        verdict: "flagged",
        reason: "not-the-same-person",
        face: photo.face,
        similarity: flaggedSimilarity(index),
        similarityTo: candidates.size > 0 ? "accepted-anchor" : "best-photo",
      };
    }
    const similarity: AcceptedSimilarity =
      accepted.length > 1
        ? { similarity: againstOthers(index), similarityTo: "accepted-anchor" }
        : { similarity: null, similarityTo: null };
    return { verdict: "accepted", face: photo.face, ...similarity };
  });

  const warnings: ReferencePhotoWarning[] = [];
  if (accepted.length === 0) {
    warnings.push({
      code: "none-accepted",
      message: "No Reference Photo was accepted, so there is no Identity Anchor",
    });
  } else if (accepted.length < RECOMMENDED_REFERENCE_PHOTOS) {
    warnings.push({
      code: "few-photos",
      message: `Only ${accepted.length} accepted Reference Photo${accepted.length === 1 ? "" : "s"}; Likeness is less reliable below ${RECOMMENDED_REFERENCE_PHOTOS}`,
    });
  }
  const acceptedEmbeddings = accepted.map(embeddingOf);
  const identity =
    accepted.length > 0
      ? {
          anchor: identityAnchor(acceptedEmbeddings),
          ceiling: identityCeiling(acceptedEmbeddings, thresholds),
          accepted,
        }
      : undefined;
  if (identity && identity.ceiling.value < identityGate) {
    warnings.push({
      code: "ceiling-below-gate",
      message:
        "Identity Ceiling below the Identity Gate: the accepted photos barely agree with each other",
    });
  }
  return { photos: verdicts, ...(identity && { identity }), warnings };
}
