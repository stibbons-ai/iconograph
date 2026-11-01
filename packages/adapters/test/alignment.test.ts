import { describe, expect, test } from "bun:test";
import type { Point, RgbImage } from "@iconograph/domain";
import { estimateSimilarity, type SimilarityTransform, warpAffine } from "../src/alignment";

const source: Point[] = [
  { x: 120, y: 140 },
  { x: 180, y: 138 },
  { x: 150, y: 175 },
  { x: 128, y: 205 },
  { x: 172, y: 204 },
];

const apply = ({ a, b, tx, ty }: SimilarityTransform, { x, y }: Point) => ({
  x: a * x - b * y + tx,
  y: b * x + a * y + ty,
});

describe("similarity transform", () => {
  test("recovers a known rotation, scale and translation exactly", () => {
    const angle = (25 * Math.PI) / 180;
    const scale = 0.42;
    const expected = {
      a: scale * Math.cos(angle),
      b: scale * Math.sin(angle),
      tx: -13.5,
      ty: 27.25,
    };
    const target = source.map((point) => apply(expected, point));
    const estimated = estimateSimilarity(source, target);
    for (const key of ["a", "b", "tx", "ty"] as const) {
      expect(estimated[key]).toBeCloseTo(expected[key], 9);
    }
  });

  test("is the least-squares fit when landmarks are noisy", () => {
    const target = source.map(({ x, y }, index) => ({
      x: x * 0.5 + 10 + (index % 2 ? 0.8 : -0.8),
      y: y * 0.5 - 5 + (index % 3 ? -0.6 : 0.6),
    }));
    const estimated = estimateSimilarity(source, target);
    expect(Math.hypot(estimated.a, estimated.b)).toBeCloseTo(0.5, 2);
    expect(Math.atan2(estimated.b, estimated.a)).toBeCloseTo(0, 1);
    // Nudging the fit in any direction can only increase the squared error.
    const error = (transform: SimilarityTransform) =>
      source.reduce((sum, point, index) => {
        const mapped = apply(transform, point);
        return sum + (mapped.x - target[index]!.x) ** 2 + (mapped.y - target[index]!.y) ** 2;
      }, 0);
    for (const key of ["a", "b", "tx", "ty"] as const) {
      for (const delta of [-1e-3, 1e-3]) {
        expect(error({ ...estimated, [key]: estimated[key] + delta })).toBeGreaterThan(
          error(estimated),
        );
      }
    }
  });

  test("rejects degenerate input", () => {
    expect(() => estimateSimilarity(source.slice(0, 1), source.slice(0, 1))).toThrow();
    expect(() => estimateSimilarity([source[0]!, source[0]!], source.slice(0, 2))).toThrow();
  });
});

describe("warpAffine", () => {
  // A 4×4 image whose red channel encodes x and green encodes y.
  const width = 4;
  const height = 4;
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[(y * width + x) * 3] = x * 10;
      data[(y * width + x) * 3 + 1] = y * 10;
      data[(y * width + x) * 3 + 2] = 200;
    }
  }
  const image: RgbImage = { data, width, height };
  const pixel = (warped: RgbImage, x: number, y: number) =>
    Array.from(warped.data.subarray((y * warped.width + x) * 3, (y * warped.width + x) * 3 + 3));

  test("maps output pixels through the transform and fills outside with black", () => {
    // Shift by (+1, +2): output (u, v) samples input (u − 1, v − 2).
    const shifted = warpAffine(image, { a: 1, b: 0, tx: 1, ty: 2 }, 4, 4);
    expect(pixel(shifted, 1, 2)).toEqual([0, 0, 200]);
    expect(pixel(shifted, 3, 3)).toEqual([20, 10, 200]);
    expect(pixel(shifted, 0, 0)).toEqual([0, 0, 0]);
  });

  test("interpolates bilinearly between source pixels", () => {
    // Scale ×2: output (1, 1) samples input (0.5, 0.5).
    const scaled = warpAffine(image, { a: 2, b: 0, tx: 0, ty: 0 }, 4, 4);
    expect(pixel(scaled, 1, 1)).toEqual([5, 5, 200]);
  });

  test("rotates a quarter turn", () => {
    // x' = −y + 3, y' = x: output (3 − y, x) samples input (x, y).
    const rotated = warpAffine(image, { a: 0, b: 1, tx: 3, ty: 0 }, 4, 4);
    expect(pixel(rotated, 3, 2)).toEqual([20, 0, 200]);
    expect(pixel(rotated, 0, 1)).toEqual([10, 30, 200]);
  });
});
