import { addCallCosts, type CallCosts, LANE_STOPS_WITH_DETAIL } from "@iconograph/domain";
import { ARMS, type Arm, type ArmRun, type EvaluatedCandidate } from "./arms";

/*
 * The eval report: pure aggregation of what every Arm's Runs produced and how
 * the evaluation scored it. The held-out scores (FaceNet, the second Judge)
 * and the loop's own scores (its Judge's weighted totals, SFace Likeness)
 * are kept apart, never blended.
 */

/**
 * Some scores of a group of Runs: how many, the best, and three means. `mean`
 * weighs every image alike, so a Subject with more images counts more;
 * `subjectMean` is the mean of each Subject's own mean, every Subject alike;
 * `runBestMean` is the mean of each Run's best over the `runBestRuns` Runs
 * with a score. Null when there is no score.
 */
export interface Summary {
  readonly count: number;
  readonly best: number | null;
  readonly mean: number | null;
  readonly subjectMean: number | null;
  readonly runBestMean: number | null;
  readonly runBestRuns: number;
}

/** What some Runs spent: the sum of the known, and how many Runs' spend is unknown (not read back). */
export type Spend = CallCosts & { readonly unknownCostRuns: number };

export interface ArmStats {
  readonly runs: number;
  readonly candidates: number;
  /** Candidates with an image, every one scored by the held-out evaluation. */
  readonly images: number;
  readonly heldOut: Summary & {
    readonly passed: number;
    readonly noFace: number;
    readonly unreadable: number;
  };
  readonly evalJudge: Summary & {
    readonly failed: number;
    readonly unreadable: number;
    readonly skipped: number;
  };
  readonly loop: { readonly judgeTotal: Summary; readonly likeness: Summary };
  readonly armCost: Spend;
  readonly evalCost: CallCosts;
}

export type ArmsStats = { readonly [A in Arm]: ArmStats };

const mean = (values: readonly number[]) =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;

/** `Summary` of the score `pick` gives each Candidate (null: none) over `runs`. */
function summarize(
  runs: readonly ArmRun[],
  pick: (candidate: EvaluatedCandidate) => number | null,
): Summary {
  const scores = (some: readonly ArmRun[]) =>
    some.flatMap(({ candidates }) => candidates.flatMap((candidate) => pick(candidate) ?? []));
  const all = scores(runs);
  const subjects = [...new Set(runs.map(({ subject }) => subject))];
  return {
    count: all.length,
    best: all.length === 0 ? null : Math.max(...all),
    mean: mean(all),
    subjectMean: mean(
      subjects.flatMap(
        (subject) => mean(scores(runs.filter((run) => run.subject === subject))) ?? [],
      ),
    ),
    ...(() => {
      const bests = runs.flatMap((run) => {
        const own = scores([run]);
        return own.length === 0 ? [] : [Math.max(...own)];
      });
      return { runBestMean: mean(bests), runBestRuns: bests.length };
    })(),
  };
}

/** The Runs' Arm spend: known costs added up, unknown ones counted. */
const armSpend = (runs: readonly ArmRun[]): Spend => ({
  ...addCallCosts(runs.flatMap(({ armCost }) => (armCost ? [armCost] : []))),
  unknownCostRuns: runs.filter(({ armCost }) => armCost === null).length,
});

/** The statistics of some Runs of one Arm (none: an empty Arm, every summary null). */
export function armStats(runs: readonly ArmRun[]): ArmStats {
  const candidates = runs.flatMap((run) => run.candidates);
  const heldOut = candidates.flatMap(({ heldOut }) => (heldOut ? [heldOut] : []));
  const judged = candidates.flatMap(({ evalJudge }) => (evalJudge ? [evalJudge] : []));
  const count = <T extends { status: string }>(scores: readonly T[], status: T["status"]) =>
    scores.filter((score) => score.status === status).length;
  return {
    runs: runs.length,
    candidates: candidates.length,
    images: heldOut.length,
    heldOut: {
      ...summarize(runs, ({ heldOut }) =>
        heldOut?.status === "scored" ? heldOut.similarity : null,
      ),
      passed: heldOut.filter((score) => score.status === "scored" && score.pass).length,
      noFace: count(heldOut, "no-face"),
      unreadable: count(heldOut, "unreadable"),
    },
    evalJudge: {
      ...summarize(runs, ({ evalJudge }) =>
        evalJudge?.status === "judged" ? evalJudge.score : null,
      ),
      failed: count(judged, "judge-failed"),
      unreadable: count(judged, "unreadable"),
      skipped: count(judged, "skipped"),
    },
    loop: {
      judgeTotal: summarize(runs, ({ loop }) => loop.judgeTotal),
      likeness: summarize(runs, ({ loop }) => loop.likeness),
    },
    armCost: armSpend(runs),
    evalCost: addCallCosts(runs.map(({ evalCost }) => evalCost)),
  };
}

/** Both Arms' statistics over `runs`. */
const byArm = (runs: readonly ArmRun[]): ArmsStats => ({
  optimizer: armStats(runs.filter(({ arm }) => arm === "optimizer")),
  resample: armStats(runs.filter(({ arm }) => arm === "resample")),
});

/**
 * Both Arms' statistics, compared only over complete pairs: an Optimizer and
 * a Resample Run of the same Subject and Image Model, both `comparable`. An
 * evaluation that stopped early leaves unpaired Runs; they stay in the
 * report's Runs and in the totals, never in a comparison row.
 */
export interface Comparison {
  readonly pairs: { readonly planned: number; readonly compared: number };
  readonly arms: ArmsStats;
  readonly byImageModel: readonly { readonly model: string; readonly arms: ArmsStats }[];
  /** One Run per Arm each. */
  readonly bySubject: readonly {
    readonly subject: string;
    readonly model: string;
    readonly arms: ArmsStats;
  }[];
  /** Every Run's spend, paired or not. */
  readonly totals: { readonly armCost: Spend; readonly evalCost: CallCosts };
}

/**
 * A Run that can be compared: complete, and not cut short because a vendor
 * rejected the loop's Judge or Optimizer for good (it would set a truncated
 * Run against a full one).
 */
const comparable = (run: ArmRun) =>
  run.complete && !(LANE_STOPS_WITH_DETAIL as readonly (string | null)[]).includes(run.stopReason);

/**
 * The comparison of `planned` pairs: both Arms overall, per Image Model, and
 * per Subject and Image Model, over the complete pairs only; groups in the
 * order their first Run appears.
 */
export function compareArms(runs: readonly ArmRun[], planned: number): Comparison {
  const pairs = runs
    .filter(({ arm }) => arm === "optimizer")
    .flatMap((optimizer) => {
      const resample = runs.find(
        (run) =>
          run.arm === "resample" &&
          run.subject === optimizer.subject &&
          run.model === optimizer.model,
      );
      return comparable(optimizer) && resample && comparable(resample)
        ? [[optimizer, resample] as const]
        : [];
    });
  const paired = pairs.flat();
  const models = [...new Set(paired.map(({ model }) => model))];
  return {
    pairs: { planned, compared: pairs.length },
    arms: byArm(paired),
    byImageModel: models.map((model) => ({
      model,
      arms: byArm(paired.filter((run) => run.model === model)),
    })),
    bySubject: pairs.map(([optimizer, resample]) => ({
      subject: optimizer.subject,
      model: optimizer.model,
      arms: byArm([optimizer, resample]),
    })),
    totals: {
      armCost: armSpend(runs),
      evalCost: addCallCosts(runs.map(({ evalCost }) => evalCost)),
    },
  };
}

const score = (value: number | null, digits: number) =>
  value === null ? "-" : value.toFixed(digits);
const usd = (value: number) => `$${value.toFixed(4)}`;
/** Spend as reported; with calls of unknown cost, also `~` the committed figure (those at their estimate). */
const spend = (cost: CallCosts & { readonly unknownCostRuns?: number }) =>
  [
    cost.unknownCostCalls === 0
      ? usd(cost.actualUsd)
      : `${usd(cost.actualUsd)} (~${usd(cost.committedUsd)}, ${cost.unknownCostCalls} unknown)`,
    ...(cost.unknownCostRuns ? [`+ ${cost.unknownCostRuns} Run(s) of unknown spend`] : []),
  ].join(" ");

/** Rows of cells as left-aligned, space-separated columns. */
function columns(rows: readonly (readonly string[])[]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column]!))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/** A score's best, image mean, mean of Subject means and mean of Run bests. */
const summaryCells = (
  { best, mean: imageMean, subjectMean, runBestMean }: Summary,
  digits: number,
) => [
  score(best, digits),
  score(imageMean, digits),
  score(subjectMean, digits),
  score(runBestMean, digits),
];

/** One row per Arm of every group: the label in the first, then `cells` of its statistics. */
function groupRows(comparison: Comparison, cells: (stats: ArmStats) => string[]): string[][] {
  const groups = [
    { label: "All", arms: comparison.arms },
    ...comparison.byImageModel.map(({ model, arms }) => ({ label: model, arms })),
    ...comparison.bySubject.map(({ subject, model, arms }) => ({
      label: `${subject} / ${model}`,
      arms,
    })),
  ];
  return groups.flatMap(({ label, arms }) =>
    ARMS.map((arm, index) => [index === 0 ? label : "", arm, ...cells(arms[arm])]),
  );
}

const SUMMARY_HEADER = ["best", "mean", "Subj mean", "Run best"];

/**
 * The comparison as two tables for the terminal, overall, per Image Model
 * and per Subject: the held-out scores (FaceNet similarity, how many reach
 * the threshold, images without a face or unreadable; the second Judge,
 * failed and skipped judgings) with images and spend per Arm, then the
 * loop's own scores (its Judge's weighted total and SFace Likeness).
 */
export function renderComparison(comparison: Comparison, evalJudge: string): string {
  const heldOut = [
    [
      "",
      "Arm",
      "Runs",
      "Images",
      ...SUMMARY_HEADER.map((cell) => `FaceNet ${cell}`),
      "pass",
      "no face",
      "unreadable",
      ...SUMMARY_HEADER.map((cell) => `Judge 2 ${cell}`),
      "failed",
      "skipped",
      "Arm spend",
      "Eval spend",
    ],
    ...groupRows(comparison, (stats) => [
      String(stats.runs),
      String(stats.images),
      ...summaryCells(stats.heldOut, 3),
      `${stats.heldOut.passed}/${stats.heldOut.count}`,
      String(stats.heldOut.noFace),
      String(stats.heldOut.unreadable),
      ...summaryCells(stats.evalJudge, 2),
      String(stats.evalJudge.failed),
      String(stats.evalJudge.skipped),
      spend(stats.armCost),
      spend(stats.evalCost),
    ]),
  ];
  const loop = [
    [
      "",
      "Arm",
      ...SUMMARY_HEADER.map((cell) => `loop Judge ${cell}`),
      ...SUMMARY_HEADER.map((cell) => `Likeness ${cell}`),
    ],
    ...groupRows(comparison, (stats) => [
      ...summaryCells(stats.loop.judgeTotal, 2),
      ...summaryCells(stats.loop.likeness, 2),
    ]),
  ];
  return [
    `Held-out scores: FaceNet similarity to the Subject's anchor; Judge 2 is ${evalJudge} (Rubric total without Likeness).`,
    "mean weighs every image alike; Subj mean is the mean of each Subject's mean; Run best the mean of each Run's best.",
    "Spend is what the vendors reported; with calls of unknown cost, ~ counts those at their estimate.",
    `Compared: ${comparison.pairs.compared} of ${comparison.pairs.planned} Optimizer/Resample pairs (Subject and Image Model), complete ones only.`,
    "",
    columns(heldOut),
    "",
    "Loop's own scores, kept apart:",
    "",
    columns(loop),
    "",
    `Total: Arms ${spend(comparison.totals.armCost)}, evaluation ${spend(comparison.totals.evalCost)}`,
    "",
  ].join("\n");
}
