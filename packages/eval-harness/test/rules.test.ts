import { expect, test } from "bun:test";
import { DEFAULT_STOP_RULES, DEFAULT_WEIGHTS, MAX_ITERATIONS } from "@iconograph/domain";
import { armStopRules } from "../src/evaluate";
import { judgeOnlyWeights } from "../src/scoring";

test("the Resample Arm's patience is above its Iteration limit, or at the largest limit at it", () => {
  const rules = { ...DEFAULT_STOP_RULES, maxIterations: 8, patience: 3 };
  expect(armStopRules(rules)).toEqual({ optimizer: rules, resample: { ...rules, patience: 9 } });
  const longest = { ...rules, maxIterations: MAX_ITERATIONS };
  expect(armStopRules(longest).resample.patience).toBe(MAX_ITERATIONS);
});

test("the second Judge's weights leave Likeness out and still sum to 1; all on Likeness is an error", () => {
  const weights = judgeOnlyWeights(DEFAULT_WEIGHTS);
  expect(weights.likeness).toBe(0);
  expect(Object.values(weights).reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 12);
  expect(weights.resemblance).toBeCloseTo(DEFAULT_WEIGHTS.resemblance / 0.7, 12);
  const likenessOnly = { ...weights, resemblance: 0, likeness: 1 };
  expect(() => judgeOnlyWeights(likenessOnly)).toThrow("has nothing to score");
});
