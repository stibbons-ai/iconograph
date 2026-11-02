import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { errorMessage } from "./errors";

/*
 * The calibration folder of `faces:calibrate` (issue #11): one directory per
 * consenting Subject with that Subject's real photos, and optionally
 * person-labelled generated Candidates in `candidates/like/` and
 * `candidates/unlike/`. Photos are read in place; nothing is copied.
 */

/** One image of the folder. */
export interface FolderImage {
  /**
   * Its real absolute location (symlinks resolved), whose directory the
   * never-committed guard checked; read from here, never printed.
   */
  readonly resolved: string;
  /** Its path relative to the folder, the only way reports and errors name it. */
  readonly shown: string;
}

/** One Subject's images in name order. */
export interface FolderSubject {
  readonly name: string;
  readonly photos: readonly FolderImage[];
  readonly like: readonly FolderImage[];
  readonly unlike: readonly FolderImage[];
}

/** An entry that is not part of the layout, by its path relative to the root. */
export interface SkippedEntry {
  path: string;
  reason: string;
}

declare const neverCommitted: unique symbol;

/**
 * A listed calibration folder that passed the never-committed guard; only
 * `readCalibrationFolder` makes one. A spread copy keeps the brand but is
 * unchecked: pass this one on as it is.
 */
export interface CalibrationFolder {
  readonly subjects: readonly FolderSubject[];
  readonly skipped: readonly SkippedEntry[];
  readonly [neverCommitted]: true;
}

/**
 * List the calibration folder at `root` (hidden entries ignored) without
 * reading any image, and refuse it unless git won't pick up its images (see
 * `checkDirectoryUnder`): the folder and the real folder of every image must
 * each lie outside any git working tree, or have all their files ignored and
 * none tracked. A forced `git add -f` is not prevented. Entries outside the
 * layout are listed as skipped; a backslash in the folder's path or in any
 * entry's name is refused, since Bun's `realpath` reads it as `/`. Errors name
 * the folder as given and entries relative to it; an image's real location is
 * never printed.
 */
export async function readCalibrationFolder(root: string): Promise<CalibrationFolder> {
  const backslash = `The calibration folder ${root} has a backslash in its path, which Bun reads as a folder separator; rename it`;
  if (root.includes("\\")) throw new Error(backslash);
  const resolvedRoot = await realpath(root).catch((error: unknown) => {
    throw new Error(`The calibration folder ${root} could not be read: ${errorMessage(error)}`);
  });
  // Linked to a path with a backslash: realpath keeps it, but later paths below it would be misread.
  if (resolvedRoot.includes("\\")) throw new Error(backslash);
  if (!(await stat(resolvedRoot)).isDirectory()) {
    throw new Error(`The calibration folder ${root} is not a directory`);
  }
  /** `path` failed to read: named relative to the folder, with only the error code. */
  const unreadable = (path: string) => (error: unknown) => {
    const code = (error as { code?: unknown }).code;
    throw new Error(
      `${relative(resolvedRoot, path) || "The root"} in the calibration folder ${root} could not be read${typeof code === "string" ? ` (${code})` : ""}`,
    );
  };
  /** Non-hidden entries of `directory` as files or directories (symlinks followed), in name order. */
  const entries = async (directory: string) => {
    const names = await readdir(directory).catch(unreadable(directory));
    return Promise.all(
      names
        .filter((name) => !name.startsWith("."))
        .sort()
        .map(async (name) => {
          const path = join(directory, name);
          // Bun's realpath turns a backslash into `/`, which can name another file.
          if (name.includes("\\")) {
            throw new Error(
              `${relative(resolvedRoot, path)} in the calibration folder ${root} has a backslash in its name; rename it`,
            );
          }
          const stats = await stat(path).catch(unreadable(path));
          return { name, path, isFile: stats.isFile(), isDirectory: stats.isDirectory() };
        }),
    );
  };
  const skipped: SkippedEntry[] = [];
  const skip = (path: string, reason: string) =>
    skipped.push({ path: relative(resolvedRoot, path), reason });
  /**
   * The listed file at `path` and its real location. Bun's `realpath` misreads
   * a backslash only in the path it is given, and no listed path has one (the
   * root and every name were checked); one in a symlink's target is kept.
   */
  const image = async (path: string): Promise<FolderImage> => ({
    resolved: await realpath(path).catch(unreadable(path)),
    shown: relative(resolvedRoot, path),
  });
  /** Files of `directory`, skipping anything else. */
  const files = async (directory: string) => {
    const found: FolderImage[] = [];
    for (const entry of await entries(directory)) {
      if (entry.isFile) found.push(await image(entry.path));
      else skip(entry.path, "not a file in a photo folder");
    }
    return found;
  };

  const subjects: FolderSubject[] = [];
  for (const entry of await entries(resolvedRoot)) {
    if (!entry.isDirectory) {
      skip(entry.path, "not in a Subject folder");
      continue;
    }
    const subject = {
      name: entry.name,
      photos: [] as FolderImage[],
      like: [] as FolderImage[],
      unlike: [] as FolderImage[],
    };
    for (const child of await entries(entry.path)) {
      if (child.isFile) subject.photos.push(await image(child.path));
      else if (child.isDirectory && child.name === "candidates") {
        for (const label of await entries(child.path)) {
          if (label.isDirectory && (label.name === "like" || label.name === "unlike")) {
            subject[label.name] = await files(label.path);
          } else skip(label.path, "not candidates/like or candidates/unlike");
        }
      } else skip(child.path, "not a photo or the candidates folder");
    }
    subjects.push(subject);
  }

  checkDirectory(resolvedRoot, `The calibration folder ${root}`, resolvedRoot);
  const checked = new Set([resolvedRoot]);
  for (const { photos, like, unlike } of subjects) {
    for (const { resolved, shown } of [...photos, ...like, ...unlike]) {
      const directory = dirname(resolved);
      if (checked.has(directory)) continue;
      checked.add(directory);
      // Files beside a symlinked image's real file are not the operator's to see named.
      const inFolder = directory.startsWith(resolvedRoot + sep) ? resolvedRoot : undefined;
      checkDirectory(directory, `Image ${shown} in the calibration folder ${root}`, inFolder);
    }
  }
  return { subjects, skipped } as unknown as CalibrationFolder;
}

/**
 * The environments the guard runs git under; a directory passes only if it
 * passes under both. Both have messages in English whatever the locale
 * (LC_ALL=C also overrides LANGUAGE), since "not a git repository" is recognised
 * by its text, and discovery across filesystems, so a folder on another volume
 * (external drive, disk image, tmpfs) inside no repository is found to be
 * outside one, while an image mounted inside a repository's folder is still
 * found inside it. One drops inherited GIT_* variables, which can hide a
 * repository (GIT_CEILING_DIRECTORIES, or a hook's GIT_DIR); the other keeps
 * them, since the operator's git uses them (GIT_DIR and GIT_WORK_TREE, which
 * can also make git refuse a folder outside that working tree, a different
 * global excludes file). Exported for tests.
 */
export const gitEnvironments = (): {
  env: Record<string, string | undefined>;
  settings: string;
  /** Whether a folder git places outside its working tree counts as outside (see `checkDirectoryUnder`). */
  outsideWorkTree: boolean;
}[] => {
  const pinned = { LC_ALL: "C", GIT_DISCOVERY_ACROSS_FILESYSTEM: "1" };
  const stripped = Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"));
  return [
    { env: { ...Object.fromEntries(stripped), ...pinned }, settings: "", outsideWorkTree: false },
    {
      env: { ...process.env, ...pinned },
      settings: " (with your GIT_* settings)",
      outsideWorkTree: Boolean(process.env.GIT_DIR || process.env.GIT_WORK_TREE),
    },
  ];
};

/** `git` (looked up on the process's PATH) in `directory`; failing to run it refuses the folder. */
function git(
  directory: string,
  args: readonly string[],
  env: Record<string, string | undefined>,
  what: string,
) {
  try {
    const executable = Bun.which("git", { PATH: process.env.PATH ?? "" });
    if (!executable) throw new Error("git was not found on PATH");
    const result = Bun.spawnSync([executable, "-C", directory, ...args], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  } catch (error) {
    throw new Error(
      `${what}: the never-committed check could not run git, so the folder is refused (${errorMessage(error)})`,
    );
  }
}

/** `checkDirectoryUnder` in every one of `gitEnvironments`. */
function checkDirectory(directory: string, what: string, namedFrom: string | undefined) {
  for (const environment of gitEnvironments()) {
    checkDirectoryUnder(directory, environment, what, namedFrom);
  }
}

/**
 * Throw unless git, under `env`, would add no file below `directory` (a real
 * path): it is outside every git working tree, or every file in it is ignored
 * and none is tracked. Asking about the files, not whether the folder itself is
 * ignored, matters: an ignore pattern can match the folder while git still adds
 * its files (`/`, or `*` with `!*.jpg` at a working tree's top). Only git's
 * discovery failure counts as "outside"; any other git failure (e.g. a worktree
 * whose admin folder is gone, a corrupt index) refuses, so a broken check never
 * passes. Every git call runs in `directory` itself and names it as a literal
 * `.`, so all of them find the same repository and no folder name is read as a
 * pathspec. A folder git places outside its working tree
 * (`--is-inside-work-tree` prints false) is refused: it lies in a git folder,
 * which another working tree can hold and add (a nested bare repository, a
 * `--separate-git-dir` folder, a `core.bare` repository's top). Only with
 * GIT_DIR or GIT_WORK_TREE exported, in the environment that keeps them, does
 * it count as outside (a folder outside that GIT_WORK_TREE); the stripped
 * environment still checks it. Errors name `what` (the item as the operator
 * knows it) and, when `namedFrom` is set (the calibration folder, which holds
 * the directory), the first file git would add or tracks, relative to it;
 * never the working tree or git's own output, which hold absolute paths. Limit: a repository bound to the folder only on git's command
 * line or in its config (`--work-tree`, `core.worktree`, e.g. a bare dotfiles
 * repository used through an alias) can't be seen.
 */
function checkDirectoryUnder(
  directory: string,
  environment: ReturnType<typeof gitEnvironments>[number],
  what: string,
  namedFrom: string | undefined,
) {
  const { env, settings, outsideWorkTree } = environment;
  const failed = (command: string, exitCode: number) =>
    new Error(
      `${what}: the never-committed check failed (git${settings} ${command} exited ${exitCode}), so the folder is refused`,
    );
  const keepOutside =
    "keep calibration photos outside any repository (or in a git-ignored folder without tracked files) so git won't pick them up";
  const inside = git(directory, ["rev-parse", "--is-inside-work-tree"], env, what);
  if (inside.exitCode !== 0) {
    if (/^fatal: not a git repository \(or any of the parent directories\)/m.test(inside.stderr)) {
      return;
    }
    throw failed("rev-parse", inside.exitCode);
  }
  if (inside.stdout.trim() === "false") {
    if (outsideWorkTree) return;
    throw new Error(
      `${what}: git${settings} finds it inside a repository's git folder, which a working tree around it could add; ${keepOutside}`,
    );
  }
  const first = (output: string) =>
    namedFrom === undefined
      ? ""
      : ` (first: ${relative(namedFrom, join(directory, output.split("\n")[0]!))})`;
  // quotePath off: names with umlauts print as they are, not as octal escapes.
  const listFiles = ["-c", "core.quotePath=false", "ls-files"];
  const untracked = git(
    directory,
    [...listFiles, "--others", "--exclude-standard", "--", "."],
    env,
    what,
  );
  if (untracked.exitCode !== 0) throw failed("ls-files --others", untracked.exitCode);
  if (untracked.stdout.trim() !== "") {
    throw new Error(
      `${what}: git${settings} doesn't ignore its files and would add them${first(untracked.stdout)}; ${keepOutside}`,
    );
  }
  const tracked = git(directory, [...listFiles, "--", "."], env, what);
  if (tracked.exitCode !== 0) throw failed("ls-files", tracked.exitCode);
  if (tracked.stdout.trim() !== "") {
    throw new Error(
      `${what}: git${settings} tracks files in it${first(tracked.stdout)}; ${keepOutside}`,
    );
  }
}
