import { describe, expect, test } from "bun:test";
import {
  analysePairs,
  analysePairSet,
  type CalibrationSubject,
  calibrationWarnings,
  CANDIDATE_THRESHOLDS,
  calibrationPairs,
  ceilingSuggestion,
  checkCalibrationSubjects,
  distribution,
  type Embedding,
  equalErrorRate,
  errorRates,
  quantile,
  suggestThreshold,
} from "../src";

/** A unit vector at `degrees` in the plane of the first two axes, padded to 4-d. */
const at = (degrees: number): Embedding => {
  const radians = (degrees * Math.PI) / 180;
  return [Math.cos(radians), Math.sin(radians), 0, 0];
};
const cos = (degrees: number) => Math.cos((degrees * Math.PI) / 180);

describe("quantile", () => {
  test("interpolates linearly between order statistics, in any input order", () => {
    const values = [40, 10, 30, 20];
    expect(quantile(values, 0)).toBe(10);
    expect(quantile(values, 1)).toBe(40);
    expect(quantile(values, 0.5)).toBe(25);
    // Position (4 - 1) × 0.25 = 0.75: between 10 and 20.
    expect(quantile(values, 0.25)).toBeCloseTo(17.5, 12);
    expect(quantile(values, 0.05)).toBeCloseTo(11.5, 12);
  });

  test("handles one value and ties", () => {
    expect(quantile([0.7], 0.05)).toBe(0.7);
    expect(quantile([0.7], 0.95)).toBe(0.7);
    expect(quantile([0.5, 0.5, 0.5, 0.9], 0.5)).toBe(0.5);
    expect(quantile([0.5, 0.5, 0.5, 0.9], 0.75)).toBeCloseTo(0.6, 12);
  });

  test("rejects no values and p outside [0, 1]", () => {
    expect(() => quantile([], 0.5)).toThrow("at least one value");
    expect(() => quantile([1], 1.5)).toThrow("[0, 1]");
    expect(() => quantile([1], Number.NaN)).toThrow("[0, 1]");
  });
});

describe("distribution", () => {
  test("summarises count, extremes, median and quantiles", () => {
    const values = Array.from({ length: 21 }, (_, index) => index / 20);
    expect(distribution(values)).toEqual({
      count: 21,
      min: 0,
      p05: expect.closeTo(0.05, 12),
      p25: expect.closeTo(0.25, 12),
      median: 0.5,
      p75: expect.closeTo(0.75, 12),
      p95: expect.closeTo(0.95, 12),
      max: 1,
    });
  });

  test("is null without values", () => {
    expect(distribution([])).toBeNull();
  });
});

describe("error rates", () => {
  const pairs = { same: [0.5, 0.6, 0.7, 0.8], different: [0.1, 0.3, 0.5, 0.6] };

  test("accept a pair whose similarity reaches the threshold", () => {
    // At 0.5: different 0.5 and 0.6 are falsely accepted; no same pair is below.
    expect(errorRates(pairs, 0.5)).toEqual({ threshold: 0.5, far: 0.5, frr: 0 });
    expect(errorRates(pairs, 0.65)).toEqual({ threshold: 0.65, far: 0, frr: 0.5 });
  });

  test("are null for a side without pairs", () => {
    expect(errorRates({ same: [], different: [0.2] }, 0.4)).toEqual({
      threshold: 0.4,
      far: 0,
      frr: null,
    });
  });
});

describe("threshold suggestion", () => {
  test("is the lowest 0.01 step just above the highest different pair when the target is 0", () => {
    const pairs = { same: [0.6, 0.7, 0.8], different: [0.1, 0.2, 0.3] };
    expect(suggestThreshold(pairs, 0)).toEqual({ threshold: 0.31, far: 0, frr: 0 });
  });

  test("lies above a different pair exactly on the grid, since the Gate accepts equality", () => {
    expect(suggestThreshold({ same: [], different: [0.29] }, 0)?.threshold).toBe(0.3);
  });

  test("allows the target share of different pairs, counted without rounding loss", () => {
    // 100 different pairs at 0.00, 0.01, …, 0.99; a 29% target allows the top 29.
    const different = Array.from({ length: 100 }, (_, index) => index / 100);
    expect(suggestThreshold({ same: [], different }, 0.29)).toEqual({
      threshold: 0.71,
      far: 0.29,
      frr: null,
    });
    // 1% of 50 pairs rounds down to none.
    expect(suggestThreshold({ same: [], different: different.slice(0, 50) }, 0.01)?.far).toBe(0);
  });

  test("reports the FRR it costs when the sets overlap", () => {
    const pairs = { same: [0.3, 0.5, 0.7, 0.9], different: [0.1, 0.2, 0.6] };
    // 0.61 rejects same 0.3 and 0.5.
    expect(suggestThreshold(pairs, 0)).toEqual({ threshold: 0.61, far: 0, frr: 0.5 });
  });

  test("is null when even 1 accepts too many different pairs", () => {
    expect(suggestThreshold({ same: [], different: [1, 1] }, 0)).toBeNull();
  });

  test("rejects no different pairs and a target outside [0, 1)", () => {
    expect(() => suggestThreshold({ same: [0.8], different: [] }, 0.01)).toThrow(
      "needs different-person pairs",
    );
    expect(() => suggestThreshold({ same: [], different: [0.1] }, 1)).toThrow("[0, 1)");
    expect(() => suggestThreshold({ same: [], different: [0.1] }, -0.1)).toThrow("[0, 1)");
  });
});

describe("equal error rate", () => {
  test("is the middle of the gap when the sets are perfectly separated", () => {
    const eer = equalErrorRate({ same: [0.7, 0.8], different: [0.1, 0.3] });
    // FAR = FRR = 0 from 0.31 to 0.70; the middle of those 40 steps is 0.50.
    expect(eer).toEqual({ threshold: 0.5, far: 0, frr: 0 });
  });

  test("balances FAR and FRR when the sets overlap", () => {
    const eer = equalErrorRate({ same: [0.4, 0.6, 0.8, 0.9], different: [0.1, 0.2, 0.5, 0.7] });
    // From 0.61 to 0.70: different 0.7 accepted (FAR 1/4), same 0.4 and 0.6 rejected (FRR 2/4);
    // from 0.41 to 0.50: FAR 2/4, FRR 1/4; in between (0.51 to 0.60) both are 1/4.
    expect(eer).toEqual({ threshold: 0.55, far: 0.25, frr: 0.25 });
  });

  test("takes the lower middle across the tie regions either side of a jump over zero", () => {
    // 0.31–0.50: FAR 1, FRR 1/2; 0.51–0.70: FAR 0, FRR 1/2; both |FAR − FRR| = 1/2, 40 steps.
    expect(equalErrorRate({ same: [0.3, 0.7], different: [0.5] })).toEqual({
      threshold: 0.5,
      far: 1,
      frr: 0.5,
    });
  });

  test("is null unless both sides have pairs", () => {
    expect(equalErrorRate({ same: [], different: [0.1] })).toBeNull();
    expect(equalErrorRate({ same: [0.8], different: [] })).toBeNull();
  });
});

describe("pair set analysis", () => {
  test("tabulates the candidate thresholds and configured values, ascending and once each", () => {
    const analysis = analysePairSet(
      { same: [0.7], different: [0.1] },
      { targetFar: 0.01, configured: [0.4, 0.42], suggest: true },
    );
    const thresholds = analysis.rates.map(({ threshold }) => threshold);
    expect(thresholds).toEqual([...CANDIDATE_THRESHOLDS, 0.42].sort((a, b) => a - b));
    expect(thresholds[0]).toBe(0.2);
    expect(thresholds.at(-1)).toBe(0.9);
  });

  test("warns about small samples and an unresolvable FAR target", () => {
    const analysis = analysePairSet(
      { same: [0.7, 0.8], different: [0.1, 0.2, 0.3] },
      { targetFar: 0.01, configured: [], suggest: true },
    );
    expect(analysis.warnings).toEqual([
      "Only 2 same-person pairs (fewer than 30)",
      "Only 3 different-person pairs (fewer than 30)",
      "Only 3 different-person pairs: a FAR of 0.01 needs at least 100 to be resolved",
    ]);
    expect(analysis.suggestion).toEqual({ threshold: 0.31, far: 0, frr: 0 });
  });

  test("has no suggestion without different pairs, and warns when none reaches the target", () => {
    const likeOnly = analysePairSet(
      { same: [0.7], different: [] },
      { targetFar: 0.01, configured: [], suggest: true },
    );
    expect(likeOnly).not.toHaveProperty("suggestion");
    expect(likeOnly.different).toBeNull();
    const identical = analysePairSet(
      { same: [], different: [1] },
      { targetFar: 0, configured: [], suggest: true },
    );
    expect(identical.suggestion).toBeNull();
    // A target FAR of 0 needs no minimum number of pairs to be resolved.
    expect(identical.warnings).toEqual([
      "Only 0 same-person pairs (fewer than 30)",
      "Only 1 different-person pairs (fewer than 30)",
      "No threshold up to 1 reaches the target FAR of 0",
    ]);
  });

  test("gives context sets only distributions, rates and sample-size warnings", () => {
    const context = analysePairSet(
      { same: [0.7, 0.8], different: [0.1, 0.2, 0.3] },
      { targetFar: 0.01, configured: [], suggest: false },
    );
    expect(context).not.toHaveProperty("suggestion");
    expect(context).not.toHaveProperty("equalErrorRate");
    expect(context.same?.count).toBe(2);
    expect(context.rates).toHaveLength(CANDIDATE_THRESHOLDS.length);
    expect(context.warnings).toEqual([
      "Only 2 same-person pairs (fewer than 30)",
      "Only 3 different-person pairs (fewer than 30)",
    ]);
  });
});

describe("calibration pairs", () => {
  const subjects = [
    { name: "ada", photos: [at(0), at(20), at(40)], like: [at(10)], unlike: [at(90)] },
    { name: "bob", photos: [at(120)], like: [], unlike: [] },
  ];
  const fixed = (values: readonly number[]) => values.map((value) => value.toFixed(9));

  test("pairs real photos within a Subject as same and across Subjects as different", () => {
    const { real } = calibrationPairs(subjects);
    expect(fixed(real.same)).toEqual(fixed([cos(20), cos(40), cos(20)]));
    expect(fixed(real.different)).toEqual(fixed([cos(120), cos(100), cos(80)]));
  });

  test("pairs each real photo with its Subject's leave-one-out anchor and other Subjects' anchors", () => {
    const { realAnchor } = calibrationPairs(subjects);
    // 0° against the anchor of 20° and 40° (30°), 20° against 0° and 40° (20°), 40° against 0° and 20° (10°).
    // Bob has one photo, so no same-person anchor pair.
    expect(fixed(realAnchor.same)).toEqual(fixed([cos(30), 1, cos(30)]));
    // Ada's photos against Bob's anchor (120°), then Bob's photo against Ada's full anchor (20°).
    expect(fixed(realAnchor.different)).toEqual(fixed([cos(120), cos(100), cos(80), cos(100)]));
  });

  test("counts each anchor pair that is one photo pair once", () => {
    // A 2-photo Subject's two leave-one-out values are the same pair; so are two 1-photo
    // Subjects against each other's anchor.
    // A 1-photo Subject comes first, so multi-photo Subjects after it still pair with its anchor.
    const { realAnchor } = calibrationPairs([
      { name: "aa", photos: [at(200)], like: [], unlike: [] },
      { name: "ada", photos: [at(0), at(30)], like: [], unlike: [] },
      { name: "bob", photos: [at(100), at(160)], like: [], unlike: [] },
      { name: "dee", photos: [at(250)], like: [], unlike: [] },
    ]);
    expect(fixed(realAnchor.same)).toEqual(fixed([cos(30), cos(60)]));
    // aa against ada, bob, dee; ada: 2 photos × 3 other anchors; bob: 2 × 3; dee against ada, bob.
    expect(realAnchor.different).toHaveLength(3 + 6 + 6 + 2);
    expect(
      realAnchor.different.filter((value) => value.toFixed(9) === cos(50).toFixed(9)),
    ).toHaveLength(1);
  });

  test("warns about too few anchor pairs when every Subject has 2 photos", () => {
    const pairs = calibrationPairs(
      Array.from({ length: 15 }, (_, index) => ({
        name: `s${index}`,
        photos: [at(index * 20), at(index * 20 + 5)],
        like: [],
        unlike: [],
      })),
    );
    expect(pairs.realAnchor.same).toHaveLength(15);
    expect(analysePairs(pairs, { targetFar: 0.01, configured: [] }).realAnchor.warnings).toContain(
      "Only 15 same-person pairs (fewer than 30)",
    );
  });

  test("pairs Candidates only with their own Subject, per photo and against the anchor", () => {
    const { candidatePhoto, candidateAnchor } = calibrationPairs(subjects);
    expect(fixed(candidatePhoto.same)).toEqual(fixed([cos(10), cos(10), cos(30)]));
    expect(fixed(candidatePhoto.different)).toEqual(fixed([cos(90), cos(70), cos(50)]));
    // The anchor of 0°, 20° and 40° points at 20°.
    expect(fixed(candidateAnchor.same)).toEqual(fixed([cos(10)]));
    expect(fixed(candidateAnchor.different)).toEqual(fixed([cos(70)]));
  });

  test("leaves the Candidates of a Subject without usable photos unpaired", () => {
    const pairs = calibrationPairs([
      { name: "ada", photos: [], like: [at(0)], unlike: [at(90)] },
      { name: "bob", photos: [at(0), at(10)], like: [], unlike: [] },
      { name: "cy", photos: [at(100)], like: [], unlike: [] },
    ]);
    expect(pairs.candidatePhoto).toEqual({ same: [], different: [] });
    expect(pairs.candidateAnchor).toEqual({ same: [], different: [] });
    expect(pairs.real.different).toHaveLength(2);
  });

  test("needs 2 Subjects with photos and one with at least 2", () => {
    const subject = (photos: number) => ({ photos: Array.from({ length: photos }) });
    expect(() => checkCalibrationSubjects([subject(2), subject(1)])).not.toThrow();
    expect(() => checkCalibrationSubjects([subject(3)])).toThrow("at least 2 Subjects");
    expect(() => checkCalibrationSubjects([subject(3), subject(0)])).toThrow("at least 2 Subjects");
    expect(() => checkCalibrationSubjects([subject(1), subject(1)])).toThrow(
      "at least 2 real photos of one Subject",
    );
    const lonely = [{ name: "ada", photos: [at(0), at(10)], like: [], unlike: [] }];
    expect(() => calibrationPairs(lonely)).toThrow("at least 2 Subjects");
    expect(() => ceilingSuggestion(lonely)).toThrow("at least 2 Subjects");
  });

  test("analyses the anchor sets first, with suggestions, and the Candidate sets only with pairs", () => {
    const options = { targetFar: 0.01, configured: [] };
    const without = analysePairs(
      calibrationPairs([subjects[1]!, { ...subjects[0]!, like: [], unlike: [] }]),
      options,
    );
    expect(Object.keys(without)).toEqual(["realAnchor", "real"]);
    const withCandidates = analysePairs(calibrationPairs(subjects), options);
    expect(Object.keys(withCandidates)).toEqual([
      "realAnchor",
      "candidateAnchor",
      "real",
      "candidatePhoto",
    ]);
    for (const set of ["real", "candidatePhoto"] as const) {
      expect(Object.keys(withCandidates[set]!)).toEqual(["same", "different", "rates", "warnings"]);
    }
    expect(Object.keys(withCandidates.realAnchor)).toEqual([
      "same",
      "different",
      "rates",
      "suggestion",
      "equalErrorRate",
      "warnings",
    ]);
    expect(withCandidates.realAnchor).toHaveProperty("suggestion");
    expect(withCandidates.candidateAnchor).toHaveProperty("equalErrorRate");
    expect(withCandidates.real).not.toHaveProperty("suggestion");
    expect(withCandidates.candidatePhoto).not.toHaveProperty("equalErrorRate");
  });
});

describe("Ceiling suggestion", () => {
  test("gives each Subject with two or more photos its own median pair as Ceiling", () => {
    const ceiling = ceilingSuggestion([
      { name: "ada", photos: [at(0), at(20), at(40)], like: [], unlike: [] },
      { name: "bob", photos: [at(120)], like: [], unlike: [] },
      { name: "cy", photos: [at(200), at(260)], like: [], unlike: [] },
    ]);
    expect(ceiling.subjects).toEqual([
      { name: "ada", value: expect.closeTo(cos(20), 12), pairs: 3 },
      { name: "cy", value: expect.closeTo(cos(60), 12), pairs: 1 },
    ]);
    expect(ceiling.suggested).toBeCloseTo((cos(20) + cos(60)) / 2, 12);
    // Same pairs: cos 20, cos 40, cos 20 (ada) and cos 60 (cy).
    expect(ceiling.pooledMedian).toBeCloseTo((cos(20) + cos(40)) / 2, 12);
  });

  test("is the median of the Subjects' Ceilings, so one Subject with many photos can't decide it", () => {
    const ceiling = ceilingSuggestion([
      { name: "many", photos: [0, 1, 2, 3, 4].map(at), like: [], unlike: [] },
      { name: "a", photos: [at(100), at(160)], like: [], unlike: [] },
      { name: "b", photos: [at(200), at(270)], like: [], unlike: [] },
      { name: "c", photos: [at(280), at(360)], like: [], unlike: [] },
    ]);
    expect(ceiling.suggested).toBeCloseTo((cos(60) + cos(70)) / 2, 12);
    // 10 of the 13 same-person pairs belong to "many".
    expect(ceiling.pooledMedian).toBeGreaterThan(cos(4));
  });
});

describe("calibration warnings", () => {
  const configured = { identityGate: 0.4, singlePhotoCeiling: 0.6 };
  const warningsFor = (
    subjects: CalibrationSubject[],
    thresholds: { identityGate: number; singlePhotoCeiling: number } = configured,
  ) => {
    const pairs = calibrationPairs(subjects);
    return calibrationWarnings({
      subjects,
      ceiling: ceilingSuggestion(subjects),
      analysis: analysePairs(pairs, { targetFar: 0, configured: [] }),
      configured: thresholds,
    });
  };
  const rule = "the single-photo Ceiling must be at least the Identity Gate";

  test("are empty for agreeing Subjects with a Ceiling above every Gate", () => {
    expect(
      warningsFor([
        { name: "ada", photos: [at(0), at(10)], like: [], unlike: [] },
        { name: "bob", photos: [at(120), at(130)], like: [], unlike: [] },
      ]),
    ).toEqual([]);
  });

  test("name unpaired Candidates, and Subjects with more than 8 photos but not with 8", () => {
    const photos = (count: number) => Array.from({ length: count }, (_, index) => at(index));
    const warnings = warningsFor([
      { name: "ada", photos: [], like: [at(0)], unlike: [] },
      { name: "bob", photos: photos(9), like: [], unlike: [] },
      { name: "cy", photos: photos(8).map((_, index) => at(120 + index)), like: [], unlike: [] },
    ]);
    expect(warnings).toEqual([
      "Subject ada has no real photo with one face, so its Candidates are left unpaired",
      "Subject bob has 9 photos, more than the 8 a Run takes: its anchor similarities run higher than a Run's",
    ]);
  });

  test("compare strictly at the boundaries", () => {
    const subjects = [
      { name: "ada", photos: [at(0), at(10)], like: [], unlike: [] },
      { name: "bob", photos: [at(120), at(130)], like: [], unlike: [] },
    ];
    const analysis = analysePairs(calibrationPairs(subjects), { targetFar: 0, configured: [] });
    // A suggested Ceiling exactly at the suggested Gate: no warning.
    const gate = analysis.realAnchor.suggestion!.threshold;
    expect(
      calibrationWarnings({
        subjects,
        ceiling: { suggested: gate, pooledMedian: gate, subjects: [] },
        analysis,
        configured: { identityGate: -1, singlePhotoCeiling: 1 },
      }),
    ).toEqual([]);
    // Exactly 0.05 apart, and a Ceiling exactly at the configured Gate: no warning.
    expect(0.1 - 0.05).toBe(0.05);
    expect(
      calibrationWarnings({
        subjects,
        ceiling: { suggested: 0.1, pooledMedian: 0.05, subjects: [] },
        analysis,
        configured: { identityGate: 0.1, singlePhotoCeiling: 1 },
      }),
    ).toEqual([]);
  });

  test("flag a suggested Ceiling far from the pooled median", () => {
    const warnings = warningsFor([
      { name: "many", photos: [0, 1, 2, 3, 4].map(at), like: [], unlike: [] },
      { name: "a", photos: [at(100), at(160)], like: [], unlike: [] },
      { name: "b", photos: [at(200), at(270)], like: [], unlike: [] },
    ]);
    const { suggested, pooledMedian } = ceilingSuggestion([
      { name: "many", photos: [0, 1, 2, 3, 4].map(at), like: [], unlike: [] },
      { name: "a", photos: [at(100), at(160)], like: [], unlike: [] },
      { name: "b", photos: [at(200), at(270)], like: [], unlike: [] },
    ]);
    expect(warnings).toContain(
      `The suggested Ceiling ${suggested} (median of the Subjects' Ceilings) and the pooled median ${pooledMedian} differ by more than 0.05: Subjects disagree, or one with many photos dominates the pooled pairs`,
    );
  });

  test("flag a suggested Ceiling below a suggested Gate, from realAnchor and from candidateAnchor", () => {
    // Ceilings cos 60 and cos 80 (median ≈ 0.34); the Subjects lie 5° apart, so separating them
    // needs a Gate above the Ceiling; an unlike Candidate next to ada's anchor does the same.
    const subjects = [
      { name: "ada", photos: [at(0), at(60)], like: [], unlike: [at(31)] },
      { name: "bob", photos: [at(5), at(85)], like: [], unlike: [] },
    ];
    const pairs = calibrationPairs(subjects);
    const analysis = analysePairs(pairs, { targetFar: 0, configured: [] });
    const ceiling = ceilingSuggestion(subjects);
    const realGate = analysis.realAnchor.suggestion!.threshold;
    const candidateGate = analysis.candidateAnchor!.suggestion!.threshold;
    const warnings = calibrationWarnings({
      subjects,
      ceiling,
      analysis,
      configured: { identityGate: 0.2, singlePhotoCeiling: 1 },
    });
    expect(warnings).toEqual([
      `The suggested Ceiling ${ceiling.suggested} lies below the Identity Gate suggested by realAnchor (${realGate}); ${rule}`,
      `The suggested Ceiling ${ceiling.suggested} lies below the Identity Gate suggested by candidateAnchor (${candidateGate}); ${rule}`,
    ]);
  });

  test("flag a suggested Gate above the configured Ceiling and a suggested Ceiling below the configured Gate", () => {
    const subjects = [
      { name: "ada", photos: [at(0), at(10)], like: [], unlike: [at(1)] },
      { name: "bob", photos: [at(120), at(130)], like: [], unlike: [] },
    ];
    const pairs = calibrationPairs(subjects);
    const analysis = analysePairs(pairs, { targetFar: 0, configured: [] });
    const ceiling = ceilingSuggestion(subjects);
    const candidateGate = analysis.candidateAnchor!.suggestion!.threshold;
    // ada's Ceiling is cos 10 ≈ 0.985; the unlike Candidate 4° off ada's anchor pushes its Gate to 1.
    const warnings = calibrationWarnings({
      subjects,
      ceiling,
      analysis,
      configured: { identityGate: 0.99, singlePhotoCeiling: 0.995 },
    });
    expect(warnings).toEqual([
      `The suggested Ceiling ${ceiling.suggested} lies below the Identity Gate suggested by candidateAnchor (${candidateGate}); ${rule}`,
      `The Identity Gate suggested by candidateAnchor (${candidateGate}) lies above the configured single-photo Ceiling (0.995); ${rule}`,
      `The suggested Ceiling ${ceiling.suggested} lies below the configured Identity Gate (0.99); ${rule}`,
    ]);
  });
});
