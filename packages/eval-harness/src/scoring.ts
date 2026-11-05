import { decodeReferencePhoto, errorMessage, readForJudge } from "@iconograph/adapters";
import { HeldOutFaceEmbedder, scoreHeldOut } from "@iconograph/adapters/held-out";
import {
  byCriterion,
  type CallCosts,
  type CallGate,
  callCosts,
  CRITERIA,
  type EncodedImage,
  type Embedding,
  type Judge,
  judgeCandidate,
  type LedgerEntry,
  type RetryPolicy,
  type RubricWeights,
  type TargetLook,
} from "@iconograph/domain";
import { Effect } from "effect";
import type { EvalJudgeScore, HeldOutScore } from "./arms";

/*
 * The evaluation's own scoring of Candidate images, after their Run has
 * ended: the held-out face model (ADR-0008), which no Run ever reaches, and
 * a second Judge from another vendor than the loop's, outside the Budget.
 */

/**
 * FaceNet embeddings of the faces a Subject's Run uses: one per accepted
 * Reference Photo, the face the Run's validation chose (numbered from 1 in
 * detection order; the held-out pipeline shares YuNet, so it finds the same).
 */
export const heldOutReferences = (photos: readonly { path: string; face: number }[]) =>
  Effect.forEach(photos, ({ path, face }) =>
    Effect.gen(function* () {
      const embedder = yield* HeldOutFaceEmbedder;
      const { image } = yield* decodeReferencePhoto(path);
      const found = (yield* embedder.detect(image))[face - 1];
      if (!found) {
        return yield* Effect.fail(
          new Error(`The held-out face model found no face ${face} in Reference Photo ${path}`),
        );
      }
      return yield* embedder.embed(image, found);
    }),
  );

/**
 * One Candidate image's held-out score: the highest FaceNet similarity of any
 * of its faces to the held-out anchor of `references` (as the loop's Likeness
 * takes its best face), passing at the held-out threshold. Bytes that aren't a
 * usable image are `unreadable`; a read or face-model fault fails.
 */
export const scoreHeldOutImage = (path: string, references: readonly Embedding[]) =>
  Effect.gen(function* () {
    const embedder = yield* HeldOutFaceEmbedder;
    const decoded = yield* decodeReferencePhoto(path, undefined, "Candidate").pipe(
      Effect.catchTag("ReferencePhotoError", (error) =>
        error.stage === "decoded" ? Effect.succeed(error) : Effect.fail(error),
      ),
    );
    if (!("image" in decoded)) {
      return { status: "unreadable", reason: decoded.detail ?? decoded.message } as const;
    }
    const faces = yield* embedder.detect(decoded.image);
    if (faces.length === 0) return { status: "no-face" } as const;
    const similarities = yield* Effect.forEach(faces, (face) =>
      embedder
        .embed(decoded.image, face)
        .pipe(
          Effect.map(
            (embedding) => scoreHeldOut(embedding, references, embedder.threshold).anchorSimilarity,
          ),
        ),
    );
    const similarity = Math.max(...similarities);
    return {
      status: "scored",
      similarity,
      pass: similarity >= embedder.threshold,
    } satisfies HeldOutScore;
  });

/** The second Judge's calls for one Run: gates to make them through, and what they cost. */
export interface EvalLedger {
  /** The gate of one Candidate's calls, by attempt. */
  readonly gate: (candidate: string) => CallGate;
  readonly cost: () => CallCosts;
}

/**
 * A second-Judge ledger. There is no cap (evaluation spend is outside the
 * Arms' Budget); a call without a reported cost counts as unknown, its
 * estimate kept.
 */
export function evalLedger(): EvalLedger {
  const calls = new Map<string, Pick<LedgerEntry, "estimateMicros" | "actualMicros">>();
  return {
    gate: (candidate) => ({
      reserve: (attempt, estimate) =>
        Effect.sync(() => {
          calls.set(`${candidate}/${attempt}`, {
            estimateMicros: estimate.micros,
            actualMicros: null,
          });
        }),
      settle: (attempt, result) =>
        Effect.sync(() => {
          const key = `${candidate}/${attempt}`;
          calls.set(key, { ...calls.get(key)!, actualMicros: result.costMicros });
        }),
    }),
    cost: () => callCosts([...calls.values()]),
  };
}

/**
 * The Run's weights without Likeness, the rest scaled to sum to 1: the second
 * Judge's total then holds only what that Judge sees, never the loop's face
 * model. Weights that put everything on Likeness leave nothing to score: an
 * error, before any Run.
 */
export function judgeOnlyWeights(weights: RubricWeights): RubricWeights {
  if (!(weights.likeness < 1)) {
    throw new Error(
      `The Judge's weights put ${weights.likeness} on Likeness, so the second Judge, which leaves Likeness out, has nothing to score`,
    );
  }
  const scale = 1 / (1 - weights.likeness);
  return byCriterion(CRITERIA, (criterion) =>
    criterion === "likeness" ? 0 : weights[criterion] * scale,
  );
}

export interface EvalJudgeRequest {
  readonly judge: Judge;
  /** The Subject's Reference Photos as the loop's Judge sees them, in the same order. */
  readonly references: readonly EncodedImage[];
  readonly targetLook: TargetLook;
  /** `judgeOnlyWeights` of the Run's weights. */
  readonly weights: RubricWeights;
  readonly gate: CallGate;
  readonly policy?: RetryPolicy;
}

/**
 * One Candidate image judged by the second Judge against the Rubric, with the
 * existing Judge code (`judgeCandidate`: retries, decoding, scoring). The
 * image is sent as the loop's Judge gets it (`readForJudge`); the caller
 * sends only images the held-out decode could read, so failing to read one
 * here is a fault, not an unusable image. A failed judging keeps its cause,
 * `non-recoverable` when the vendor turned the call away for good.
 */
export const judgeImage = (path: string, request: EvalJudgeRequest) =>
  Effect.gen(function* () {
    const image = yield* Effect.tryPromise({
      try: () => readForJudge(path),
      catch: (error) =>
        new Error(
          `Reading Candidate image ${path} for the second Judge failed: ${errorMessage(error)}`,
        ),
    });
    const { judge, references, targetLook, weights, gate, policy } = request;
    const estimate = judge.estimate({ references: references.length, targetLook });
    // No cap: reserving always succeeds.
    yield* gate.reserve(0, estimate).pipe(Effect.orDie);
    const judgement = yield* judgeCandidate({
      judge,
      request: { references, candidate: image, targetLook },
      estimate,
      likeness: 0,
      weights,
      gate,
      ...(policy && { policy }),
    }).pipe(Effect.orDie);
    return judgement._tag === "Judged"
      ? ({ status: "judged", score: judgement.weightedTotal } satisfies EvalJudgeScore)
      : ({
          status: "judge-failed",
          cause: judgement.cause,
          reason: judgement.reason,
        } satisfies EvalJudgeScore);
  });
