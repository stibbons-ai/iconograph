import { expect, test } from "bun:test";
import { Schema } from "effect";
import { DEFAULT_RETRY_POLICY, DEFAULT_TARGET_LOOK, RunRequest } from "../src";

const decode = Schema.decodeUnknownSync(RunRequest);
const valid = {
  photos: ["a.jpg"],
  faceChoices: [],
  pins: [],
  targetLook: DEFAULT_TARGET_LOOK,
  budgetUsd: 1,
  candidates: 3,
  lanes: [{ model: "m" }],
};

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

test("transient errors are retried twice, after 1 s then 2 s (issue #1)", () => {
  expect(DEFAULT_RETRY_POLICY).toEqual({ maxRetries: 2, baseDelayMs: 1000 });
});
