import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  byCriterion,
  CRITERIA,
  CURRENT_RUBRIC,
  DEFAULT_WEIGHTS,
  DEFAULT_JUDGE,
  DEFAULT_TARGET_LOOK,
  isDisputed,
  Judgement,
  JUDGED_CRITERIA,
  type JudgeVerdict,
  levelScore,
  RUBRIC_V1,
  RUBRIC_V2,
  RubricWeights,
  RunRequest,
  scoreVerdict,
  weightedTotal,
} from "../src";

/** Decoded as a Run request decodes them: no special parse options. */
const decodeRubricWeights = Schema.decodeUnknownSync(RubricWeights);

describe("level mapping", () => {
  test("maps the anchored levels 1–5 linearly onto 0–10", () => {
    expect([1, 2, 3, 4, 5].map(levelScore)).toEqual([0, 2.5, 5, 7.5, 10]);
  });
});

describe("weights", () => {
  test("the defaults are issue #1's and sum to 1", () => {
    expect(decodeRubricWeights(DEFAULT_WEIGHTS)).toEqual({
      likeness: 0.3,
      resemblance: 0.15,
      realism: 0.15,
      pose: 0.1,
      background: 0.08,
      lighting: 0.08,
      hairstyle: 0.07,
      clothing: 0.05,
      framing: 0.02,
    });
  });

  test("reject a sum other than 1, a negative weight, an unknown or a missing criterion", () => {
    expect(() => decodeRubricWeights({ ...DEFAULT_WEIGHTS, likeness: 0.31 })).toThrow(
      "The weights must sum to 1",
    );
    expect(() =>
      decodeRubricWeights({ ...DEFAULT_WEIGHTS, likeness: 0.5, framing: -0.18 }),
    ).toThrow();
    // Sums to 1 with the unknown key left out: it is rejected for the key, not the sum.
    expect(() => decodeRubricWeights({ ...DEFAULT_WEIGHTS, smile: 0 })).toThrow(
      "Unknown criterion smile",
    );
    const { framing: _, ...missing } = DEFAULT_WEIGHTS;
    expect(() => decodeRubricWeights(missing)).toThrow();
  });

  test("accept any non-negative split that sums to 1, including zero weights", () => {
    const allOnLikeness = byCriterion(CRITERIA, (criterion) => (criterion === "likeness" ? 1 : 0));
    expect(decodeRubricWeights(allOnLikeness)).toEqual(allOnLikeness);
  });
});

const levels = (level: 1 | 2 | 3 | 4 | 5): JudgeVerdict["levels"] =>
  byCriterion(JUDGED_CRITERIA, () => level);

describe("weighted total", () => {
  test("is 10 when every criterion scores 10 and 0 when every one scores 0", () => {
    const all = (score: number) => byCriterion(CRITERIA, () => score);
    expect(weightedTotal(all(10), DEFAULT_WEIGHTS)).toBe(10);
    expect(weightedTotal(all(0), DEFAULT_WEIGHTS)).toBe(0);
  });

  test("weighs each criterion by its own weight", () => {
    // Likeness 8 (×0.30) + Resemblance 10 (×0.15) + everything else 5 (×0.55).
    const { scores, weightedTotal: total } = scoreVerdict(
      { levels: { ...levels(3), resemblance: 5 }, issues: [], promptFixes: [] },
      8,
      DEFAULT_WEIGHTS,
      RUBRIC_V1,
    );
    expect(scores).toMatchObject({ likeness: 8, resemblance: 10, realism: 5, framing: 5 });
    expect(total).toBeCloseTo(0.3 * 8 + 0.15 * 10 + 0.55 * 5, 12);
  });
});

describe("Disputed", () => {
  test("only when Likeness and Resemblance differ by strictly more than 4 points, either way", () => {
    expect(isDisputed(10, 6)).toBe(false);
    expect(isDisputed(6, 10)).toBe(false);
    expect(isDisputed(10.001, 6)).toBe(true);
    expect(isDisputed(1.999, 6)).toBe(true);
    expect(isDisputed(7.5, 2.5)).toBe(true);
    expect(isDisputed(2.5, 7.5)).toBe(true);
  });

  test("a scored verdict is Disputed by its Likeness against its Resemblance level", () => {
    const verdict = (resemblance: 1 | 2 | 3 | 4 | 5): JudgeVerdict => ({
      levels: { ...levels(4), resemblance },
      issues: [],
      promptFixes: [],
    });
    // Resemblance level 1 is 0 points; level 3 is 5 points.
    expect(scoreVerdict(verdict(1), 4, DEFAULT_WEIGHTS, RUBRIC_V1).disputed).toBe(false);
    expect(scoreVerdict(verdict(1), 4.01, DEFAULT_WEIGHTS, RUBRIC_V1).disputed).toBe(true);
    expect(scoreVerdict(verdict(3), 9, DEFAULT_WEIGHTS, RUBRIC_V1).disputed).toBe(false);
    expect(scoreVerdict(verdict(3), 0.5, DEFAULT_WEIGHTS, RUBRIC_V1).disputed).toBe(true);
  });
});

test("a scored verdict records its Rubric version, levels, issues and fixes", () => {
  const judged = scoreVerdict(
    { levels: levels(5), issues: ["Left ear is blurred"], promptFixes: ["Keep both ears sharp"] },
    10,
    DEFAULT_WEIGHTS,
    RUBRIC_V1,
  );
  expect(judged).toMatchObject({
    _tag: "Judged",
    rubricVersion: "rubric-v1",
    levels: levels(5),
    issues: ["Left ear is blurred"],
    promptFixes: ["Keep both ears sharp"],
    disputed: false,
  });
  expect(judged.weightedTotal).toBeCloseTo(10, 12);
});

test("every Rubric anchors all five levels of every judged criterion", () => {
  for (const rubric of [RUBRIC_V1, RUBRIC_V2]) {
    for (const criterion of JUDGED_CRITERIA) {
      const { anchors } = rubric.criteria[criterion];
      expect(anchors).toHaveLength(5);
      expect(new Set(anchors).size).toBe(5);
    }
  }
});

describe("Rubric v2", () => {
  test("judges new Runs and keeps v1's facet criteria", () => {
    expect(CURRENT_RUBRIC).toBe(RUBRIC_V2);
    for (const criterion of JUDGED_CRITERIA) {
      if (criterion !== "resemblance" && criterion !== "realism") {
        expect(RUBRIC_V2.criteria[criterion]).toBe(RUBRIC_V1.criteria[criterion]);
      }
    }
  });

  test("Resemblance counts apparent age either way and retouching beyond the facet as differences, retouching within it not", () => {
    const { question, anchors } = RUBRIC_V2.criteria.resemblance;
    expect(question).toContain("neither older nor younger");
    expect(question).toContain(
      "Retouching within what the Target Look's retouching allows is not a difference; retouching beyond it (e.g. any smoothing or whitening when it says none)",
    );
    expect(anchors[2]).toContain("clearly older or younger, e.g. obviously younger skin");
    expect(anchors[2]).toContain(
      "clear retouching beyond what the Target Look's retouching allows",
    );
    expect(anchors[3]).toContain(
      "slight retouching beyond what the Target Look's retouching allows",
    );
    expect(anchors[3]).not.toContain("idealised or smoothed");
  });

  test("Realism asks for a real professional photograph and names over-editing an artefact", () => {
    const { question, anchors } = RUBRIC_V2.criteria.realism;
    expect(question).toContain("real professional photograph");
    expect(question).not.toContain("unedited");
    expect(question).toContain("over-editing is an artefact");
    for (const sign of ["fake-white or uniform teeth", "airbrushed skin", "younger-looking face"]) {
      expect(question).toContain(sign);
    }
    expect(anchors[2]).toContain("fake-white or uniform teeth");
  });

  test("a verdict judged with it records rubric-v2, and both versions' judgements read back", () => {
    const decode = Schema.decodeUnknownSync(Judgement);
    const verdict = { levels: levels(4), issues: [], promptFixes: [] };
    const v2 = scoreVerdict(verdict, 7, DEFAULT_WEIGHTS, CURRENT_RUBRIC);
    expect(v2.rubricVersion).toBe("rubric-v2");
    expect(decode(v2)).toEqual(v2);
    const v1 = scoreVerdict(verdict, 7, DEFAULT_WEIGHTS, RUBRIC_V1);
    expect(decode(v1)).toEqual(v1);
    expect(() => decode({ ...v1, disputed: true })).toThrow("don't follow from the levels");
  });
});

test("a stored Judged whose scores or Disputed flag don't follow from its levels is rejected", () => {
  const decode = Schema.decodeUnknownSync(Judgement);
  const judged = scoreVerdict(
    { levels: levels(4), issues: [], promptFixes: [] },
    7,
    DEFAULT_WEIGHTS,
    RUBRIC_V1,
  );
  expect(decode(judged)).toEqual(judged);
  expect(() => decode({ ...judged, scores: { ...judged.scores, realism: 10 } })).toThrow(
    "don't follow from the levels",
  );
  expect(() => decode({ ...judged, disputed: true })).toThrow("don't follow from the levels");
});

test("a Run request's weights are strict too: an unknown criterion fails the request", () => {
  const request = {
    photos: ["a.jpg"],
    faceChoices: [],
    pins: [],
    targetLook: DEFAULT_TARGET_LOOK,
    budgetUsd: 1,
    candidates: 1,
    lanes: [{ model: "m" }],
    judge: { ...DEFAULT_JUDGE, weights: { ...DEFAULT_WEIGHTS, smile: 0 } },
  };
  expect(() => Schema.decodeUnknownSync(RunRequest)(request)).toThrow("Unknown criterion smile");
});

test("weights summing to 1 within the tolerance can't push a total past 10", () => {
  const weights = { ...DEFAULT_WEIGHTS, likeness: 0.3 + 9e-10 };
  expect(decodeRubricWeights(weights)).toEqual(weights);
  const all = byCriterion(CRITERIA, () => 10);
  expect(weightedTotal(all, weights)).toBe(10);
});

test("a stored total outside 0–10 or an unknown Rubric version is rejected", () => {
  const decode = Schema.decodeUnknownSync(Judgement);
  const judged = scoreVerdict(
    { levels: levels(4), issues: [], promptFixes: [] },
    7,
    DEFAULT_WEIGHTS,
    RUBRIC_V1,
  );
  expect(() => decode({ ...judged, weightedTotal: 10.5 })).toThrow();
  // A version this build has no rules for can't be checked, so it can't be read as scored.
  expect(() => decode({ ...judged, rubricVersion: "rubric-v0" })).toThrow();
});

test("a stored judgement's Rubric version is checked on both outcomes, and Disputed by its exact gap", () => {
  const decode = Schema.decodeUnknownSync(Judgement);
  expect(() =>
    decode({ _tag: "JudgeFailed", rubricVersion: "rubric-v0", cause: "failed", reason: "x" }),
  ).toThrow();
  // Likeness 4 against Resemblance 0 (level 1) differ by exactly 4: not Disputed.
  const atGap = scoreVerdict(
    { levels: { ...levels(4), resemblance: 1 }, issues: [], promptFixes: [] },
    4,
    DEFAULT_WEIGHTS,
    RUBRIC_V1,
  );
  expect(atGap.disputed).toBe(false);
  expect(decode(atGap)).toEqual(atGap);
  expect(() => decode({ ...atGap, disputed: true })).toThrow("don't follow from the levels");
});
