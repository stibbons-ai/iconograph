import { describe, expect, test } from "bun:test";
import {
  assessReferencePhotos,
  cosineSimilarity,
  type DetectedFace,
  type Embedding,
  identityAnchor,
  identityCeiling,
  IdentityThresholds,
  normalize,
  type PhotoFaces,
} from "../src";
import { Schema } from "effect";

const thresholds: IdentityThresholds = { identityGate: 0.4, singlePhotoCeiling: 0.65 };

const face: DetectedFace = {
  box: { x: 10, y: 10, width: 50, height: 60 },
  landmarks: [
    { x: 25, y: 30 },
    { x: 45, y: 30 },
    { x: 35, y: 40 },
    { x: 27, y: 55 },
    { x: 43, y: 55 },
  ],
  score: 0.95,
};

/** A unit vector at `degrees` in the plane of the first two axes, padded to 4-d. */
const at = (degrees: number, length = 1): Embedding => {
  const radians = (degrees * Math.PI) / 180;
  return [length * Math.cos(radians), length * Math.sin(radians), 0, 0];
};
const withFace = (embedding: Embedding): PhotoFaces => ({ kind: "face", face, embedding });

describe("Identity Anchor", () => {
  test("is the normalised mean of normalised embeddings, so magnitude doesn't weight a photo", () => {
    const anchor = identityAnchor([at(0, 10), at(90, 0.1)]);
    expect(anchor[0]).toBeCloseTo(Math.SQRT1_2);
    expect(anchor[1]).toBeCloseTo(Math.SQRT1_2);
    expect(Math.hypot(...anchor)).toBeCloseTo(1);
  });

  test("rejects an empty set, zero or non-finite vectors, and mixed lengths", () => {
    expect(() => identityAnchor([])).toThrow();
    expect(() => identityAnchor([[0, 0, 0, 0]])).toThrow();
    expect(() => identityAnchor([[Infinity, 1, 0, 0]])).toThrow();
    expect(() => identityAnchor([[Number.NaN, 1, 0, 0]])).toThrow();
    expect(() =>
      identityAnchor([
        [1, 0, 0],
        [0, 1],
      ]),
    ).toThrow("differ in length");
  });
});

describe("Identity Ceiling", () => {
  test("is the median pairwise similarity for an odd number of pairs", () => {
    // Pairs: 0°–30° = cos 30°, 0°–90° = cos 90°, 30°–90° = cos 60°; median cos 60°.
    expect(identityCeiling([at(0), at(30), at(90)], thresholds)).toEqual({
      value: expect.closeTo(0.5, 10),
      source: "median-pairwise",
    });
  });

  test("averages the middle two for an even number of pairs", () => {
    // Two photos: one pair; four photos: six pairs.
    expect(identityCeiling([at(0), at(60)], thresholds).value).toBeCloseTo(0.5);
    const four = [at(0), at(10), at(20), at(30)];
    // Pair angles: 10,10,10,20,20,30 → middle two are cos 10° and cos 20°.
    expect(identityCeiling(four, thresholds).value).toBeCloseTo(
      (Math.cos(Math.PI / 18) + Math.cos(Math.PI / 9)) / 2,
    );
  });

  test("uses the face model's default for a single photo", () => {
    expect(identityCeiling([at(0)], thresholds)).toEqual({
      value: 0.65,
      source: "single-photo-default",
    });
  });
});

describe("Reference Photo assessment", () => {
  test("rejects photos without a face and asks for a choice when several faces are found", () => {
    const result = assessReferencePhotos(
      [{ kind: "no-face" }, { kind: "several-faces", faces: [face, face] }, withFace(at(0))],
      thresholds,
    );
    expect(result.photos.map((photo) => photo.verdict)).toEqual([
      "rejected",
      "choice-required",
      "accepted",
    ]);
    expect(result.photos[1]).toEqual({ verdict: "choice-required", faces: [face, face] });
    expect(result.identity?.accepted).toEqual([2]);
  });

  test("warns below three accepted photos and not at three", () => {
    const two = assessReferencePhotos([withFace(at(0)), withFace(at(20))], thresholds);
    expect(two.warnings).toEqual([
      "Only 2 accepted Reference Photos; Likeness is less reliable below 3",
    ]);
    const one = assessReferencePhotos([withFace(at(0)), { kind: "no-face" }], thresholds);
    expect(one.warnings).toEqual([
      "Only 1 accepted Reference Photo; Likeness is less reliable below 3",
    ]);
    expect(one.photos[0]).toEqual({ verdict: "accepted", face, similarity: null });
    expect(one.identity?.ceiling.source).toBe("single-photo-default");
    const three = assessReferencePhotos(
      [withFace(at(0)), withFace(at(20)), withFace(at(40))],
      thresholds,
    );
    expect(three.warnings).toEqual([]);
  });

  test("flags a photo by its similarity to the anchor of the other photos, not one that includes itself", () => {
    // The Subject is at 0° and 10°, so the others' anchor is at 5°. A photo at 70°
    // scores cos 65° ≈ 0.42 and passes the 0.4 Gate; one at 75° scores cos 70° ≈
    // 0.34 and is flagged. An anchor including the photo itself (≈ 28°) would
    // lift it to cos 48° ≈ 0.67 and hide the outlier.
    const passes = assessReferencePhotos(
      [withFace(at(0)), withFace(at(10)), withFace(at(70))],
      thresholds,
    );
    expect(passes.photos[2]).toEqual({
      verdict: "accepted",
      face,
      similarity: expect.closeTo(Math.cos((65 * Math.PI) / 180), 10),
    });
    const flagged = assessReferencePhotos(
      [withFace(at(0)), withFace(at(10)), withFace(at(75))],
      thresholds,
    );
    expect(flagged.photos[2]).toEqual({
      verdict: "flagged",
      reason: "not-the-same-person",
      face,
      similarity: expect.closeTo(Math.cos((70 * Math.PI) / 180), 10),
    });
    expect(flagged.photos.slice(0, 2).map((photo) => photo.verdict)).toEqual([
      "accepted",
      "accepted",
    ]);
    expect(flagged.identity?.accepted).toEqual([0, 1]);
    expect(cosineSimilarity(flagged.identity!.anchor, at(5))).toBeCloseTo(1);
    expect(flagged.identity?.ceiling).toEqual({
      value: expect.closeTo(Math.cos(Math.PI / 18), 10),
      source: "median-pairwise",
    });
  });

  test("an outlier can't drag a genuine photo below the Gate", () => {
    // Subject at 0°, 30°, 60°; an outlier at 180°. In a single pass the outlier
    // pulls the 0° photo's leave-one-out anchor to 75° (cos ≈ 0.26, below the
    // Gate). Only the lowest photo, the outlier, is flagged; the rest are then
    // rechecked against each other and pass.
    expect(cosineSimilarity(at(0), identityAnchor([at(30), at(60), at(180)]))).toBeLessThan(0.4);
    const result = assessReferencePhotos(
      [withFace(at(0)), withFace(at(30)), withFace(at(60)), withFace(at(180))],
      thresholds,
    );
    expect(result.photos.map((photo) => photo.verdict)).toEqual([
      "accepted",
      "accepted",
      "accepted",
      "flagged",
    ]);
    expect(result.photos[0]).toEqual({
      verdict: "accepted",
      face,
      similarity: expect.closeTo(Math.SQRT1_2, 10),
    });
    expect(result.warnings).toEqual([]);
  });

  test("flags both photos when only two disagree, since neither is the odd one out", () => {
    const result = assessReferencePhotos([withFace(at(0)), withFace(at(90))], thresholds);
    expect(result.photos.map((photo) => photo.verdict)).toEqual(["flagged", "flagged"]);
    expect(result.identity).toBeUndefined();
    expect(result.warnings).toEqual([
      "No Reference Photo was accepted, so there is no Identity Anchor",
    ]);
  });

  test("uses the per-model Gate rather than a fixed value", () => {
    const photos = [withFace(at(0)), withFace(at(60))]; // similarity 0.5
    expect(assessReferencePhotos(photos, thresholds).photos.map((photo) => photo.verdict)).toEqual([
      "accepted",
      "accepted",
    ]);
    expect(
      assessReferencePhotos(photos, { ...thresholds, identityGate: 0.6 }).photos.map(
        (photo) => photo.verdict,
      ),
    ).toEqual(["flagged", "flagged"]);
  });

  test("re-admits a flagged photo that reaches the Gate against the final anchor", () => {
    // The reviewer's seeded 16-d case (round 1, R1-1). A single greedy pass flags
    // photo 2 at 0.29 while later outliers still pull the anchor; against the
    // final anchor of photos 0, 1 and 3 it scores 0.42, above the 0.4 Gate.
    const reviewerCase: Embedding[] = [
      [
        -0.1594, -0.4602, -0.17, 0.0539, 0.0382, 0.074, -0.4465, -0.0931, -0.1119, -0.1028, 0.2497,
        0.4346, 0.1062, -0.4015, 0.2617, 0.0284,
      ],
      [
        -0.1334, -0.0402, -0.2726, 0.1531, 0.2434, 0.1525, -0.3898, -0.2747, 0.2355, -0.3498,
        0.4558, -0.2181, 0.0372, 0.2217, 0.2594, 0.1481,
      ],
      [
        -0.4581, -0.2782, -0.2625, -0.252, 0.0859, -0.0246, -0.3284, -0.3095, 0.1746, 0.1512,
        0.0181, 0.4043, 0.1607, -0.0392, -0.3073, -0.1729,
      ],
      [
        0.0283, -0.3579, 0.0375, -0.1006, 0.4608, 0.4032, -0.3846, -0.3113, 0.1679, -0.2952, 0.2414,
        0.1466, -0.0273, 0.1348, -0.0297, 0.158,
      ],
      [
        -0.0295, 0.0673, -0.0161, 0.253, 0.4396, -0.262, -0.4848, 0.152, -0.3733, -0.1866, -0.2005,
        0.1372, 0.2236, -0.0692, 0.3338, -0.1049,
      ],
      [
        -0.5298, -0.3429, -0.0722, -0.2654, -0.0766, 0.3569, -0.052, 0.0505, -0.3796, -0.1199,
        -0.0768, 0.2706, -0.0937, 0.2539, -0.2437, -0.1314,
      ],
      [
        -0.0625, -0.2929, -0.0419, -0.1363, 0.3188, -0.0319, -0.0608, 0.1981, -0.0378, -0.2168,
        -0.3815, 0.0118, 0.3963, 0.2158, 0.3853, 0.4452,
      ],
    ];
    const result = assessReferencePhotos(reviewerCase.map(withFace), thresholds);
    expect(result.photos[2]?.verdict).toBe("accepted");
    expect(result.identity?.accepted).toEqual([0, 1, 2, 3]);
    // Every verdict agrees with the final anchor of the other accepted photos.
    const accepted = result.identity!.accepted;
    for (const [index, photo] of result.photos.entries()) {
      if (photo.verdict !== "accepted" && photo.verdict !== "flagged") continue;
      const others = accepted
        .filter((other) => other !== index)
        .map((other) => reviewerCase[other]!);
      const similarity = cosineSimilarity(reviewerCase[index]!, identityAnchor(others));
      expect(photo.similarity).toBeCloseTo(similarity, 10);
      if (photo.verdict === "flagged") expect(similarity).toBeLessThan(thresholds.identityGate);
      else expect(similarity).toBeGreaterThanOrEqual(thresholds.identityGate);
    }
  });

  test("reports a flagged pair's similarity to each other", () => {
    const result = assessReferencePhotos([withFace(at(0)), withFace(at(80))], thresholds);
    for (const photo of result.photos) {
      expect(photo).toMatchObject({
        verdict: "flagged",
        similarity: expect.closeTo(Math.cos((80 * Math.PI) / 180), 10),
      });
    }
  });

  test("re-admits the best agreeing pair when flagging order left nothing accepted", () => {
    // Photos 2 and 3 (indices 1 and 2) agree (0.78); greedy flagging alone removes all four.
    const embeddings = [
      [0, -0.2, -0.2],
      [-0.8, -0.6, 0.3],
      [-0.5, -0.5, 1],
      [-0.5, 0.1, -0.5],
    ];
    const result = assessReferencePhotos(embeddings.map(withFace), thresholds);
    expect(result.photos.map(({ verdict }) => verdict)).toEqual([
      "flagged",
      "accepted",
      "accepted",
      "flagged",
    ]);
    expect(result.identity?.accepted).toEqual([1, 2]);
    expect(result.photos[1]).toMatchObject({
      similarity: expect.closeTo(cosineSimilarity(embeddings[1]!, embeddings[2]!), 10),
    });
  });

  test("re-admits the most similar pair, not just any pair that reaches the Gate", () => {
    // Two pairs reach the 0.4 Gate: indices 1–5 (0.447) and 2–4 (0.475).
    const embeddings = [
      [0.8, 0.7, 1],
      [-0.5, -0.4, 0.6],
      [0.3, 0.5, -0.8],
      [0.8, -0.1, -0.1],
      [-0.3, -0.2, -0.7],
      [0.2, -0.6, 0.2],
    ];
    expect(cosineSimilarity(embeddings[1]!, embeddings[5]!)).toBeGreaterThanOrEqual(0.4);
    const result = assessReferencePhotos(embeddings.map(withFace), thresholds);
    expect(result.identity?.accepted).toEqual([2, 4]);
  });

  test("after re-admitting a pair, a third photo that agrees with it is re-admitted too", () => {
    // Indices 3 and 5 agree strongly (0.99); index 0 reaches the Gate against their anchor.
    const embeddings = [
      [0.9, 0.2, -0.7],
      [-0.3, 0.1, 0.7],
      [0.6, -0.8, 0.5],
      [0, 0.9, -1],
      [-0.5, -0.7, 0.2],
      [0.2, 0.9, -0.9],
    ];
    const result = assessReferencePhotos(embeddings.map(withFace), thresholds);
    expect(result.identity?.accepted).toEqual([0, 3, 5]);
    for (const photo of result.photos) {
      if (photo.verdict === "accepted") {
        expect(photo.similarity).toBeGreaterThanOrEqual(thresholds.identityGate);
      }
    }
  });

  test("with three or more photos all flagged, each reports its best match to one other photo", () => {
    // x has 0.35 with each of a and b; a and b are orthogonal. Against the mean
    // of a and b, x would score 0.495, above the Gate, contradicting its verdict.
    const x = [0.35, 0.35, Math.sqrt(1 - 2 * 0.35 * 0.35)];
    const result = assessReferencePhotos(
      [withFace(x), withFace([1, 0, 0]), withFace([0, 1, 0])],
      thresholds,
    );
    expect(result.identity).toBeUndefined();
    const reported = result.photos.map((photo) =>
      photo.verdict === "flagged" ? photo.similarity : Number.NaN,
    );
    for (const similarity of reported) {
      expect(similarity).toBeCloseTo(0.35, 10);
      expect(similarity).toBeLessThan(thresholds.identityGate);
    }
  });

  test("warns, without clamping, when the Identity Ceiling lies below the Gate", () => {
    // Three photos with pairwise cosine 0.33: each passes against the other two's
    // anchor (≈ 0.405), so all are accepted, but the median pair is 0.33.
    const c = 0.33;
    const b = [c, Math.sqrt(1 - c * c), 0];
    const y = (c - c * c) / Math.sqrt(1 - c * c);
    const third = [c, y, Math.sqrt(1 - c * c - y * y)];
    const result = assessReferencePhotos(
      [withFace([1, 0, 0]), withFace(b), withFace(third)],
      thresholds,
    );
    expect(result.identity?.accepted).toEqual([0, 1, 2]);
    expect(result.identity?.ceiling).toEqual({
      value: expect.closeTo(0.33, 10),
      source: "median-pairwise",
    });
    expect(result.warnings).toEqual([
      "Identity Ceiling below the Identity Gate: the accepted photos barely agree with each other",
    ]);
  });
});

describe("vector guards", () => {
  test("normalize and cosineSimilarity reject non-finite components", () => {
    expect(() => normalize([Infinity, 1])).toThrow("non-finite");
    expect(() => normalize([Number.NaN, 1])).toThrow("non-finite");
    expect(() => cosineSimilarity([Infinity, 0], [1, 0])).toThrow("non-finite");
  });
});

describe("identity thresholds", () => {
  const decode = Schema.decodeUnknownSync(IdentityThresholds);
  test("are cosine similarities with the single-photo Ceiling at or above the Gate", () => {
    expect(decode({ identityGate: 0.4, singlePhotoCeiling: 0.6 })).toEqual({
      identityGate: 0.4,
      singlePhotoCeiling: 0.6,
    });
    expect(() => decode({ identityGate: 2, singlePhotoCeiling: 0.6 })).toThrow();
    expect(() => decode({ identityGate: 0.5, singlePhotoCeiling: 0.4 })).toThrow(
      "singlePhotoCeiling must be at least identityGate",
    );
  });
});
