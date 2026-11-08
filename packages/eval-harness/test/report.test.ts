import { describe, expect, test } from "bun:test";
import type { ArmRun, EvaluatedCandidate } from "../src/arms";
import { armStats, compareArms, flatJudgeWarnings, renderComparison } from "../src/report";

const noCost = { estimatedUsd: 0, actualUsd: 0, committedUsd: 0, unknownCostCalls: 0 };
const none = {
  count: 0,
  best: null,
  mean: null,
  subjectMean: null,
  runBestMean: null,
  runBestRuns: 0,
};

/** A Candidate with an image, held-out similarity `similarity` (null: no face) and second-Judge `score`. */
const imaged = (
  similarity: number | null,
  score: number | null,
  loop: EvaluatedCandidate["loop"] = { judgeTotal: null, likeness: null },
): EvaluatedCandidate => ({
  iteration: 1,
  candidate: 0,
  outcome: similarity === null ? "Gated" : "Scored",
  loop,
  heldOut:
    similarity === null
      ? { status: "no-face" }
      : { status: "scored", similarity, pass: similarity >= 0.52 },
  evalJudge:
    score === null
      ? { status: "judge-failed", cause: "refused", reason: "fake: declined" }
      : { status: "judged", score },
});

/** A Candidate without an image (Refused). */
const refused: EvaluatedCandidate = {
  iteration: 1,
  candidate: 1,
  outcome: "Refused",
  loop: { judgeTotal: null, likeness: null },
  heldOut: null,
  evalJudge: null,
};

const run = (overrides: Partial<ArmRun>): ArmRun => ({
  subject: "ada",
  model: "gemini-nano-banana-2.1",
  arm: "optimizer",
  runId: "run",
  complete: true,
  stopReason: "iteration-limit",
  stopDetail: null,
  iterations: 1,
  armCost: noCost,
  evalCost: noCost,
  prices: { imageModel: null, judge: null, optimizer: null },
  candidates: [],
  ...overrides,
});

describe("Arm statistics", () => {
  test("best and mean count only scored images; no face, unreadable, judge failures, skips and missing images are counted apart", () => {
    const stats = armStats([
      run({
        candidates: [
          imaged(0.6, 7, { judgeTotal: 8, likeness: 9 }),
          imaged(0.4, null, { judgeTotal: null, likeness: null }),
          imaged(null, 5),
          {
            ...refused,
            heldOut: { status: "unreadable", reason: "not an image" },
            evalJudge: { status: "unreadable", reason: "not an image" },
          },
          { ...imaged(0.5, null), evalJudge: { status: "skipped", reason: "rejected" } },
          refused,
        ],
      }),
    ]);
    expect(stats).toMatchObject({ runs: 1, candidates: 6, images: 5 });
    expect(stats.heldOut).toMatchObject({
      count: 3,
      best: 0.6,
      mean: 0.5,
      passed: 1,
      noFace: 1,
      unreadable: 1,
    });
    expect(stats.evalJudge).toMatchObject({
      count: 2,
      best: 7,
      mean: 6,
      failed: 1,
      unreadable: 1,
      skipped: 1,
    });
    // The loop's own scores stand apart from the held-out ones.
    expect(stats.loop.judgeTotal).toMatchObject({ count: 1, best: 8, mean: 8 });
    expect(stats.loop.likeness).toMatchObject({ count: 1, best: 9, mean: 9 });
  });

  test("an empty Arm has no best or mean and costs nothing", () => {
    expect(armStats([])).toEqual({
      runs: 0,
      candidates: 0,
      images: 0,
      heldOut: { ...none, passed: 0, noFace: 0, unreadable: 0 },
      evalJudge: { ...none, failed: 0, unreadable: 0, skipped: 0 },
      loop: { judgeTotal: none, likeness: none },
      armCost: { ...noCost, unknownCostRuns: 0 },
      evalCost: noCost,
    });
  });

  test("the mean weighs images; the Subject mean weighs Subjects alike; the Run best mean averages each Run's best", () => {
    const stats = armStats([
      // ada: three images, mean 0.8, best 0.9; bob: one image at 0.2.
      run({ subject: "ada", candidates: [imaged(0.9, 9), imaged(0.8, 8), imaged(0.7, 7)] }),
      run({ subject: "bob", candidates: [imaged(0.2, 2)] }),
      // A Run without a scored image counts in no Run best.
      run({ subject: "bob", candidates: [imaged(null, null)] }),
    ]);
    expect(stats.heldOut.mean).toBeCloseTo((0.9 + 0.8 + 0.7 + 0.2) / 4, 12);
    expect(stats.heldOut.subjectMean).toBeCloseTo((0.8 + 0.2) / 2, 12);
    expect(stats.heldOut).toMatchObject({ runBestMean: (0.9 + 0.2) / 2, runBestRuns: 2 });
    expect(stats.evalJudge.subjectMean).toBeCloseTo((8 + 2) / 2, 12);
  });

  test("spend adds up exactly per Arm, the evaluation's apart, calls of unknown cost committed and Runs of unknown spend counted", () => {
    const stats = armStats([
      run({
        armCost: { estimatedUsd: 0.3, actualUsd: 0.1, committedUsd: 0.2, unknownCostCalls: 1 },
        evalCost: { estimatedUsd: 0.1, actualUsd: 0.05, committedUsd: 0.05, unknownCostCalls: 0 },
      }),
      run({
        armCost: { estimatedUsd: 0.3, actualUsd: 0.2, committedUsd: 0.2, unknownCostCalls: 0 },
        evalCost: { estimatedUsd: 0.1, actualUsd: 0.01, committedUsd: 0.03, unknownCostCalls: 2 },
      }),
      run({ armCost: null }),
    ]);
    // 0.1 + 0.2 is exactly 0.3 in micro-dollars, unlike in floats.
    expect(stats.armCost).toEqual({
      estimatedUsd: 0.6,
      actualUsd: 0.3,
      committedUsd: 0.4,
      unknownCostCalls: 1,
      unknownCostRuns: 1,
    });
    expect(stats.evalCost).toEqual({
      estimatedUsd: 0.2,
      actualUsd: 0.06,
      committedUsd: 0.08,
      unknownCostCalls: 2,
    });
  });
});

describe("Comparing the Arms", () => {
  const runs = [
    run({ subject: "ada", arm: "optimizer", candidates: [imaged(0.7, 8)] }),
    run({ subject: "ada", arm: "resample", candidates: [imaged(0.5, 6)] }),
    run({ subject: "bob", arm: "optimizer", candidates: [imaged(0.3, 4)] }),
    run({ subject: "bob", arm: "resample", candidates: [imaged(0.9, 9)] }),
    run({
      subject: "ada",
      model: "gpt-image-2.6-sunburst",
      arm: "optimizer",
      candidates: [imaged(0.1, 1)],
    }),
    run({
      subject: "ada",
      model: "gpt-image-2.6-sunburst",
      arm: "resample",
      candidates: [imaged(0.6, 7)],
    }),
  ];

  test("groups per Arm overall, per Image Model and per Subject and Image Model", () => {
    const comparison = compareArms(runs, 3);
    expect(comparison.pairs).toEqual({ planned: 3, compared: 3 });
    expect(comparison.arms.optimizer.heldOut).toMatchObject({ count: 3, best: 0.7 });
    expect(comparison.arms.resample.heldOut).toMatchObject({ count: 3, best: 0.9 });
    expect(
      comparison.byImageModel.map(({ model, arms }) => [
        model,
        arms.resample.runs,
        arms.optimizer.runs,
      ]),
    ).toEqual([
      ["gemini-nano-banana-2.1", 2, 2],
      ["gpt-image-2.6-sunburst", 1, 1],
    ]);
    expect(
      comparison.bySubject.map(({ subject, model, arms }) => [
        subject,
        model,
        arms.optimizer.evalJudge.best,
        arms.resample.evalJudge.best,
      ]),
    ).toEqual([
      ["ada", "gemini-nano-banana-2.1", 8, 6],
      ["bob", "gemini-nano-banana-2.1", 4, 9],
      ["ada", "gpt-image-2.6-sunburst", 1, 7],
    ]);
  });

  test("a pair whose Run stopped on a rejected Judge or Optimizer is not compared", () => {
    const cutShort = [
      ...runs.slice(0, 3),
      run({
        subject: "bob",
        arm: "resample",
        stopReason: "judge-failed",
        stopDetail: "Judge HTTP 401",
        candidates: [imaged(0.9, 9)],
      }),
    ];
    const comparison = compareArms(cutShort, 2);
    expect(comparison.pairs).toEqual({ planned: 2, compared: 1 });
    expect(comparison.bySubject.map(({ subject }) => subject)).toEqual(["ada"]);
  });

  test("only complete pairs are compared: an unpaired or incomplete Run is in the totals, not the rows", () => {
    const aborted = [
      ...runs.slice(0, 2),
      // bob's pair: the Resample Run aborted the evaluation; sunburst: only its Optimizer Run ran.
      runs[2]!,
      run({ subject: "bob", arm: "resample", complete: false, armCost: null }),
      runs[4]!,
    ];
    const comparison = compareArms(aborted, 3);
    expect(comparison.pairs).toEqual({ planned: 3, compared: 1 });
    expect(comparison.arms.optimizer).toMatchObject({ runs: 1, heldOut: { best: 0.7 } });
    expect(comparison.byImageModel.map(({ model }) => model)).toEqual(["gemini-nano-banana-2.1"]);
    expect(comparison.bySubject.map(({ subject }) => subject)).toEqual(["ada"]);
    expect(comparison.totals.armCost).toMatchObject({ unknownCostRuns: 1 });
  });

  test("the tables show every group with both Arms and spend of unknown cost with its committed figure", () => {
    const table = renderComparison(
      compareArms(
        [
          ...runs.slice(0, 5),
          run({
            subject: "ada",
            model: "gpt-image-2.6-sunburst",
            arm: "resample",
            candidates: [],
            armCost: { estimatedUsd: 1, actualUsd: 0.5, committedUsd: 0.7, unknownCostCalls: 1 },
          }),
        ],
        3,
      ),
      "openai/gpt-6.1-sol",
    );
    const rows = table.split("\n");
    // Both tables, the held-out one and the loop's.
    expect(rows.filter((row) => row.startsWith("All"))).toHaveLength(2);
    // Its Resample Run has no image: dashes for its scores.
    const at = rows.findIndex((row) => row.startsWith("ada / gpt-image-2.6-sunburst"));
    expect(rows[at + 1]).toMatch(/resample\s+1\s+0\s+-\s+-\s+-\s+-\s+0\/0/);
    expect(table).toContain("$0.5000 (~$0.7000, 1 unknown)");
    expect(table).toContain("Compared: 3 of 3");
    expect(table).toContain("openai/gpt-6.1-sol");
  });
});

describe("A flat second Judge", () => {
  const JUDGE = "google/gemini-4-argon";
  const GEMINI = "gemini-nano-banana-2.1";
  const OPENAI = "gpt-image-2.6-sunburst";
  /** Candidates the second Judge judged at `scores`, in order. */
  const judged = (...scores: number[]) => scores.map((score) => imaged(0.6, score));
  /** `count` Candidates the second Judge judged at 7.5, and `other` more at distinct other scores. */
  const flat = (count: number, other = 0) => [
    ...judged(...Array<number>(count).fill(7.5)),
    ...judged(...Array.from({ length: other }, (_, index) => 1 + index / 10)),
  ];

  test("8 of 10 images at one score warns, with the Judge, the score, the share and the count", () => {
    expect(flatJudgeWarnings([run({ candidates: flat(8, 2) })], JUDGE)).toEqual([
      {
        code: "eval-judge-flat",
        message: `The second Judge ${JUDGE} gave 80% of the 10 judged images (all Image Models) the same score, 7.50: its comparison of the Arms is weak evidence`,
        judge: JUDGE,
        imageModel: null,
        score: 7.5,
        share: 0.8,
        images: 10,
      },
    ]);
  });

  test("7 of 10 at one score, or 9 images all at one score, doesn't warn", () => {
    expect(flatJudgeWarnings([run({ candidates: flat(7, 3) })], JUDGE)).toEqual([]);
    expect(flatJudgeWarnings([run({ candidates: flat(9) })], JUDGE)).toEqual([]);
  });

  test("counts the judged images of every Run, of both Arms and an incomplete one", () => {
    expect(
      flatJudgeWarnings(
        [
          run({ arm: "optimizer", candidates: flat(4) }),
          run({ arm: "resample", candidates: flat(3) }),
          run({ arm: "optimizer", subject: "bob", complete: false, candidates: flat(3) }),
        ],
        JUDGE,
      ),
    ).toMatchObject([{ share: 1, images: 10 }]);
  });

  test("failed, skipped, unreadable and missing judgings count neither in the share nor in the images", () => {
    const unjudged: EvaluatedCandidate[] = [
      imaged(0.6, null),
      { ...imaged(0.6, null), evalJudge: { status: "skipped", reason: "rejected" } },
      { ...imaged(0.6, null), evalJudge: { status: "unreadable", reason: "not an image" } },
      refused,
    ];
    // Counted, they would push 8 of 10 below 80%.
    expect(
      flatJudgeWarnings([run({ candidates: [...flat(8, 2), ...unjudged, ...unjudged] })], JUDGE),
    ).toMatchObject([{ share: 0.8, images: 10 }]);
    // Counted, one would make 9 of 10 at one score: a warning.
    for (const one of unjudged) {
      expect(flatJudgeWarnings([run({ candidates: [...flat(9), one] })], JUDGE)).toEqual([]);
    }
  });

  test("scores equal at 2 decimals are one score", () => {
    // Weighted totals of the same levels can differ in the last bits.
    const noisy = judged(...Array.from({ length: 10 }, (_, index) => 7.5 + (index % 2) * 1e-12));
    expect(flatJudgeWarnings([run({ candidates: noisy })], JUDGE)).toMatchObject([
      { score: 7.5, share: 1, images: 10 },
    ]);
    // 7.494 and 7.504 print apart.
    const apart = judged(...Array<number>(5).fill(7.494), ...Array<number>(5).fill(7.504));
    expect(flatJudgeWarnings([run({ candidates: apart })], JUDGE)).toEqual([]);
  });

  test("a Judge flat on one Image Model's images only warns for that Image Model", () => {
    const warnings = flatJudgeWarnings(
      [
        run({ model: GEMINI, candidates: flat(10) }),
        run({ model: OPENAI, candidates: judged(1, 2, 3, 4, 5, 6, 7, 8, 9, 10) }),
      ],
      JUDGE,
    );
    expect(warnings).toMatchObject([{ imageModel: GEMINI, score: 7.5, share: 1, images: 10 }]);
    expect(warnings[0]!.message).toContain(`(${GEMINI})`);
  });

  test("flat everywhere warns overall and per Image Model; one Image Model only once", () => {
    expect(
      flatJudgeWarnings(
        [
          run({ model: GEMINI, candidates: flat(10) }),
          run({ model: OPENAI, candidates: flat(10) }),
        ],
        JUDGE,
      ).map(({ imageModel, images }) => [imageModel, images]),
    ).toEqual([
      [null, 20],
      [GEMINI, 10],
      [OPENAI, 10],
    ]);
    // A second Image Model without a judged image leaves one scope: the same images.
    expect(
      flatJudgeWarnings(
        [
          run({ model: GEMINI, candidates: flat(10) }),
          run({ model: OPENAI, candidates: [refused] }),
        ],
        JUDGE,
      ).map(({ imageModel }) => imageModel),
    ).toEqual([null]);
  });
});
