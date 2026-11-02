import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { CandidateOutcome, type Embedding, likeness, scoreCandidate } from "../src";

const scale = { gate: 0.4, ceiling: 0.6 };

/** A unit vector at `degrees` in the plane of the first two axes. */
const at = (degrees: number): Embedding => {
  const radians = (degrees * Math.PI) / 180;
  return [Math.cos(radians), Math.sin(radians), 0];
};
/** The angle whose cosine to `at(0)` is `similarity`. */
const withSimilarity = (similarity: number) => at((Math.acos(similarity) * 180) / Math.PI);

describe("Likeness", () => {
  test("is 0 at the Gate, 10 at the Ceiling and linear between", () => {
    expect(likeness(0.4, scale)).toBeCloseTo(0, 10);
    expect(likeness(0.6, scale)).toBeCloseTo(10, 10);
    expect(likeness(0.5, scale)).toBeCloseTo(5, 10);
    expect(likeness(0.45, scale)).toBeCloseTo(2.5, 10);
  });

  test("is clamped below the Gate and above the Ceiling", () => {
    expect(likeness(0.1, scale)).toBe(0);
    expect(likeness(-1, scale)).toBe(0);
    expect(likeness(0.9, scale)).toBe(10);
    expect(likeness(1, scale)).toBe(10);
  });

  test("with the Ceiling at or below the Gate, reaching the Gate is already perfect", () => {
    for (const ceiling of [0.4, 0.33]) {
      const flat = { gate: 0.4, ceiling };
      expect(likeness(0.4, flat)).toBe(10);
      expect(likeness(0.7, flat)).toBe(10);
      expect(likeness(0.39, flat)).toBe(0);
    }
  });
});

describe("Candidate Outcome from the faces found", () => {
  const anchor = at(0);
  const decode = Schema.decodeUnknownSync(CandidateOutcome);

  test("no face is Gated with no similarity", () => {
    expect(scoreCandidate([], anchor, scale)).toEqual({
      _tag: "Gated",
      reason: "no-face",
      similarity: null,
    });
  });

  test("a face below the Gate is Gated with its similarity", () => {
    const outcome = scoreCandidate([withSimilarity(0.3)], anchor, scale);
    expect(outcome).toEqual({
      _tag: "Gated",
      reason: "below-gate",
      similarity: expect.closeTo(0.3, 10),
    });
  });

  test("a face at the Gate is Scored with Likeness 0", () => {
    const outcome = scoreCandidate([withSimilarity(0.4)], anchor, scale);
    expect(outcome._tag).toBe("Scored");
    expect(outcome._tag === "Scored" && outcome.likeness).toBeCloseTo(0, 6);
  });

  test("with several faces, the best match to the anchor counts", () => {
    const outcome = scoreCandidate([withSimilarity(0.1), withSimilarity(0.5)], anchor, scale);
    expect(outcome).toEqual({
      _tag: "Scored",
      similarity: expect.closeTo(0.5, 10),
      likeness: expect.closeTo(5, 10),
    });
  });

  test("a face whose embedding can't be compared (zero, NaN, Infinity) fails the Candidate, not the Run", () => {
    for (const embedding of [
      [0, 0, 0],
      [Number.NaN, 1, 0],
      [Number.POSITIVE_INFINITY, 1, 0],
    ]) {
      expect(scoreCandidate([embedding], anchor, scale)).toMatchObject({
        _tag: "Failed",
        reason: expect.stringContaining("couldn't be compared"),
      });
    }
  });

  test("an identical face stays a valid outcome despite rounding", () => {
    const outcome = scoreCandidate([[0.1, 0.2, 0.3]], [0.1, 0.2, 0.3], scale);
    expect(decode(outcome)).toEqual({
      _tag: "Scored",
      similarity: expect.closeTo(1, 10),
      likeness: 10,
    });
  });
});
