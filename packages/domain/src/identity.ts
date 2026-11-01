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

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export interface IdentityCeiling {
  value: number;
  source: "median-pairwise" | "single-photo-default";
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
  const pairs: number[] = [];
  for (let i = 0; i < embeddings.length; i++) {
    for (let j = i + 1; j < embeddings.length; j++) {
      pairs.push(cosineSimilarity(embeddings[i]!, embeddings[j]!));
    }
  }
  return { value: median(pairs), source: "median-pairwise" };
}

/** What the face model found in one Reference Photo, after any operator face choice. */
export type PhotoFaces =
  | { kind: "no-face" }
  | { kind: "several-faces"; faces: readonly DetectedFace[] }
  | { kind: "face"; face: DetectedFace; embedding: Embedding };

export type PhotoVerdict =
  | { verdict: "rejected"; reason: "no-face" }
  | { verdict: "choice-required"; faces: readonly DetectedFace[] }
  /** `similarity` is null when no other photo was accepted to compare against. */
  | { verdict: "accepted"; face: DetectedFace; similarity: number | null }
  /**
   * `similarity` is against the anchor of the accepted photos. When none was
   * accepted, it is the photo's best similarity to any single other photo with
   * a face (for two photos, their similarity to each other); no pair reached
   * the Gate, so it is always below it.
   */
  | { verdict: "flagged"; reason: "not-the-same-person"; face: DetectedFace; similarity: number };

export interface ReferencePhotoAssessment {
  /** One verdict per input photo, in input order. */
  photos: PhotoVerdict[];
  /** Absent when no photo was accepted. */
  identity?: { anchor: Embedding; ceiling: IdentityCeiling; accepted: number[] };
  warnings: string[];
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
    cosineSimilarity(
      embeddingOf(index),
      identityAnchor([...candidates].filter((other) => other !== index).map(embeddingOf)),
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
      };
    }
    return {
      verdict: "accepted",
      face: photo.face,
      similarity: accepted.length > 1 ? againstOthers(index) : null,
    };
  });

  const warnings: string[] = [];
  if (accepted.length === 0) {
    warnings.push("No Reference Photo was accepted, so there is no Identity Anchor");
  } else if (accepted.length < RECOMMENDED_REFERENCE_PHOTOS) {
    warnings.push(
      `Only ${accepted.length} accepted Reference Photo${accepted.length === 1 ? "" : "s"}; Likeness is less reliable below ${RECOMMENDED_REFERENCE_PHOTOS}`,
    );
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
    warnings.push(
      "Identity Ceiling below the Identity Gate: the accepted photos barely agree with each other",
    );
  }
  return { photos: verdicts, ...(identity && { identity }), warnings };
}
