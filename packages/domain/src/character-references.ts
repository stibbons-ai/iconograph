import { Data, Effect } from "effect";
import type { DetectedFace, Embedding, Point } from "./face";
import { cosineSimilarity } from "./identity";

/** An accepted Reference Photo, as character-reference selection sees it. */
export interface ReferenceCandidate {
  /** Numbered from 1, as in the Reference Photo report. */
  readonly photo: number;
  readonly face: DetectedFace;
  readonly embedding: Embedding;
}

/** The operator's pins can't be honoured. */
export class CharacterReferenceError extends Data.TaggedError("CharacterReferenceError")<{
  message: string;
}> {}

/**
 * How frontal a face is, from 1 (nose midway between the eyes) down to 0 (nose
 * half an eye distance or more to one side, i.e. a three-quarter or profile
 * view). The nose's offset is measured along the eye axis, so head tilt (roll)
 * doesn't count.
 */
export function frontality(face: DetectedFace): number {
  const [rightEye, leftEye, nose] = face.landmarks;
  const axis = { x: leftEye.x - rightEye.x, y: leftEye.y - rightEye.y };
  const eyeDistance = Math.hypot(axis.x, axis.y);
  if (!(eyeDistance > 0)) return 0;
  const middle: Point = { x: (rightEye.x + leftEye.x) / 2, y: (rightEye.y + leftEye.y) / 2 };
  const offset =
    ((nose.x - middle.x) * axis.x + (nose.y - middle.y) * axis.y) / (eyeDistance * eyeDistance);
  return Math.max(0, 1 - 2 * Math.abs(offset));
}

export interface SelectCharacterReferencesOptions {
  /** The Image Model's `maxCharacterReferences`. */
  readonly max: number;
  /** Photo numbers the operator pinned; always included, and they count against `max`. */
  readonly pinned?: readonly number[];
}

/**
 * Choose up to `max` character references from the accepted Reference Photos,
 * deterministically:
 *
 * 1. Pinned photos come first, in the order given.
 * 2. Without pins, the first pick is the best face: frontality × √(face area ÷
 *    the largest face area), so a large frontal face wins.
 * 3. Each further pick is the photo farthest from those already chosen: the
 *    one whose smallest embedding distance (1 − cosine) to them is largest, so
 *    a near-duplicate of a chosen photo loses to a different angle or light.
 *    Ties go to the better face, then the lower photo number.
 *
 * Returns photo numbers in pick order. Pinning a photo that wasn't accepted,
 * pinning one twice, or pinning more than `max` fails with
 * `CharacterReferenceError`.
 */
export function selectCharacterReferences(
  photos: readonly ReferenceCandidate[],
  { max, pinned = [] }: SelectCharacterReferencesOptions,
): Effect.Effect<number[], CharacterReferenceError> {
  const invalid = (message: string) => Effect.fail(new CharacterReferenceError({ message }));
  if (pinned.length > max) {
    return invalid(
      `${pinned.length} photos pinned, but the Image Model takes at most ${max} character references`,
    );
  }
  const byPhoto = new Map(photos.map((photo) => [photo.photo, photo]));
  for (const [index, photo] of pinned.entries()) {
    if (!byPhoto.has(photo))
      return invalid(`Pinned photo ${photo} is not an accepted Reference Photo`);
    if (pinned.indexOf(photo) !== index) return invalid(`Photo ${photo} is pinned twice`);
  }

  const largestArea = Math.max(...photos.map(({ face }) => face.box.width * face.box.height));
  const quality = new Map(
    photos.map(({ photo, face }) => [
      photo,
      frontality(face) * Math.sqrt((face.box.width * face.box.height) / largestArea),
    ]),
  );
  /** Higher value first, then better face, then lower photo number. */
  const best = (
    candidates: readonly ReferenceCandidate[],
    value: (c: ReferenceCandidate) => number,
  ) =>
    [...candidates].sort(
      (a, b) =>
        value(b) - value(a) || quality.get(b.photo)! - quality.get(a.photo)! || a.photo - b.photo,
    )[0];

  const chosen = pinned.map((photo) => byPhoto.get(photo)!);
  const limit = Math.min(max, photos.length);
  while (chosen.length < limit) {
    const remaining = photos.filter((photo) => !chosen.includes(photo));
    const next =
      chosen.length === 0
        ? best(remaining, () => 0)
        : best(remaining, (candidate) =>
            Math.min(
              ...chosen.map((other) => 1 - cosineSimilarity(candidate.embedding, other.embedding)),
            ),
          );
    chosen.push(next!);
  }
  return Effect.succeed(chosen.map(({ photo }) => photo));
}
