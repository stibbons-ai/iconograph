import { describe, expect, test } from "bun:test";
import { chmod, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gitEnvironments, readCalibrationFolder } from "../src/calibration-folder";
import { git, isolateGitEnvironment, repository, withEnvironment } from "./git-environment";
import { temporaryDirectories } from "./temporary-directory";

isolateGitEnvironment();

const temporaryDirectory = temporaryDirectories("calibration-folder");

/** Create empty files (and their folders) under `root`. */
async function files(root: string, paths: readonly string[]) {
  for (const path of paths) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), "");
  }
}

describe("calibration folder layout", () => {
  test("lists each Subject's photos and labelled Candidates in name order, hidden files ignored", async () => {
    const root = await temporaryDirectory();
    await files(root, [
      "bob/2.jpg",
      "bob/1.heic",
      "bob/.DS_Store",
      "ada/1.jpg",
      "ada/candidates/like/b.png",
      "ada/candidates/like/a.png",
      "ada/candidates/unlike/c.png",
      "ada/candidates/like/.hidden.png",
      ".hidden-subject/1.jpg",
    ]);
    const folder = await readCalibrationFolder(root);
    const resolved = await realpath(root);
    const image = (shown: string) => ({ resolved: join(resolved, shown), shown });
    expect(folder.subjects).toEqual([
      {
        name: "ada",
        photos: [image("ada/1.jpg")],
        like: [image("ada/candidates/like/a.png"), image("ada/candidates/like/b.png")],
        unlike: [image("ada/candidates/unlike/c.png")],
      },
      {
        name: "bob",
        photos: [image("bob/1.heic"), image("bob/2.jpg")],
        like: [],
        unlike: [],
      },
    ]);
    expect(folder.skipped).toEqual([]);
  });

  test("follows symlinked photos and Subject folders", async () => {
    const elsewhere = await temporaryDirectory();
    await files(elsewhere, ["photos/1.jpg", "photos/2.jpg", "single.jpg"]);
    const root = await temporaryDirectory();
    await symlink(join(elsewhere, "photos"), join(root, "ada"));
    await mkdir(join(root, "bob"));
    await symlink(join(elsewhere, "single.jpg"), join(root, "bob", "1.jpg"));
    const { subjects } = await readCalibrationFolder(root);
    // Images are read from their real location, the one the guard checked, but shown as listed.
    expect(subjects.map(({ name, photos }) => [name, photos])).toEqual([
      [
        "ada",
        [
          { resolved: await realpath(join(elsewhere, "photos/1.jpg")), shown: "ada/1.jpg" },
          { resolved: await realpath(join(elsewhere, "photos/2.jpg")), shown: "ada/2.jpg" },
        ],
      ],
      ["bob", [{ resolved: await realpath(join(elsewhere, "single.jpg")), shown: "bob/1.jpg" }]],
    ]);
  });

  test("reports entries outside the layout as skipped, by path relative to the root", async () => {
    const root = await temporaryDirectory();
    await files(root, [
      "notes.txt",
      "ada/1.jpg",
      "ada/extra/1.jpg",
      "ada/candidates/maybe/1.png",
      "ada/candidates/stray.png",
      "ada/candidates/like/nested/1.png",
    ]);
    const { skipped } = await readCalibrationFolder(root);
    expect(skipped).toEqual([
      { path: "ada/candidates/like/nested", reason: "not a file in a photo folder" },
      { path: "ada/candidates/maybe", reason: "not candidates/like or candidates/unlike" },
      { path: "ada/candidates/stray.png", reason: "not candidates/like or candidates/unlike" },
      { path: "ada/extra", reason: "not a photo or the candidates folder" },
      { path: "notes.txt", reason: "not in a Subject folder" },
    ]);
  });

  test("rejects a missing folder and a file", async () => {
    const root = await temporaryDirectory();
    await expect(readCalibrationFolder(join(root, "missing"))).rejects.toThrow("could not be read");
    await files(root, ["file.jpg"]);
    await expect(readCalibrationFolder(join(root, "file.jpg"))).rejects.toThrow(
      "is not a directory",
    );
  });

  test("names an unreadable entry relative to the folder as given, never by absolute path", async () => {
    const root = await temporaryDirectory();
    await files(root, ["ada/1.jpg"]);
    await symlink(join(root, "nowhere.jpg"), join(root, "ada", "2.jpg"));
    const error = await readCalibrationFolder(root).catch((caught: Error) => caught);
    expect((error as Error).message).toBe(
      `ada/2.jpg in the calibration folder ${root} could not be read (ENOENT)`,
    );
  });

  test("refuses a folder with a backslash in its path, given or linked to", async () => {
    // Bun's realpath reads 'x\\y' as 'x/y', which exists here and would be read instead.
    const parent = await temporaryDirectory();
    await files(parent, ["x/y/ada/1.jpg", "x/y/bob/1.jpg", "x\\y/ada/1.jpg", "x\\y/bob/1.jpg"]);
    const given = join(parent, "x\\y");
    await expect(readCalibrationFolder(given)).rejects.toThrow(
      `The calibration folder ${given} has a backslash in its path, which Bun reads as a folder separator; rename it`,
    );
    const linked = join(parent, "cal");
    await symlink(given, linked);
    await expect(readCalibrationFolder(linked)).rejects.toThrow(
      `The calibration folder ${linked} has a backslash in its path`,
    );
  });

  test("refuses a name with a backslash, which Bun's realpath would read as a folder", async () => {
    const root = await temporaryDirectory();
    await files(root, ["bob/1.jpg", "ada/a\\b.jpg"]);
    const message = `ada/a\\b.jpg in the calibration folder ${root} has a backslash in its name; rename it`;
    await expect(readCalibrationFolder(root)).rejects.toThrow(message);
    // Also when 'a/b.jpg' exists, which 'a\\b.jpg' would otherwise resolve to.
    await files(root, ["ada/a/b.jpg"]);
    await expect(readCalibrationFolder(root)).rejects.toThrow(message);
  });
});

describe("never-committed guard", () => {
  const newRepository = () => repository(temporaryDirectory);
  const keepOutside =
    "keep calibration photos outside any repository (or in a git-ignored folder without tracked files) so git won't pick them up";
  /** The refusal; `first` names the first file, which only files inside the calibration folder get. */
  const wouldAdd = (what: string, first?: string) =>
    `${what}: git doesn't ignore its files and would add them${first === undefined ? "" : ` (first: ${first})`}; ${keepOutside}`;

  test("runs git with English messages and discovery across filesystems, with and without GIT_*", async () => {
    await withEnvironment({ GIT_DIR: "/some/repo.git", LC_ALL: "de_DE.UTF-8" }, async () => {
      const [stripped, inherited] = gitEnvironments();
      for (const { env } of [stripped!, inherited!]) {
        expect(env.LC_ALL).toBe("C");
        expect(env.GIT_DISCOVERY_ACROSS_FILESYSTEM).toBe("1");
      }
      expect(stripped!.env.GIT_DIR).toBeUndefined();
      expect(inherited!.env.GIT_DIR).toBe("/some/repo.git");
    });
  });

  test("refuses a folder inside a git working tree that git doesn't ignore", async () => {
    const repo = await newRepository();
    await files(repo, ["calibration/ada/1.jpg"]);
    const calibration = join(repo, "calibration");
    await expect(readCalibrationFolder(calibration)).rejects.toThrow(
      wouldAdd(`The calibration folder ${calibration}`, "ada/1.jpg"),
    );
    // The working tree itself is never ignored.
    await expect(readCalibrationFolder(repo)).rejects.toThrow("would add them");
  });

  test("accepts a git-ignored folder inside the working tree", async () => {
    const repo = await newRepository();
    await files(repo, [".data/calibration/ada/1.jpg", ".data/calibration/bob/1.jpg"]);
    await writeFile(join(repo, ".gitignore"), ".data/\n");
    const folder = await readCalibrationFolder(join(repo, ".data", "calibration"));
    expect(folder.subjects).toHaveLength(2);
  });

  test("refuses a folder an ignore pattern matches while git still adds its files", async () => {
    // A '/' line matches the folder 'cal/' itself, yet `git add` adds 'cal/ada/1.jpg'.
    const repo = await newRepository();
    await files(repo, ["cal/ada/1.jpg", "cal/bob/1.jpg"]);
    await writeFile(join(repo, ".gitignore"), "/\n");
    const calibration = join(repo, "cal");
    await expect(readCalibrationFolder(calibration)).rejects.toThrow(
      wouldAdd(`The calibration folder ${calibration}`, "ada/1.jpg"),
    );
    // '*' then '!*.jpg' at a working tree's top: the top folder matches '*', its photos don't.
    const whitelist = await newRepository();
    await files(whitelist, ["1.jpg"]);
    await writeFile(join(whitelist, ".gitignore"), "*\n!*.jpg\n");
    const outside = await temporaryDirectory();
    await files(outside, ["bob/1.jpg"]);
    await symlink(whitelist, join(outside, "ada"));
    await expect(readCalibrationFolder(outside)).rejects.toThrow(
      wouldAdd(`Image ada/1.jpg in the calibration folder ${outside}`),
    );
  });

  test("refuses an ignored folder that holds tracked files, saying so", async () => {
    const repo = await newRepository();
    await files(repo, ["private/ada/1.jpg"]);
    git(repo, "add", "private/ada/1.jpg");
    await writeFile(join(repo, ".gitignore"), "private/\n");
    const calibration = join(repo, "private");
    await expect(readCalibrationFolder(calibration)).rejects.toThrow(
      `The calibration folder ${calibration}: git tracks files in it (first: ada/1.jpg); ${keepOutside}`,
    );
  });

  test("refuses a folder with a leading ':' that an ignore rule for the unprefixed name does not cover", async () => {
    // As a pathspec, ':photos/cal' would mean 'photos/cal', which is ignored here.
    const repo = await newRepository();
    await files(repo, [":photos/cal/ada/1.jpg", ":photos/cal/bob/1.jpg"]);
    await writeFile(join(repo, ".gitignore"), "photos/\n");
    const calibration = join(repo, ":photos", "cal");
    await expect(readCalibrationFolder(calibration)).rejects.toThrow(
      wouldAdd(`The calibration folder ${calibration}`, "ada/1.jpg"),
    );
  });

  test("accepts a folder outside any git working tree, including symlinks to files outside", async () => {
    const elsewhere = await temporaryDirectory();
    await files(elsewhere, ["photos/1.jpg"]);
    const outside = await temporaryDirectory();
    await files(outside, ["ada/1.jpg"]);
    await symlink(join(elsewhere, "photos"), join(outside, "bob"));
    expect((await readCalibrationFolder(outside)).subjects).toHaveLength(2);
  });

  test("accepts a folder outside any working tree whatever language git speaks", async () => {
    // A git that answers in German unless LC_ALL=C, as a translated git does.
    const real = Bun.which("git")!;
    const shims = await temporaryDirectory();
    await writeFile(
      join(shims, "git"),
      `#!/bin/sh
if [ "$LC_ALL" != "C" ]; then
  echo "Schwerwiegend: Kein Git-Repository (oder irgendeines der Elternverzeichnisse): .git" >&2
  exit 128
fi
exec "${real}" "$@"
`,
    );
    await chmod(join(shims, "git"), 0o755);
    const outside = await temporaryDirectory();
    await files(outside, ["ada/1.jpg", "bob/1.jpg"]);
    const folder = await withEnvironment({ PATH: `${shims}:${process.env.PATH}` }, () =>
      readCalibrationFolder(outside),
    );
    expect(folder.subjects).toHaveLength(2);
  });

  test("refuses a folder the operator's git sees through GIT_DIR and GIT_WORK_TREE", async () => {
    // A bare repository over a plain folder, as a dotfiles setup over $HOME does.
    const bare = join(await temporaryDirectory(), "dotfiles.git");
    git(await temporaryDirectory(), "init", "--quiet", "--bare", bare);
    const home = await temporaryDirectory();
    await files(home, ["calibration/ada/1.jpg", "calibration/bob/1.jpg"]);
    const calibration = join(home, "calibration");
    await expect(
      withEnvironment({ GIT_DIR: bare, GIT_WORK_TREE: home }, () =>
        readCalibrationFolder(calibration),
      ),
    ).rejects.toThrow(
      `The calibration folder ${calibration}: git (with your GIT_* settings) doesn't ignore its files and would add them`,
    );
    // Without those variables the same folder is outside any repository.
    expect((await readCalibrationFolder(calibration)).subjects).toHaveLength(2);
  });

  test("judges a folder outside an exported GIT_WORK_TREE as outside it", async () => {
    // The tree has untracked files of its own; they must not refuse a folder outside it.
    const bare = join(await temporaryDirectory(), "dotfiles.git");
    git(await temporaryDirectory(), "init", "--quiet", "--bare", bare);
    const home = await temporaryDirectory();
    await files(home, ["notes.txt", "inside/ada/1.jpg", "inside/bob/1.jpg"]);
    const outside = await temporaryDirectory();
    await files(outside, ["ada/1.jpg", "bob/1.jpg"]);
    const variables = { GIT_DIR: bare, GIT_WORK_TREE: home };
    const folder = await withEnvironment(variables, () => readCalibrationFolder(outside));
    expect(folder.subjects).toHaveLength(2);
    const inside = join(home, "inside");
    await expect(withEnvironment(variables, () => readCalibrationFolder(inside))).rejects.toThrow(
      `The calibration folder ${inside}: git (with your GIT_* settings) doesn't ignore its files`,
    );
  });

  test("names the first file relative to the calibration folder, also for a linked image", async () => {
    // ada/l.jpg links to eve/real.jpg, and eve is a repository of its own.
    const root = await temporaryDirectory();
    await files(root, ["eve/real.jpg"]);
    await mkdir(join(root, "ada"));
    await symlink(join("..", "eve", "real.jpg"), join(root, "ada", "l.jpg"));
    git(join(root, "eve"), "init", "--quiet");
    await expect(readCalibrationFolder(root)).rejects.toThrow(
      wouldAdd(`Image ada/l.jpg in the calibration folder ${root}`, "eve/real.jpg"),
    );
  });

  test("names the first file git would add, even a hidden one", async () => {
    const repo = await newRepository();
    await files(repo, ["cal/.DS_Store", "cal/ada/1.jpg", "cal/bob/1.jpg"]);
    await writeFile(join(repo, ".gitignore"), "*.jpg\n");
    const calibration = join(repo, "cal");
    await expect(readCalibrationFolder(calibration)).rejects.toThrow(
      wouldAdd(`The calibration folder ${calibration}`, ".DS_Store"),
    );
  });

  test("refuses a folder inside a git folder that another working tree holds", async () => {
    // outer's `git add -A` adds sub.git/cal/ada/1.jpg, though from cal git sees only sub.git.
    const outer = await newRepository();
    git(outer, "init", "--quiet", "--bare", "sub.git");
    await files(outer, ["sub.git/cal/ada/1.jpg", "sub.git/cal/bob/1.jpg"]);
    const nested = join(outer, "sub.git", "cal");
    await expect(readCalibrationFolder(nested)).rejects.toThrow(
      `The calibration folder ${nested}: git finds it inside a repository's git folder, which a working tree around it could add; ${keepOutside}`,
    );
    // A repository marked bare at its top.
    const bare = await newRepository();
    git(bare, "config", "core.bare", "true");
    await files(bare, ["cal/ada/1.jpg", "cal/bob/1.jpg"]);
    await expect(readCalibrationFolder(join(bare, "cal"))).rejects.toThrow(
      "inside a repository's git folder",
    );
  });

  test("names the operator's GIT_* settings when git fails with them", async () => {
    const outside = await temporaryDirectory();
    await files(outside, ["ada/1.jpg", "bob/1.jpg"]);
    const missing = join(await temporaryDirectory(), "missing.git");
    await expect(
      withEnvironment({ GIT_DIR: missing }, () => readCalibrationFolder(outside)),
    ).rejects.toThrow(
      `The calibration folder ${outside}: the never-committed check failed (git (with your GIT_* settings) rev-parse exited 128), so the folder is refused`,
    );
  });

  test("refuses a folder whose files the operator's GIT_* settings track, saying so", async () => {
    const bare = join(await temporaryDirectory(), "dotfiles.git");
    git(await temporaryDirectory(), "init", "--quiet", "--bare", bare);
    const home = await temporaryDirectory();
    await files(home, ["cal/ada/1.jpg", "cal/bob/1.jpg"]);
    git(home, `--git-dir=${bare}`, `--work-tree=${home}`, "add", "cal");
    const calibration = join(home, "cal");
    await expect(
      withEnvironment({ GIT_DIR: bare, GIT_WORK_TREE: home }, () =>
        readCalibrationFolder(calibration),
      ),
    ).rejects.toThrow(
      `The calibration folder ${calibration}: git (with your GIT_* settings) tracks files in it (first: ada/1.jpg); ${keepOutside}`,
    );
  });

  test("refuses a folder when git can't list its tracked files", async () => {
    // A git that fails listing tracked files, as on a damaged repository.
    const real = Bun.which("git")!;
    const shims = await temporaryDirectory();
    await writeFile(
      join(shims, "git"),
      `#!/bin/sh
case "$*" in
  *ls-files*--others*) ;;
  *ls-files*) exit 128 ;;
esac
exec "${real}" "$@"
`,
    );
    await chmod(join(shims, "git"), 0o755);
    const repo = await newRepository();
    await files(repo, [".data/cal/ada/1.jpg", ".data/cal/bob/1.jpg"]);
    await writeFile(join(repo, ".gitignore"), ".data/\n");
    const calibration = join(repo, ".data", "cal");
    await expect(
      withEnvironment({ PATH: `${shims}:${process.env.PATH}` }, () =>
        readCalibrationFolder(calibration),
      ),
    ).rejects.toThrow(
      `The calibration folder ${calibration}: the never-committed check failed (git ls-files exited 128), so the folder is refused`,
    );
  });

  test("names files with umlauts as they are", async () => {
    const repo = await newRepository();
    await files(repo, ["cal/jürgen/1.jpg", "cal/bob/1.jpg"]);
    const calibration = join(repo, "cal");
    await expect(readCalibrationFolder(calibration)).rejects.toThrow(
      wouldAdd(`The calibration folder ${calibration}`, "bob/1.jpg"),
    );
    await rm(join(repo, "cal", "bob"), { recursive: true });
    await files(repo, ["cal/zed/1.jpg"]);
    await expect(readCalibrationFolder(calibration)).rejects.toThrow(
      wouldAdd(`The calibration folder ${calibration}`, "jürgen/1.jpg"),
    );
  });

  test("refuses a folder GIT_CEILING_DIRECTORIES would hide from git", async () => {
    const repo = await newRepository();
    await files(repo, ["calibration/ada/1.jpg", "calibration/bob/1.jpg"]);
    const calibration = join(repo, "calibration");
    await expect(
      withEnvironment({ GIT_CEILING_DIRECTORIES: await realpath(repo) }, () =>
        readCalibrationFolder(calibration),
      ),
    ).rejects.toThrow(wouldAdd(`The calibration folder ${calibration}`, "ada/1.jpg"));
  });

  test("accepts an image symlinked into a git-ignored folder of a working tree", async () => {
    const repo = await newRepository();
    await files(repo, [".data/photos/1.jpg"]);
    await writeFile(join(repo, ".gitignore"), ".data/\n");
    const outside = await temporaryDirectory();
    await files(outside, ["bob/1.jpg"]);
    await mkdir(join(outside, "ada"));
    await symlink(join(repo, ".data", "photos", "1.jpg"), join(outside, "ada", "1.jpg"));
    expect((await readCalibrationFolder(outside)).subjects).toHaveLength(2);
  });

  test("refuses symlinked photos and Candidates into a folder of a working tree git doesn't ignore", async () => {
    const repo = await newRepository();
    await files(repo, ["plain/s1/1.jpg", "plain/c/x.png"]);
    const outside = await temporaryDirectory();
    await files(outside, ["bob/1.jpg"]);
    await symlink(join(repo, "plain", "s1"), join(outside, "ada"));
    const error = await readCalibrationFolder(outside).catch((caught: Error) => caught);
    expect((error as Error).message).toBe(
      wouldAdd(`Image ada/1.jpg in the calibration folder ${outside}`),
    );
    // Where the photos really live stays private.
    expect((error as Error).message).not.toContain(repo);
    expect((error as Error).message).not.toContain(await realpath(repo));
    // A single symlinked Candidate is caught too.
    const single = await temporaryDirectory();
    await files(single, ["ada/1.jpg", "bob/1.jpg"]);
    await mkdir(join(single, "ada", "candidates", "like"), { recursive: true });
    await symlink(
      join(repo, "plain", "c", "x.png"),
      join(single, "ada", "candidates", "like", "x.png"),
    );
    await expect(readCalibrationFolder(single)).rejects.toThrow(
      wouldAdd(`Image ada/candidates/like/x.png in the calibration folder ${single}`),
    );
  });

  test("refuses a folder in a worktree whose admin folder is gone", async () => {
    const repo = await newRepository();
    await files(repo, ["README"]);
    git(repo, "add", "README");
    git(
      repo,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "init",
    );
    const worktree = join(await temporaryDirectory(), "wt");
    git(repo, "worktree", "add", "--quiet", worktree);
    await files(worktree, ["photos/ada/1.jpg"]);
    await rm(join(repo, ".git", "worktrees"), { recursive: true, force: true });
    const photos = join(worktree, "photos");
    await expect(readCalibrationFolder(photos)).rejects.toThrow(
      `The calibration folder ${photos}: the never-committed check failed (git rev-parse exited 128), so the folder is refused`,
    );
  });

  test("refuses a folder when git can't list its files (corrupt index)", async () => {
    const repo = await newRepository();
    await files(repo, ["photos/ada/1.jpg"]);
    await writeFile(join(repo, ".git", "index"), "garbage");
    const photos = join(repo, "photos");
    await expect(readCalibrationFolder(photos)).rejects.toThrow(
      `The calibration folder ${photos}: the never-committed check failed (git ls-files --others exited 128), so the folder is refused`,
    );
  });

  test("refuses the folder when git can't be run", async () => {
    const outside = await temporaryDirectory();
    await files(outside, ["ada/1.jpg", "bob/1.jpg"]);
    await expect(
      withEnvironment({ PATH: "" }, () => readCalibrationFolder(outside)),
    ).rejects.toThrow(
      `The calibration folder ${outside}: the never-committed check could not run git, so the folder is refused`,
    );
  });
});
