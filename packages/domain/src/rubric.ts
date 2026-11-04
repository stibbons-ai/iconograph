import { Schema } from "effect";
import { MAX_LIKENESS } from "./likeness";
import type { TargetLook } from "./target-look";

/**
 * The criteria the Judge scores, in the order the Rubric lists them. Likeness
 * is not among them: the face model measures it.
 */
export const JUDGED_CRITERIA = [
  "resemblance",
  "realism",
  "pose",
  "background",
  "lighting",
  "hairstyle",
  "clothing",
  "framing",
] as const;
export type JudgedCriterion = (typeof JUDGED_CRITERIA)[number];

/** Every weighted criterion of a Candidate's total. */
export const CRITERIA = ["likeness", ...JUDGED_CRITERIA] as const;
export type Criterion = (typeof CRITERIA)[number];

/** One value per criterion of `criteria`, e.g. a schema field or a score each. */
export function byCriterion<C extends string, V>(
  criteria: readonly C[],
  value: (criterion: C) => V,
): { readonly [K in C]: V } {
  // Every key of `criteria` gets a value, which `Object.fromEntries` can't express.
  return Object.fromEntries(criteria.map((criterion) => [criterion, value(criterion)])) as {
    readonly [K in C]: V;
  };
}

/** Anchored levels run from 1 (worst) to 5 (best). */
export const MIN_LEVEL = 1;
export const MAX_LEVEL = 5;

/** One criterion: what the Judge looks at, and the written anchor of each level 1–5. */
export interface RubricCriterion {
  readonly title: string;
  readonly question: string;
  readonly anchors: readonly [string, string, string, string, string];
}

/** The Rubric versions this build can read; a new version is added here with its rules. */
const RUBRIC_VERSIONS = ["rubric-v1"] as const;
export type RubricVersion = (typeof RUBRIC_VERSIONS)[number];

/** A versioned Rubric: its criteria with anchored levels. */
export interface Rubric {
  readonly version: RubricVersion;
  readonly criteria: { readonly [C in JudgedCriterion]: RubricCriterion };
}

/** A facet criterion: how well the Candidate matches that Target Look facet. */
const facetCriterion = (
  title: string,
  facet: keyof TargetLook,
  described: string,
): RubricCriterion => ({
  title,
  question: `How well does the Candidate's ${described} match the Target Look's ${facet} as written?`,
  anchors: [
    `contradicts the Target Look's ${facet}`,
    `differs substantially from the Target Look's ${facet}; only a small part of it matches`,
    `partly matches the Target Look's ${facet}, with clear deviations`,
    `matches the Target Look's ${facet}, with minor deviations`,
    `matches the Target Look's ${facet} fully and looks natural`,
  ],
});

/**
 * Rubric v1 (issue #1 "Rubric and judging"). Changing any text here changes
 * how the Judge scores, so it needs a new version; every stored score records
 * the version it was judged with.
 */
export const RUBRIC_V1: Rubric = {
  version: "rubric-v1",
  criteria: {
    resemblance: {
      title: "Resemblance",
      question:
        "Is the person in the Candidate unmistakably the Subject shown in the Reference Photos?",
      anchors: [
        "a different person",
        "shares some traits with the Subject but would not be recognised as them",
        "plausibly the Subject, but with noticeable differences in facial features, proportions or apparent age",
        "clearly the Subject, with minor differences (e.g. slightly idealised or smoothed)",
        "unmistakably the Subject, as recognisable as in their own Reference Photos",
      ],
    },
    realism: {
      title: "Realism",
      question: "Does the Candidate look like a real, unedited photograph?",
      anchors: [
        "obviously synthetic: distorted anatomy, melted features or garbled details",
        "clearly AI-generated: plastic skin, wrong anatomical details or an illustrated look",
        "convincing at a glance, but with visible artefacts (waxy skin, odd eyes, teeth, ears or hands, inconsistent edges)",
        "photographic, with minor artefacts noticeable only on close inspection",
        "indistinguishable from a real professional photograph",
      ],
    },
    pose: facetCriterion("Pose", "pose", "pose and expression"),
    background: facetCriterion("Background", "background", "background"),
    lighting: facetCriterion("Lighting", "lighting", "lighting and colour"),
    hairstyle: facetCriterion("Hairstyle", "hairstyle", "hairstyle"),
    clothing: facetCriterion("Clothing", "clothing", "clothing"),
    framing: facetCriterion("Framing", "framing", "framing and crop"),
  },
};

/** The Rubric new Runs are judged with. */
export const CURRENT_RUBRIC = RUBRIC_V1;

/** How a Rubric version turns levels into scores and decides Disputed. */
interface RubricRules {
  readonly levelScore: (level: number) => number;
  readonly isDisputed: (likeness: number, resemblance: number) => boolean;
}

/** Likeness and Resemblance disagree when they differ by more than this many points (v1). */
export const DISPUTED_GAP = 4;

/**
 * Each Rubric version's rules, used both to score a verdict and to check a
 * stored one, so the two can't drift apart. A version keeps its rules for
 * good: a later version with another mapping or gap adds its own entry, and
 * Runs judged with an earlier version stay readable by that version's rules.
 */
const RUBRIC_RULES: { readonly [V in RubricVersion]: RubricRules } = {
  "rubric-v1": {
    // An anchored level mapped linearly to 0–10: 1 → 0, 5 → 10.
    levelScore: (level) => ((level - MIN_LEVEL) / (MAX_LEVEL - MIN_LEVEL)) * MAX_LIKENESS,
    // Strictly more than `DISPUTED_GAP` points apart, in either direction; exactly 4 is not.
    isDisputed: (likeness, resemblance) => Math.abs(likeness - resemblance) > DISPUTED_GAP,
  },
};

/** An anchored level mapped to 0–10 by the current Rubric: 1 → 0, 5 → 10. */
export function levelScore(level: number): number {
  return RUBRIC_RULES[CURRENT_RUBRIC.version].levelScore(level);
}

const Level = Schema.Int.check(Schema.isBetween({ minimum: MIN_LEVEL, maximum: MAX_LEVEL }));

/** The longest visible issue or suggested Prompt fix, and how many of each a verdict holds. */
export const MAX_NOTE_LENGTH = 500;
export const MAX_NOTES = 10;

/** A visible issue or a suggested Prompt fix: one short sentence. */
const Note = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(MAX_NOTE_LENGTH));

/**
 * What the Judge returns (LLM-facing, so finite numbers only): a level 1–5
 * per criterion, the visible issues, and suggested Prompt fixes. Untrusted:
 * anything outside this schema fails the judging instead of being stored.
 */
export const JudgeVerdict = Schema.Struct({
  levels: Schema.Struct(byCriterion(JUDGED_CRITERIA, () => Level)),
  issues: Schema.Array(Note).check(Schema.isMaxLength(MAX_NOTES)),
  promptFixes: Schema.Array(Note).check(Schema.isMaxLength(MAX_NOTES)),
});
export type JudgeVerdict = typeof JudgeVerdict.Type;

/** A criterion's weight in the total: finite and non-negative. */
const Weight = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/** How far the weights may sum from 1, for decimal weights such as 0.15 + 0.07. */
const WEIGHT_SUM_TOLERANCE = 1e-9;

/** Weights as given: any keys, each of which must be a criterion of the Rubric. */
const GivenWeights = Schema.Record(Schema.String, Weight).check(
  Schema.makeFilter((weights: Readonly<Record<string, number>>) => {
    const unknown = Object.keys(weights).find(
      (key) => !(CRITERIA as readonly string[]).includes(key),
    );
    return unknown === undefined ? true : `Unknown criterion ${unknown}`;
  }),
);

/**
 * One weight per criterion, summing to 1. Frozen per Run: stored with its
 * request and never changed. Strict wherever it is decoded (a Run request,
 * Mastra's input validation): a key that is no criterion is an error, never
 * silently dropped. Its input JSON Schema is therefore a record of numbers,
 * without the criterion names or `required`: accepted, since validation, not
 * the JSON Schema, guards the weights, and only Studio's display is coarser.
 */
export const RubricWeights = GivenWeights.pipe(
  Schema.decodeTo(Schema.Struct(byCriterion(CRITERIA, () => Weight))),
).check(
  Schema.makeFilter((weights: { readonly [C in Criterion]: number }) => {
    const sum = CRITERIA.reduce((total, criterion) => total + weights[criterion], 0);
    return Math.abs(sum - 1) <= WEIGHT_SUM_TOLERANCE
      ? true
      : `The weights must sum to 1, not ${sum}`;
  }),
);
export type RubricWeights = typeof RubricWeights.Type;

/** Issue #1's default weights. */
export const DEFAULT_WEIGHTS: RubricWeights = {
  likeness: 0.3,
  resemblance: 0.15,
  realism: 0.15,
  pose: 0.1,
  background: 0.08,
  lighting: 0.08,
  hairstyle: 0.07,
  clothing: 0.05,
  framing: 0.02,
};

/** A Candidate's scores on 0–10, one per criterion. */
export type CriterionScores = { readonly [C in Criterion]: number };

/** Totals are rounded to this many decimals, so float error can't order equal totals. */
const TOTAL_DECIMALS = 9;

/**
 * The weighted sum of the criterion scores, rounded to 9 decimals (all-10
 * scores total exactly 10) and clamped to 0–10: weights may sum to 1 within
 * a tolerance, and a total a hair over 10 must not fail a paid judgement.
 */
export function weightedTotal(scores: CriterionScores, weights: RubricWeights): number {
  const total = CRITERIA.reduce(
    (sum, criterion) => sum + weights[criterion] * scores[criterion],
    0,
  );
  return Math.min(MAX_LIKENESS, Math.max(0, Number(total.toFixed(TOTAL_DECIMALS))));
}

/**
 * Disputed by the current Rubric: Likeness (face model) and Resemblance
 * (Judge) differ by strictly more than `DISPUTED_GAP` points, in either
 * direction; exactly 4 is not.
 */
export function isDisputed(likeness: number, resemblance: number): boolean {
  return RUBRIC_RULES[CURRENT_RUBRIC.version].isDisputed(likeness, resemblance);
}

const Score = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: MAX_LIKENESS }));

/**
 * Why the Judge's work on a Candidate failed: the Judge `refused`; the call
 * `failed` (an error not worth retrying, or an answer outside the verdict
 * schema); it `gave-up` after transient errors; a call or retry was
 * `budget-exhausted` (didn't fit the Budget, so it wasn't made); or the
 * vendor turned the call away for good, `non-recoverable` (HTTP 401, 402,
 * 403 or 404, or Google's 400 for a bad key), which stops the Lane
 * (`judge-failed`).
 */
export const JudgeFailure = Schema.Literals([
  "refused",
  "failed",
  "gave-up",
  "budget-exhausted",
  "non-recoverable",
]);
export type JudgeFailure = typeof JudgeFailure.Type;

export const RubricVersion = Schema.Literals(RUBRIC_VERSIONS);

interface StoredJudged {
  readonly levels: { readonly [C in JudgedCriterion]: number };
  readonly scores: CriterionScores;
  readonly disputed: boolean;
}

/** Whether a stored `Judged` follows its own version's rules (`RUBRIC_RULES`). */
function followsRubric(judged: StoredJudged & { readonly rubricVersion: RubricVersion }) {
  const rules = RUBRIC_RULES[judged.rubricVersion];
  return (
    JUDGED_CRITERIA.every(
      (criterion) => judged.scores[criterion] === rules.levelScore(judged.levels[criterion]),
    ) && judged.disputed === rules.isDisputed(judged.scores.likeness, judged.scores.resemblance)
  );
}

const consistentJudged = Schema.makeFilter(
  (judged: StoredJudged & { readonly rubricVersion: RubricVersion }) =>
    followsRubric(judged)
      ? true
      : "The scores or Disputed flag don't follow from the levels and Likeness",
);

/**
 * How the Judge's work on one Scored Candidate ended, stored with the Rubric
 * version it was judged against. `JudgeFailed`: no usable verdict, with its
 * `cause` and the reason in words; the Candidate keeps its Likeness and has
 * no Rubric scores.
 */
export const Judgement = Schema.Union([
  Schema.TaggedStruct("Judged", {
    rubricVersion: RubricVersion,
    levels: JudgeVerdict.fields.levels,
    /** Every criterion on 0–10; Likeness is the face model's, the rest map the levels. */
    scores: Schema.Struct(byCriterion(CRITERIA, () => Score)),
    /** The weighted sum with the Run's weights, on 0–10. */
    weightedTotal: Score,
    disputed: Schema.Boolean,
    issues: Schema.Array(Schema.String),
    promptFixes: Schema.Array(Schema.String),
  }).check(consistentJudged),
  Schema.TaggedStruct("JudgeFailed", {
    rubricVersion: RubricVersion,
    cause: JudgeFailure,
    reason: Schema.String,
  }),
]);
export type Judgement = typeof Judgement.Type;

/** Score a verdict: map its levels to 0–10, add Likeness, weigh, and check for a dispute. */
export function scoreVerdict(
  verdict: JudgeVerdict,
  likeness: number,
  weights: RubricWeights,
  rubric: Rubric,
): Extract<Judgement, { _tag: "Judged" }> {
  const rules = RUBRIC_RULES[rubric.version];
  const judged = byCriterion(JUDGED_CRITERIA, (criterion) =>
    rules.levelScore(verdict.levels[criterion]),
  );
  const scores: CriterionScores = { likeness, ...judged };
  return {
    _tag: "Judged",
    rubricVersion: rubric.version,
    levels: verdict.levels,
    scores,
    weightedTotal: weightedTotal(scores, weights),
    disputed: rules.isDisputed(likeness, scores.resemblance),
    issues: verdict.issues,
    promptFixes: verdict.promptFixes,
  };
}
