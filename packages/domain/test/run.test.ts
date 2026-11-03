import { expect, test } from "bun:test";
import { Schema } from "effect";
import {
  DEFAULT_JUDGE,
  DEFAULT_OPTIMIZER,
  DEFAULT_RETRY_POLICY,
  DEFAULT_STOP_RULES,
  DEFAULT_TARGET_LOOK,
  RunRequest,
} from "../src";

const decode = Schema.decodeUnknownSync(RunRequest);
const valid = {
  photos: ["a.jpg"],
  faceChoices: [],
  pins: [],
  targetLook: DEFAULT_TARGET_LOOK,
  budgetUsd: 1,
  candidates: 3,
  lanes: [{ model: "m" }],
  judge: DEFAULT_JUDGE,
  optimizer: DEFAULT_OPTIMIZER,
  stopRules: DEFAULT_STOP_RULES,
};

test("issue #1's defaults: target 8.5, patience 3 Iterations rising by 0.2, at most 8 Iterations; Sonnet 5.5 at medium effort optimizes", () => {
  expect(DEFAULT_STOP_RULES).toEqual({
    targetScore: 8.5,
    patience: 3,
    minImprovement: 0.2,
    maxIterations: 8,
  });
  expect(DEFAULT_OPTIMIZER).toEqual({ model: "anthropic/claude-sonnet-5-5", effort: "medium" });
});

test("a Run's stopping rules are bounded: a 0–10 target, 1–50 Iterations, an improvement above 0", () => {
  const rules = (overrides: object) => ({
    ...valid,
    stopRules: { ...DEFAULT_STOP_RULES, ...overrides },
  });
  for (const ok of [
    { targetScore: 0 },
    { targetScore: 10 },
    { patience: 1, maxIterations: 1 },
    { patience: 50, maxIterations: 50 },
    { minImprovement: 0.01 },
    { minImprovement: 10 },
  ]) {
    expect(decode(rules(ok)).stopRules).toEqual({ ...DEFAULT_STOP_RULES, ...ok });
  }
  for (const bad of [
    { targetScore: -0.1 },
    { targetScore: 10.5 },
    { patience: 0 },
    { patience: 1.5 },
    { maxIterations: 0 },
    { maxIterations: 51 },
    { minImprovement: 0 },
    { minImprovement: 10.1 },
  ]) {
    expect(() => decode(rules(bad))).toThrow();
  }
  expect(() => decode({ ...valid, optimizer: { model: "sonnet", effort: "medium" } })).toThrow(
    "Expected a vendor/model id",
  );
  expect(() => decode({ ...valid, optimizer: { ...DEFAULT_OPTIMIZER, effort: "max" } })).toThrow();
});

test("a Budget is whole micro-dollars, from $0.000001 to $1,000,000", () => {
  for (const budgetUsd of [
    0.000001, 0.07, 0.15, 5, 33279.77243, 66760.220507, 999999.999999, 1000000,
  ]) {
    expect(decode({ ...valid, budgetUsd }).budgetUsd).toBe(budgetUsd);
  }
  for (const budgetUsd of [
    0, 0.0000004, 0.0000005, 0.0000007, 1.0000005, -1, 9007199254.740992, 1e12,
  ]) {
    expect(() => decode({ ...valid, budgetUsd })).toThrow(
      "budgetUsd must be a whole number of micro-dollars",
    );
  }
});

test("two face choices for one photo are rejected", () => {
  expect(() =>
    decode({
      ...valid,
      faceChoices: [
        { photo: 1, face: 1 },
        { photo: 1, face: 2 },
      ],
    }),
  ).toThrow("Two face choices for the same photo");
});

test("a Lane's photos are distinct photos of the Run; its Prompt is not blank and at most 32,000 characters", () => {
  const twoPhotos = { ...valid, photos: ["a.jpg", "b.jpg"] };
  const lane = (fields: object) => ({ ...twoPhotos, lanes: [{ model: "m", ...fields }] });
  expect(decode(lane({ photos: [2], prompt: "x".repeat(32_000) })).lanes[0]).toEqual({
    model: "m",
    photos: [2],
    prompt: "x".repeat(32_000),
  });
  expect(() => decode(lane({ photos: [3] }))).toThrow(
    "A Lane lists photo 3, but the Run has 2 Reference Photos",
  );
  expect(() => decode(lane({ photos: [1, 1] }))).toThrow("A Lane lists the same photo twice");
  expect(() => decode(lane({ photos: [] }))).toThrow();
  for (const prompt of ["", "  \n", "x".repeat(32_001)]) {
    expect(() => decode(lane({ prompt }))).toThrow("A Lane's Prompt must be 1 to 32000 characters");
  }
});

test("transient errors are retried twice, after 1 s then 2 s (issue #1)", () => {
  expect(DEFAULT_RETRY_POLICY).toEqual({ maxRetries: 2, baseDelayMs: 1000 });
});
