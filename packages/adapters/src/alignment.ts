import type { Point, RgbImage } from "@iconograph/domain";

/**
 * A 2-D similarity transform (uniform scale, rotation, translation):
 * x' = a·x − b·y + tx, y' = b·x + a·y + ty.
 */
export interface SimilarityTransform {
  a: number;
  b: number;
  tx: number;
  ty: number;
}

/**
 * Least-squares similarity transform mapping `source` onto `target` (Umeyama
 * 1991 restricted to 2-D without reflection, as OpenCV's SFace alignment uses).
 */
export function estimateSimilarity(
  source: readonly Point[],
  target: readonly Point[],
): SimilarityTransform {
  if (source.length !== target.length || source.length < 2) {
    throw new Error("A similarity transform needs at least two matching point pairs");
  }
  const mean = (points: readonly Point[]) => ({
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  });
  const sourceMean = mean(source);
  const targetMean = mean(target);
  let dot = 0;
  let cross = 0;
  let variance = 0;
  source.forEach((point, index) => {
    const x = point.x - sourceMean.x;
    const y = point.y - sourceMean.y;
    const u = target[index]!.x - targetMean.x;
    const v = target[index]!.y - targetMean.y;
    dot += x * u + y * v;
    cross += x * v - y * u;
    variance += x * x + y * y;
  });
  if (!(variance > 0)) throw new Error("Source points are all identical");
  const a = dot / variance;
  const b = cross / variance;
  return {
    a,
    b,
    tx: targetMean.x - (a * sourceMean.x - b * sourceMean.y),
    ty: targetMean.y - (b * sourceMean.x + a * sourceMean.y),
  };
}

/**
 * Resample `image` through `transform` into a `width`×`height` RGB image with
 * bilinear interpolation; pixels mapped from outside the source are black, as
 * in OpenCV's `warpAffine` default.
 */
export function warpAffine(
  image: RgbImage,
  transform: SimilarityTransform,
  width: number,
  height: number,
): RgbImage {
  const { a, b, tx, ty } = transform;
  const determinant = a * a + b * b;
  if (!(determinant > 0)) throw new Error("Degenerate similarity transform");
  const output = new Uint8Array(width * height * 3);
  const source = image.data;
  const sample = (x: number, y: number, channel: number) =>
    x < 0 || y < 0 || x >= image.width || y >= image.height
      ? 0
      : source[(y * image.width + x) * 3 + channel]!;
  for (let v = 0; v < height; v++) {
    for (let u = 0; u < width; u++) {
      // Invert x' = a·x − b·y + tx, y' = b·x + a·y + ty.
      const du = u - tx;
      const dv = v - ty;
      const x = (a * du + b * dv) / determinant;
      const y = (a * dv - b * du) / determinant;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const fx = x - x0;
      const fy = y - y0;
      for (let channel = 0; channel < 3; channel++) {
        const top = sample(x0, y0, channel) * (1 - fx) + sample(x0 + 1, y0, channel) * fx;
        const bottom =
          sample(x0, y0 + 1, channel) * (1 - fx) + sample(x0 + 1, y0 + 1, channel) * fx;
        output[(v * width + u) * 3 + channel] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return { data: output, width, height };
}
