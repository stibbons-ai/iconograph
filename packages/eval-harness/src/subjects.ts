import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage, readJsonFile } from "@iconograph/adapters";
import { MAX_REFERENCE_PHOTOS, type TargetLook, TargetLookInput } from "@iconograph/domain";
import { Schema } from "effect";

/*
 * The Subjects folder of `bun run eval`: one directory per consenting Subject,
 * holding that Subject's Reference Photos and, optionally, `look.json` (the
 * Target Look), `prompt.txt` (the starting Prompt of both Arms) and
 * `faces.json` (face choices by photo file name). Hidden entries are ignored,
 * so an output folder beside the Subjects (`.eval-…`) is never read as one.
 */

export const LOOK_FILE = "look.json";
export const PROMPT_FILE = "prompt.txt";
export const FACES_FILE = "faces.json";

/** One Subject as the Arms' Runs start from it. */
export interface Subject {
  readonly name: string;
  /** Reference Photo paths in name order (`byName`), so photo N is the Nth file. */
  readonly photos: readonly string[];
  /** The Target Look, missing facets at their defaults. */
  readonly targetLook: TargetLook;
  /** The starting Prompt of both Arms; absent: the one built from the Target Look. */
  readonly prompt?: string;
  /** Photo number → face number, both from 1, as `--face` of the Run CLI. */
  readonly faceChoices: ReadonlyMap<number, number>;
}

const decodeLook = Schema.decodeUnknownSync(TargetLookInput, { onExcessProperty: "error" });
const decodeFaces = Schema.decodeUnknownSync(
  Schema.Record(Schema.String, Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
);

/** File names in numeric-aware order, so `2.jpg` comes before `10.jpg`. */
const byName = (left: string, right: string) =>
  left.localeCompare(right, "en", { numeric: true, sensitivity: "base" }) ||
  (left < right ? -1 : left > right ? 1 : 0);

/** Non-hidden entries of `directory` in `byName` order, each as a file or a directory. */
async function entries(directory: string, what: string) {
  const names = await readdir(directory).catch((error: unknown) => {
    throw new Error(`${what} could not be read: ${errorMessage(error)}`);
  });
  return Promise.all(
    names
      .filter((name) => !name.startsWith("."))
      .sort(byName)
      .map(async (name) => {
        const path = join(directory, name);
        const stats = await stat(path).catch((error: unknown) => {
          throw new Error(`${what}: ${name} could not be read: ${errorMessage(error)}`);
        });
        return { name, path, isDirectory: stats.isDirectory() };
      }),
  );
}

/** The settings file a name stands for, matched without case (`Look.JSON` is `look.json`). */
const settingsFile = (name: string) =>
  [LOOK_FILE, PROMPT_FILE, FACES_FILE].find((file) => file === name.toLowerCase());

/** One Subject's directory: its photos and optional settings. */
async function readSubject(name: string, directory: string): Promise<Subject> {
  const label = `Subject ${name}`;
  const photos: { name: string; path: string }[] = [];
  let targetLook: TargetLook = decodeLook({});
  let prompt: string | undefined;
  let faces: Readonly<Record<string, number>> = {};
  const settings = new Set<string>();
  for (const entry of await entries(directory, label)) {
    const what = `${label}: ${entry.name}`;
    if (entry.isDirectory) {
      throw new Error(`${what} is a folder; a Subject folder holds only photos and settings files`);
    }
    const file = settingsFile(entry.name);
    if (file !== undefined) {
      if (settings.has(file))
        throw new Error(`${label} has ${file} twice (names differ only in case)`);
      settings.add(file);
    }
    switch (file) {
      case LOOK_FILE:
        targetLook = await readJsonFile(entry.path, what, decodeLook);
        break;
      case PROMPT_FILE:
        prompt = (
          await Bun.file(entry.path)
            .text()
            .catch((error: unknown) => {
              throw new Error(`${what} could not be read: ${errorMessage(error)}`);
            })
        ).trim();
        if (prompt === "") throw new Error(`${what} is empty; remove it to use the default Prompt`);
        break;
      case FACES_FILE:
        faces = await readJsonFile(
          entry.path,
          `${what} (expected {"PHOTO FILE": FACE, ...}, faces from 1)`,
          decodeFaces,
        );
        break;
      default:
        photos.push(entry);
    }
  }
  if (photos.length < 1 || photos.length > MAX_REFERENCE_PHOTOS) {
    throw new Error(
      `${label} has ${photos.length} Reference Photos; a Run takes 1 to ${MAX_REFERENCE_PHOTOS}`,
    );
  }
  const faceChoices = new Map<number, number>();
  for (const [photo, face] of Object.entries(faces)) {
    const index = photos.findIndex((candidate) => candidate.name === photo);
    if (index === -1)
      throw new Error(`${label}: ${FACES_FILE} names ${photo}, which is not one of its photos`);
    faceChoices.set(index + 1, face);
  }
  return {
    name,
    photos: photos.map(({ path }) => path),
    targetLook,
    ...(prompt !== undefined && { prompt }),
    faceChoices,
  };
}

/** Every Subject of the folder at `root`, in name order; at least one. */
export async function readSubjectsFolder(root: string): Promise<Subject[]> {
  const what = `The Subjects folder ${root}`;
  const subjects: Subject[] = [];
  for (const entry of await entries(root, what)) {
    if (!entry.isDirectory) {
      throw new Error(`${what} holds ${entry.name}, which is not a Subject folder`);
    }
    subjects.push(await readSubject(entry.name, entry.path));
  }
  if (subjects.length === 0) throw new Error(`${what} has no Subject folder`);
  return subjects;
}
