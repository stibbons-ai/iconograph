import type { Embedding, IdentityThresholds } from "./face";
import {
  anchorSimilarity,
  cosineSimilarity,
  identityAnchor,
  MAX_REFERENCE_PHOTOS,
  median,
  pairwiseSimilarities,
} from "./identity";

/*
 * Pure statistics behind `faces:calibrate` (issue #11): pair similarities of
 * labelled photos, their distributions, false accept and false reject rates at
 * candidate thresholds, and the rules that suggest an Identity Gate, a held-out
 * threshold and a single-photo Identity Ceiling.
 */

/** The suggestion rules, stated in the calibration report. */
export const calibrationRules = {
  threshold:
    "On realAnchor and candidateAnchor: the lowest threshold on a 0.01 grid from -1 to 1 whose false accept rate on different-person pairs is at most the target FAR (a pair is accepted when its similarity is at least the threshold).",
  identityGateAndHeldOutThreshold:
    "Both thresholds are applied to similarity against an Identity Anchor, so take the SFace Identity Gate and the FaceNet threshold from realAnchor (each real photo against the anchor of its Subject's other photos, or of another Subject's photos), and from candidateAnchor when labelled Candidates exist; weigh both. Anchors use every photo with one face, uncapped and without Gate flagging, unlike a Run.",
  equalErrorRate:
    "On realAnchor and candidateAnchor: the thresholds on a 0.01 grid from -1 to 1 where |FAR - FRR| is smallest; the middle one of them (the lower middle for an even count) is reported.",
  singlePhotoCeiling:
    "The median of the per-Subject Identity Ceilings (each the median similarity of that Subject's real-photo pairs, over Subjects with 2 or more photos); pooledMedian, the median of all same-person real-photo pairs, is reported beside it.",
  contextSets:
    "real (photo against photo) and candidatePhoto (Candidate against each photo) are context: distributions, FAR/FRR rates and sample-size warnings only, no suggestion. The thresholds are applied to anchor similarity; the one exception is the Identity Gate when a Run accepts no Reference Photo, where the most similar pair of flagged photos is re-admitted by their pairwise similarity.",
  quantiles: "Linear interpolation between order statistics (as numpy's default).",
} as const;

/** Thresholds of the FAR/FRR table, besides the configured values. */
export const CANDIDATE_THRESHOLDS: readonly number[] = Array.from(
  { length: 15 },
  (_, step) => (20 + 5 * step) / 100,
);

/** Fewer pairs than this on either side of a pair set gets a warning. */
const MINIMUM_PAIRS = 30;

/** The p-quantile of non-empty ascending `sorted`, interpolating linearly between order statistics. */
function quantileOfSorted(sorted: readonly number[], p: number): number {
  const position = (sorted.length - 1) * p;
  const below = Math.floor(position);
  const above = Math.min(below + 1, sorted.length - 1);
  return sorted[below]! + (sorted[above]! - sorted[below]!) * (position - below);
}

/** The p-quantile (0 ≤ p ≤ 1) of `values`, interpolating linearly between order statistics. */
export function quantile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new Error("A quantile needs at least one value");
  if (!(p >= 0 && p <= 1)) throw new Error(`A quantile's p must lie in [0, 1], got ${p}`);
  return quantileOfSorted(
    [...values].sort((a, b) => a - b),
    p,
  );
}

export interface Distribution {
  count: number;
  min: number;
  p05: number;
  p25: number;
  median: number;
  p75: number;
  p95: number;
  max: number;
}

/** Count, extremes and quantiles of `values`; null when there are none. */
export function distribution(values: readonly number[]): Distribution | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted[0]!,
    p05: quantileOfSorted(sorted, 0.05),
    p25: quantileOfSorted(sorted, 0.25),
    // As the Identity Ceiling computes it, so ceiling.pooledMedian equals real.same.median exactly.
    median: median(sorted),
    p75: quantileOfSorted(sorted, 0.75),
    p95: quantileOfSorted(sorted, 0.95),
    max: sorted.at(-1)!,
  };
}

/** Similarities of same-person and different-person pairs. */
export interface PairSet {
  same: number[];
  different: number[];
}

export interface ErrorRates {
  threshold: number;
  /** Share of different-person pairs at or above the threshold; null without any. */
  far: number | null;
  /** Share of same-person pairs below the threshold; null without any. */
  frr: number | null;
}

/** FAR and FRR at `threshold`, where a pair counts as the same person when its similarity reaches it. */
export function errorRates({ same, different }: PairSet, threshold: number): ErrorRates {
  const share = (values: readonly number[], counts: (value: number) => boolean) =>
    values.length === 0 ? null : values.filter(counts).length / values.length;
  return {
    threshold,
    far: share(different, (value) => value >= threshold),
    frr: share(same, (value) => value < threshold),
  };
}

/** The 0.01 grid from -1 to 1, in hundredths so that no step accumulates rounding. */
const grid = Array.from({ length: 201 }, (_, step) => (step - 100) / 100);

/**
 * The lowest grid threshold whose FAR is at most `targetFar` (see
 * `calibrationRules.threshold`), with its rates; null when even 1 accepts too
 * many different-person pairs (identical faces score 1).
 */
export function suggestThreshold(pairs: PairSet, targetFar: number): ErrorRates | null {
  if (pairs.different.length === 0) {
    throw new Error("A threshold suggestion needs different-person pairs");
  }
  if (!(targetFar >= 0 && targetFar < 1)) {
    throw new Error(`The target FAR must lie in [0, 1), got ${targetFar}`);
  }
  // The epsilon absorbs float error in the product: 0.29 × 100 is 28.999…, which must allow 29.
  const allowed = Math.floor(targetFar * pairs.different.length + 1e-9);
  for (const threshold of grid) {
    const accepted = pairs.different.filter((value) => value >= threshold).length;
    if (accepted <= allowed) return errorRates(pairs, threshold);
  }
  return null;
}

/** The equal error rate point (see `calibrationRules.equalErrorRate`); null unless both sides have pairs. */
export function equalErrorRate(pairs: PairSet): ErrorRates | null {
  if (pairs.same.length === 0 || pairs.different.length === 0) return null;
  const rates = grid.map((threshold) => errorRates(pairs, threshold));
  const gap = ({ far, frr }: ErrorRates) => Math.abs(far! - frr!);
  const smallest = Math.min(...rates.map(gap));
  const closest = rates.filter((rate) => gap(rate) <= smallest + 1e-12);
  return closest[(closest.length - 1) >> 1]!;
}

export interface PairSetAnalysis {
  same: Distribution | null;
  different: Distribution | null;
  /** At `CANDIDATE_THRESHOLDS` and the configured values, ascending. */
  rates: ErrorRates[];
  /**
   * Only on the sets thresholds are taken from (`suggest`); absent there too
   * when there are no different-person pairs, null when no threshold reaches
   * the target.
   */
  suggestion?: ErrorRates | null;
  /** Only on the sets thresholds are taken from (`suggest`). */
  equalErrorRate?: ErrorRates | null;
  warnings: string[];
}

/**
 * Everything the report gives per pair set and face model. With `suggest`
 * false (context sets), no suggestion, equal error rate or warnings about
 * them.
 */
export function analysePairSet(
  pairs: PairSet,
  options: { targetFar: number; configured: readonly number[]; suggest: boolean },
): PairSetAnalysis {
  const { targetFar, configured, suggest } = options;
  const thresholds = [...new Set([...CANDIDATE_THRESHOLDS, ...configured])].sort((a, b) => a - b);
  const warnings: string[] = [];
  for (const [side, values] of [
    ["same-person", pairs.same],
    ["different-person", pairs.different],
  ] as const) {
    if (values.length < MINIMUM_PAIRS) {
      warnings.push(`Only ${values.length} ${side} pairs (fewer than ${MINIMUM_PAIRS})`);
    }
  }
  // Warnings go last, after the fields they explain.
  const analysis: Omit<PairSetAnalysis, "warnings"> = {
    same: distribution(pairs.same),
    different: distribution(pairs.different),
    rates: thresholds.map((threshold) => errorRates(pairs, threshold)),
  };
  if (!suggest) return { ...analysis, warnings };
  // A target FAR is only resolved by at least 1/target different-person pairs.
  const resolvable = Math.ceil(1 / targetFar);
  if (targetFar > 0 && pairs.different.length > 0 && pairs.different.length < resolvable) {
    warnings.push(
      `Only ${pairs.different.length} different-person pairs: a FAR of ${targetFar} needs at least ${resolvable} to be resolved`,
    );
  }
  if (pairs.different.length > 0) {
    analysis.suggestion = suggestThreshold(pairs, targetFar);
    if (analysis.suggestion === null) {
      warnings.push(`No threshold up to 1 reaches the target FAR of ${targetFar}`);
    }
  }
  analysis.equalErrorRate = equalErrorRate(pairs);
  return { ...analysis, warnings };
}

/** One Subject's embeddings from one face model. */
export interface CalibrationSubject {
  name: string;
  /** Real photos of the Subject. */
  photos: readonly Embedding[];
  /** Generated Candidates a person judged to show the Subject. */
  like: readonly Embedding[];
  /** Generated Candidates a person judged not to show the Subject. */
  unlike: readonly Embedding[];
}

export interface CalibrationPairs {
  /**
   * Each real photo against the leave-one-out anchor of its own Subject's other
   * photos (same-person; Subjects with 2 or more photos), and against each
   * other Subject's anchor (different-person). Values that are the same pair
   * twice are counted once: a 2-photo Subject's two leave-one-out values, and
   * two 1-photo Subjects against each other's anchor.
   */
  realAnchor: PairSet;
  /** Each Candidate against the Identity Anchor of its Subject's real photos; `like` is same-person. */
  candidateAnchor: PairSet;
  /** Real photos: pairs within a Subject are same-person, across Subjects different-person. */
  real: PairSet;
  /** Each Candidate against each real photo of its Subject. */
  candidatePhoto: PairSet;
}

/**
 * Calibration needs real photos of at least 2 Subjects (for different-person
 * pairs), and at least one Subject with 2 (for same-person pairs).
 */
export function checkCalibrationSubjects(subjects: readonly { photos: readonly unknown[] }[]) {
  const withPhotos = subjects.filter(({ photos }) => photos.length > 0);
  if (withPhotos.length < 2) {
    throw new Error(
      `Calibration needs real photos of at least 2 Subjects (one folder each), got ${withPhotos.length}`,
    );
  }
  if (!subjects.some(({ photos }) => photos.length >= 2)) {
    throw new Error(
      "Calibration needs at least 2 real photos of one Subject for same-person pairs",
    );
  }
}

/** All labelled pairs of `subjects` and their cosine similarities; see `checkCalibrationSubjects`. */
export function calibrationPairs(subjects: readonly CalibrationSubject[]): CalibrationPairs {
  checkCalibrationSubjects(subjects);
  const real: PairSet = { same: [], different: [] };
  const realAnchor: PairSet = { same: [], different: [] };
  const candidatePhoto: PairSet = { same: [], different: [] };
  const candidateAnchor: PairSet = { same: [], different: [] };
  const anchors = subjects.map(({ photos }) => (photos.length > 0 ? identityAnchor(photos) : null));
  for (const [index, subject] of subjects.entries()) {
    real.same.push(...pairwiseSimilarities(subject.photos));
    for (const [position, photo] of subject.photos.entries()) {
      for (const otherSubject of subjects.slice(index + 1)) {
        for (const other of otherSubject.photos) {
          real.different.push(cosineSimilarity(photo, other));
        }
      }
      // With 2 photos, each one's leave-one-out anchor is the other photo: one pair.
      const twoPhotoRepeat = subject.photos.length === 2 && position === 1;
      if (subject.photos.length >= 2 && !twoPhotoRepeat) {
        realAnchor.same.push(
          anchorSimilarity(
            photo,
            subject.photos.filter((_, other) => other !== position),
          ),
        );
      }
      for (const [other, anchor] of anchors.entries()) {
        // Two 1-photo Subjects against each other's anchor are one pair, counted from the first.
        const onePhotoRepeat =
          subject.photos.length === 1 && subjects[other]!.photos.length === 1 && other < index;
        if (other !== index && anchor && !onePhotoRepeat) {
          realAnchor.different.push(cosineSimilarity(photo, anchor));
        }
      }
    }
    const anchor = anchors[index];
    if (!anchor) continue;
    for (const [candidates, side] of [
      [subject.like, "same"],
      [subject.unlike, "different"],
    ] as const) {
      for (const candidate of candidates) {
        for (const photo of subject.photos) {
          candidatePhoto[side].push(cosineSimilarity(candidate, photo));
        }
        candidateAnchor[side].push(cosineSimilarity(candidate, anchor));
      }
    }
  }
  return { realAnchor, candidateAnchor, real, candidatePhoto };
}

/** See `calibrationRules.singlePhotoCeiling`. */
export interface CeilingSuggestion {
  suggested: number;
  pooledMedian: number;
  /** Per Subject with at least 2 real photos: its Identity Ceiling, the median of its pairs. */
  subjects: { name: string; value: number; pairs: number }[];
}

/** The suggested single-photo Identity Ceiling of `subjects`; see `checkCalibrationSubjects`. */
export function ceilingSuggestion(subjects: readonly CalibrationSubject[]): CeilingSuggestion {
  checkCalibrationSubjects(subjects);
  const ceilings: CeilingSuggestion["subjects"] = [];
  const pooled: number[] = [];
  for (const { name, photos } of subjects) {
    const pairs = pairwiseSimilarities(photos);
    pooled.push(...pairs);
    if (pairs.length > 0) ceilings.push({ name, value: median(pairs), pairs: pairs.length });
  }
  return {
    suggested: median(ceilings.map(({ value }) => value)),
    pooledMedian: median(pooled),
    subjects: ceilings,
  };
}

/** A suggested Ceiling further than this from the pooled median gets a warning. */
const CEILING_DIVERGENCE = 0.05;

/**
 * Warnings about the input and the SFace suggestions: Subjects whose Candidates
 * have no real photo to pair with; Subjects with more photos than a Run takes;
 * a suggested Ceiling far from the pooled median; and, against
 * `IdentityThresholds`' Ceiling ≥ Gate, a suggested Ceiling below a suggested or
 * the configured Gate, and a suggested Gate above the configured Ceiling
 * (configured against configured is the schema's own check).
 */
export function calibrationWarnings(sface: {
  subjects: readonly CalibrationSubject[];
  ceiling: CeilingSuggestion;
  analysis: PairSetsAnalysis;
  configured: IdentityThresholds;
}): string[] {
  const { subjects, ceiling, analysis, configured } = sface;
  const warnings: string[] = [];
  for (const { name, photos, like, unlike } of subjects) {
    if (photos.length === 0 && like.length + unlike.length > 0) {
      warnings.push(
        `Subject ${name} has no real photo with one face, so its Candidates are left unpaired`,
      );
    }
    if (photos.length > MAX_REFERENCE_PHOTOS) {
      warnings.push(
        `Subject ${name} has ${photos.length} photos, more than the ${MAX_REFERENCE_PHOTOS} a Run takes: its anchor similarities run higher than a Run's`,
      );
    }
  }
  const { suggested, pooledMedian } = ceiling;
  if (Math.abs(suggested - pooledMedian) > CEILING_DIVERGENCE) {
    warnings.push(
      `The suggested Ceiling ${suggested} (median of the Subjects' Ceilings) and the pooled median ${pooledMedian} differ by more than ${CEILING_DIVERGENCE}: Subjects disagree, or one with many photos dominates the pooled pairs`,
    );
  }
  const rule = "the single-photo Ceiling must be at least the Identity Gate";
  for (const set of ["realAnchor", "candidateAnchor"] as const) {
    const gate = analysis[set]?.suggestion?.threshold;
    if (gate === undefined) continue;
    if (suggested < gate) {
      warnings.push(
        `The suggested Ceiling ${suggested} lies below the Identity Gate suggested by ${set} (${gate}); ${rule}`,
      );
    }
    if (gate > configured.singlePhotoCeiling) {
      warnings.push(
        `The Identity Gate suggested by ${set} (${gate}) lies above the configured single-photo Ceiling (${configured.singlePhotoCeiling}); ${rule}`,
      );
    }
  }
  if (suggested < configured.identityGate) {
    warnings.push(
      `The suggested Ceiling ${suggested} lies below the configured Identity Gate (${configured.identityGate}); ${rule}`,
    );
  }
  return warnings;
}

/**
 * The analysis of each pair set, the sets thresholds are taken from first; the
 * Candidate sets only when they have pairs.
 */
export interface PairSetsAnalysis {
  realAnchor: PairSetAnalysis;
  candidateAnchor?: PairSetAnalysis;
  real: PairSetAnalysis;
  candidatePhoto?: PairSetAnalysis;
}

/**
 * `analysePairSet` for each pair set of `pairs`: with a suggestion for
 * `realAnchor` and `candidateAnchor`, as context only for `real` and
 * `candidatePhoto`.
 */
export function analysePairs(
  pairs: CalibrationPairs,
  options: { targetFar: number; configured: readonly number[] },
): PairSetsAnalysis {
  const hasPairs = ({ same, different }: PairSet) => same.length + different.length > 0;
  const suggesting = { ...options, suggest: true };
  const context = { ...options, suggest: false };
  return {
    realAnchor: analysePairSet(pairs.realAnchor, suggesting),
    ...(hasPairs(pairs.candidateAnchor) && {
      candidateAnchor: analysePairSet(pairs.candidateAnchor, suggesting),
    }),
    real: analysePairSet(pairs.real, context),
    ...(hasPairs(pairs.candidatePhoto) && {
      candidatePhoto: analysePairSet(pairs.candidatePhoto, context),
    }),
  };
}
