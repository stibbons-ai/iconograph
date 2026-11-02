import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  CharacterReferenceError,
  type DetectedFace,
  type Embedding,
  frontality,
  type ReferenceCandidate,
  selectCharacterReferences,
} from "../src";

/** A face of `size` px whose nose sits `turn` eye distances right of centre (0 = frontal). */
const faceOf = (size: number, turn = 0): DetectedFace => {
  const eye = size / 3;
  return {
    box: { x: 0, y: 0, width: size, height: size },
    landmarks: [
      { x: size / 2 - eye / 2, y: size / 3 },
      { x: size / 2 + eye / 2, y: size / 3 },
      { x: size / 2 + turn * eye, y: size / 2 },
      { x: size / 2 - eye / 3, y: (2 * size) / 3 },
      { x: size / 2 + eye / 3, y: (2 * size) / 3 },
    ],
    score: 0.9,
  };
};
const at = (degrees: number): Embedding => {
  const radians = (degrees * Math.PI) / 180;
  return [Math.cos(radians), Math.sin(radians), 0];
};
const photo = (number: number, face: DetectedFace, degrees: number): ReferenceCandidate => ({
  photo: number,
  face,
  embedding: at(degrees),
});

describe("frontality", () => {
  test("is 1 for a centred nose, falls with the turn, and ignores head tilt", () => {
    expect(frontality(faceOf(300))).toBeCloseTo(1, 10);
    expect(frontality(faceOf(300, 0.25))).toBeCloseTo(0.5, 10);
    expect(frontality(faceOf(300, -0.25))).toBeCloseTo(0.5, 10);
    expect(frontality(faceOf(300, 0.6))).toBe(0);
    // Rotating every landmark by 30° (roll) keeps a frontal face frontal.
    const face = faceOf(300);
    const roll = (Math.PI / 180) * 30;
    const rolled: DetectedFace = {
      ...face,
      landmarks: face.landmarks.map(({ x, y }) => ({
        x: x * Math.cos(roll) - y * Math.sin(roll),
        y: x * Math.sin(roll) + y * Math.cos(roll),
      })) as unknown as DetectedFace["landmarks"],
    };
    expect(frontality(rolled)).toBeCloseTo(1, 10);
  });
});

describe("character reference selection", () => {
  const select = (...args: Parameters<typeof selectCharacterReferences>) =>
    Effect.runSync(selectCharacterReferences(...args));

  test("takes every photo when there are no more than the max", () => {
    const photos = [photo(1, faceOf(200), 0), photo(2, faceOf(300), 20)];
    expect(select(photos, { max: 4 }).sort()).toEqual([1, 2]);
  });

  test("never returns more than the max, starting with the largest frontal face", () => {
    const photos = [
      photo(1, faceOf(200), 0),
      photo(2, faceOf(400), 10),
      photo(3, faceOf(400, 0.3), 20),
      photo(4, faceOf(150), 30),
      photo(5, faceOf(300), 40),
      photo(6, faceOf(250), 50),
    ];
    const chosen = select(photos, { max: 4 });
    expect(chosen).toHaveLength(4);
    expect(chosen[0]).toBe(2); // large and frontal beats equally large but turned (3)
    expect(new Set(chosen).size).toBe(4);
  });

  test("diversity beats near-duplicates of a chosen photo", () => {
    const photos = [
      photo(1, faceOf(400), 0),
      photo(2, faceOf(400), 1), // near-duplicate of 1, same quality
      photo(3, faceOf(250), 45), // smaller, but a different look
    ];
    expect(select(photos, { max: 2 })).toEqual([1, 3]);
  });

  test("is deterministic, independent of input order", () => {
    const photos = [
      photo(1, faceOf(300), 0),
      photo(2, faceOf(300), 30),
      photo(3, faceOf(300), 60),
      photo(4, faceOf(300), 30),
      photo(5, faceOf(300), 90),
    ];
    const chosen = select(photos, { max: 3 });
    expect(select([...photos].reverse(), { max: 3 })).toEqual(chosen);
    // Equal quality: photo 1 wins the first pick on its number, then the farthest, 5.
    expect(chosen.slice(0, 2)).toEqual([1, 5]);
  });

  test("pinned photos are always included first and count against the max", () => {
    const photos = [
      photo(1, faceOf(400), 0),
      photo(2, faceOf(100, 0.4), 5), // small and turned: never picked unpinned
      photo(3, faceOf(300), 60),
      photo(4, faceOf(300), 120),
    ];
    expect(select(photos, { max: 2 })).not.toContain(2);
    const chosen = select(photos, { max: 2, pinned: [2] });
    expect(chosen[0]).toBe(2);
    expect(chosen).toHaveLength(2);
    expect(select(photos, { max: 2, pinned: [4, 2] })).toEqual([4, 2]);
  });

  test("rejects too many pins, unknown pins and repeated pins with a typed error", () => {
    const photos = [1, 2, 3, 4, 5].map((n) => photo(n, faceOf(300), n * 20));
    const reject = (pinned: number[], message: string) => {
      const error = Effect.runSync(
        Effect.flip(selectCharacterReferences(photos, { max: 4, pinned })),
      );
      expect(error).toBeInstanceOf(CharacterReferenceError);
      expect(error.message).toContain(message);
    };
    reject([1, 2, 3, 4, 5], "5 photos pinned");
    reject([9], "Pinned photo 9 is not an accepted Reference Photo");
    reject([2, 2], "Photo 2 is pinned twice");
  });
});
