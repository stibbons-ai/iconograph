import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  assessReferencePhotos,
  type DetectedFace,
  type Embedding,
  FaceEmbedder,
  FaceModelError,
  type IdentityCeiling,
  MAX_REFERENCE_PHOTOS,
  type PhotoFaces,
  type RgbImage,
} from "@iconograph/domain";
import { Data, Effect } from "effect";
import sharp from "sharp";
import { imagesDirectory } from "./data-directory";
import { errorMessage } from "./errors";
import { writeFileAtomically } from "./files";
import { decodeHeic, type HeicDecoder, loadHeicDecoder } from "./heic";

/** A Reference Photo set or file that can't be used; `photo` names the file when there is one. */
export class ReferencePhotoError extends Data.TaggedError("ReferencePhotoError")<{
  message: string;
  photo?: string;
}> {}

/** The HEIC decoder itself failed to load: a fault of the install, not of any photo. */
export class HeicDecoderError extends Data.TaggedError("HeicDecoderError")<{
  message: string;
}> {}

/** Larger uploads (50 MiB) are rejected before they are read. */
export const MAX_PHOTO_BYTES = 50 * 1024 * 1024;

/**
 * Larger images are rejected from their headers, before their pixels are
 * decoded. The operator-facing rationale (48 MP phone captures pass, larger
 * photos must be downscaled, peak memory per format) is in the README's
 * "Reference Photos" section.
 */
export const MAX_PHOTO_PIXELS = 50_000_000;

export type PhotoFormat = "jpeg" | "png" | "heic";

export interface DecodedPhoto {
  format: PhotoFormat;
  /** Upright (EXIF orientation applied), sRGB, alpha flattened onto white. */
  image: RgbImage;
}

/** ISO-BMFF brands of HEVC-coded HEIF; `mif1`/`msf1` are generic and need the AVIF check. */
const heicBrands: Record<string, true> = {
  heic: true,
  heix: true,
  heim: true,
  heis: true,
  hevc: true,
  hevx: true,
  mif1: true,
  msf1: true,
};

/**
 * Identify the container from magic bytes; decoding then proves the content.
 * AVIF shares the generic HEIF brands but needs an AV1 decoder, which the HEIC
 * decoder lacks, so it is reported as unsupported rather than failing later.
 */
function sniffFormat(bytes: Uint8Array): PhotoFormat | undefined {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (ascii(0, 8) === "\x89PNG\r\n\x1a\n") return "png";
  if (ascii(4, 8) !== "ftyp" || !heicBrands[ascii(8, 12)]) return undefined;
  // The ftyp box: size, "ftyp", major brand, minor version, then compatible brands.
  const boxEnd = Math.min(new DataView(bytes.buffer, bytes.byteOffset).getUint32(0), bytes.length);
  for (let offset = 16; offset + 4 <= boxEnd; offset += 4) {
    const brand = ascii(offset, offset + 4);
    if (brand === "avif" || brand === "avis") return undefined;
  }
  return "heic";
}

export const failure = (photo: string, message: string) =>
  new ReferencePhotoError({ photo, message });
const photoError =
  (photo: string, action: string, label = "Reference Photo") =>
  (error: unknown) =>
    failure(photo, `${label} ${photo} could not be ${action}: ${errorMessage(error)}`);

/**
 * Validate an upload by fully decoding it into upright sRGB pixels. For JPEG and
 * PNG, truncated or corrupt data fails rather than yielding a partly grey image:
 * `failOn` is pinned to `"warning"` (sharp's current default), which also
 * rejects JPEGs that libjpeg can only decode with "corrupt data" warnings.
 * Images over `MAX_PHOTO_PIXELS` are rejected from their headers. HEIC is
 * decoded in software first, since prebuilt libvips has no HEVC; its corruption
 * detection is best-effort (see `decodeHeic`). A decoder that fails to load is a
 * `HeicDecoderError`, not an error about the photo. `label` names the image in
 * errors (the held-out command also decodes a Candidate this way).
 */
export const decodeReferencePhoto = (
  path: string,
  loadDecoder: () => Promise<HeicDecoder> = loadHeicDecoder,
  label = "Reference Photo",
) =>
  Effect.gen(function* () {
    const bytes = yield* Effect.tryPromise({
      try: async () => {
        const { size } = await stat(path);
        if (size > MAX_PHOTO_BYTES) {
          throw new Error(`${size} bytes exceeds the ${MAX_PHOTO_BYTES}-byte limit`);
        }
        return Bun.file(path).bytes();
      },
      catch: photoError(path, "read", label),
    });
    const format = sniffFormat(bytes);
    if (!format) return yield* photoError(path, "decoded", label)("not a JPEG, PNG or HEIC image");
    const heic =
      format === "heic"
        ? yield* Effect.tryPromise({
            try: loadDecoder,
            catch: (error) =>
              new HeicDecoderError({
                message: `The HEIC decoder could not be loaded: ${errorMessage(error)}`,
              }),
          })
        : undefined;
    return yield* Effect.tryPromise({
      try: async (): Promise<DecodedPhoto> => {
        // libheif applies HEIC's own rotation while decoding; EXIF orientation applies to JPEG/PNG.
        const pipeline = heic
          ? sharp(...decodeHeic(heic, bytes, MAX_PHOTO_PIXELS))
          : sharp(bytes, { failOn: "warning", limitInputPixels: MAX_PHOTO_PIXELS }).rotate();
        const { data, info } = await pipeline
          .flatten({ background: "#ffffff" })
          .toColourspace("srgb")
          .raw()
          .toBuffer({ resolveWithObject: true });
        if (info.channels !== 3) {
          throw new Error(`decoded to ${info.channels} channels, expected 3`);
        }
        return { format, image: { data, width: info.width, height: info.height } };
      },
      catch: photoError(path, "decoded", label),
    });
  });

/**
 * Identifies an image by its decoded pixels, so the same picture in another
 * file or format is recognised as a duplicate (it would vote twice).
 */
export const pixelKey = ({ data, width, height }: RgbImage) =>
  `${width}×${height}:${Bun.CryptoHasher.hash("sha256", data, "hex")}`;

export interface EncodedPhoto {
  jpeg: Uint8Array;
  sha256: string;
}

/**
 * Re-encode decoded pixels as JPEG. The encoder starts from raw pixels, so no
 * EXIF, GPS, XMP, IPTC or ICC metadata of the upload can reach the output. The
 * encoding is deterministic, so identical pixels give the same `sha256`.
 */
export const encodeReferencePhoto = (photo: string, image: RgbImage) =>
  Effect.tryPromise({
    try: async (): Promise<EncodedPhoto> => {
      const jpeg = await sharp(image.data, {
        raw: { width: image.width, height: image.height, channels: 3 },
      })
        .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
        .toBuffer();
      return { jpeg, sha256: Bun.CryptoHasher.hash("sha256", jpeg, "hex") };
    },
    catch: photoError(photo, "encoded"),
  });

export interface StoredPhoto {
  path: string;
  sha256: string;
}

/** Write an encoded Reference Photo into the content-addressed image store. */
export const storeReferencePhoto = (photo: string, encoded: EncodedPhoto, dataDirectory: string) =>
  Effect.tryPromise({
    try: async (): Promise<StoredPhoto> => {
      const directory = imagesDirectory(dataDirectory);
      const path = join(directory, `${encoded.sha256}.jpg`);
      await mkdir(directory, { recursive: true });
      await writeFileAtomically(path, (file) => file.writeFile(encoded.jpeg), { suffix: ".tmp" });
      return { path, sha256: encoded.sha256 };
    },
    catch: photoError(photo, "stored"),
  });

export interface ValidateReferencePhotosOptions {
  paths: readonly string[];
  /** Operator's face choice: photo number → face number, both from 1 as reported. */
  faceChoices?: ReadonlyMap<number, number>;
  dataDirectory: string;
}

interface PhotoSummary {
  /** Numbered from 1 in input order. */
  photo: number;
  path: string;
  format: PhotoFormat;
  width: number;
  height: number;
}

/** `face` is numbered from 1 in detection order (highest score first). */
export type FaceSummary = Pick<DetectedFace, "box" | "score"> & { face: number };

export type PhotoReport = PhotoSummary &
  (
    | { verdict: "rejected"; reason: "no-face" }
    | { verdict: "choice-required"; faces: FaceSummary[] }
    | { verdict: "accepted"; face: FaceSummary; similarity: number | null; stored: StoredPhoto }
    | { verdict: "flagged"; reason: "not-the-same-person"; face: FaceSummary; similarity: number }
  );

export interface ReferencePhotoReport {
  model: string;
  identityGate: number;
  photos: PhotoReport[];
  /** Absent when no photo was accepted. `photos` lists the accepted photo numbers. */
  identity?: { photos: number[]; anchor: Embedding; ceiling: IdentityCeiling };
  warnings: string[];
}

export const summarize = ({ box, score }: DetectedFace, face: number): FaceSummary => ({
  face,
  box,
  score,
});

/** A face-model failure, named with the photo it ran on. */
export const onPhoto =
  (photo: string, label = "Reference Photo") =>
  (error: FaceModelError) =>
    new FaceModelError({ message: `${label} ${photo}: ${error.message}`, photo });

/** Parse repeated `--face PHOTO:FACE` values (both numbered from 1) into photo → face. */
export function parseFaceChoices(values: readonly string[]): Map<number, number> {
  const choices = new Map<number, number>();
  for (const value of values) {
    const match = /^([1-9]\d*):([1-9]\d*)$/.exec(value);
    if (!match) throw new Error(`--face expects PHOTO:FACE numbered from 1, got ${value}`);
    const photo = Number(match[1]);
    if (choices.has(photo)) throw new Error(`--face given twice for photo ${photo}`);
    choices.set(photo, Number(match[2]));
  }
  return choices;
}

/**
 * What validation keeps per photo: never the decoded pixels. Only a photo with
 * one face (chosen or single) can be accepted, so only it carries the number of
 * that face and its encoded JPEG for storage.
 */
type Inspected = { summary: PhotoSummary } & (
  | { found: Extract<PhotoFaces, { kind: "face" }>; faceNumber: number; encoded: EncodedPhoto }
  | { found: Exclude<PhotoFaces, { kind: "face" }> }
);

/** The record behind an accepted or flagged verdict, which the domain only gives photos with a face. */
function withFace(record: Inspected) {
  if (!("encoded" in record)) throw new Error("A verdict about a face for a photo without one");
  return record;
}

/**
 * Check a Reference Photo set before any photo is read: 1 to
 * `MAX_REFERENCE_PHOTOS` paths, no file given twice, and every face choice
 * naming a given photo and a face number (both from 1).
 */
export const checkReferenceSet = (
  paths: readonly string[],
  faceChoices: ReadonlyMap<number, number>,
) =>
  Effect.gen(function* () {
    if (paths.length < 1 || paths.length > MAX_REFERENCE_PHOTOS) {
      return yield* new ReferencePhotoError({
        message: `A Run takes 1 to ${MAX_REFERENCE_PHOTOS} Reference Photos; got ${paths.length}`,
      });
    }
    const seenPaths = new Map<string, string>();
    for (const path of paths) {
      const key = resolve(path);
      const earlier = seenPaths.get(key);
      if (earlier !== undefined) {
        return yield* failure(path, `Reference Photos ${earlier} and ${path} are the same file`);
      }
      seenPaths.set(key, path);
    }
    for (const [photo, face] of faceChoices) {
      if (!Number.isInteger(photo) || photo < 1) {
        return yield* new ReferencePhotoError({
          message: `Face choice for photo ${photo}: photos are numbered from 1`,
        });
      }
      const path = paths[photo - 1];
      if (!path) {
        return yield* new ReferencePhotoError({
          message: `Face choice for photo ${photo}, but only ${paths.length} photos were given`,
        });
      }
      if (!Number.isInteger(face) || face < 1) {
        return yield* failure(path, `Face choice ${face} for ${path} is not a face number`);
      }
    }
  });

/**
 * The number (from 1, in detection order) of the face to use in a photo: the
 * operator's `choice`, else its only face; undefined when it has no face or
 * several and no choice. A choice beyond the faces detected is an error.
 */
export const chooseFace = (
  path: string,
  faces: readonly DetectedFace[],
  choice: number | undefined,
): Effect.Effect<number | undefined, ReferencePhotoError> =>
  choice !== undefined && !faces[choice - 1]
    ? Effect.fail(
        failure(
          path,
          `Face ${choice} was chosen for ${path}, but ${faces.length} face${faces.length === 1 ? " was" : "s were"} detected`,
        ),
      )
    : Effect.succeed(choice ?? (faces.length === 1 ? 1 : undefined));

/**
 * Validate a Run's Reference Photos: decode each, find its face (or apply the
 * operator's choice), embed it, judge the set, and store accepted photos
 * stripped of metadata. The same file given twice is an error, and so is a
 * photo with a usable face whose pixels repeat an earlier one: a duplicate
 * would vote twice and inflate the Ceiling. A face-model failure is a
 * `FaceModelError` naming the photo it happened on.
 */
export const validateReferencePhotos = (options: ValidateReferencePhotosOptions) =>
  Effect.gen(function* () {
    const { paths, faceChoices = new Map<number, number>(), dataDirectory } = options;
    yield* checkReferenceSet(paths, faceChoices);
    const embedder = yield* FaceEmbedder;
    // Decoded pixels are dropped after each photo, so one full-size image is held
    // at a time, plus one encoded JPEG per photo with a usable face.
    const inspected: Inspected[] = [];
    const seenPixels = new Map<string, string>();
    for (const [index, path] of paths.entries()) {
      const { format, image } = yield* decodeReferencePhoto(path);
      const faces = yield* embedder.detect(image).pipe(Effect.mapError(onPhoto(path)));
      const faceNumber = yield* chooseFace(path, faces, faceChoices.get(index + 1));
      const summary = { photo: index + 1, path, format, width: image.width, height: image.height };
      if (faceNumber !== undefined) {
        const face = faces[faceNumber - 1]!;
        const embedding = yield* embedder.embed(image, face).pipe(Effect.mapError(onPhoto(path)));
        const key = pixelKey(image);
        const earlier = seenPixels.get(key);
        if (earlier !== undefined) {
          return yield* failure(path, `Reference Photos ${earlier} and ${path} are the same image`);
        }
        seenPixels.set(key, path);
        const encoded = yield* encodeReferencePhoto(path, image);
        inspected.push({
          summary,
          found: { kind: "face", face, embedding },
          faceNumber,
          encoded,
        });
      } else if (faces.length === 0) {
        inspected.push({ summary, found: { kind: "no-face" } });
      } else {
        inspected.push({ summary, found: { kind: "several-faces", faces } });
      }
    }

    const assessment = assessReferencePhotos(
      inspected.map(({ found }) => found),
      embedder.thresholds,
    );
    const photos: PhotoReport[] = [];
    for (const [index, verdict] of assessment.photos.entries()) {
      const record = inspected[index]!;
      const { summary: base } = record;
      switch (verdict.verdict) {
        case "rejected":
          photos.push({ ...base, ...verdict });
          break;
        case "choice-required":
          photos.push({
            ...base,
            ...verdict,
            faces: verdict.faces.map((face, position) => summarize(face, position + 1)),
          });
          break;
        case "flagged":
          photos.push({
            ...base,
            ...verdict,
            face: summarize(verdict.face, withFace(record).faceNumber),
          });
          break;
        case "accepted": {
          const { faceNumber, encoded } = withFace(record);
          photos.push({
            ...base,
            ...verdict,
            face: summarize(verdict.face, faceNumber),
            stored: yield* storeReferencePhoto(base.path, encoded, dataDirectory),
          });
        }
      }
    }
    const { identity } = assessment;
    return {
      model: embedder.model,
      identityGate: embedder.thresholds.identityGate,
      photos,
      ...(identity && {
        identity: {
          photos: identity.accepted.map((index) => index + 1),
          anchor: identity.anchor,
          ceiling: identity.ceiling,
        },
      }),
      warnings: assessment.warnings,
    } satisfies ReferencePhotoReport;
  });
