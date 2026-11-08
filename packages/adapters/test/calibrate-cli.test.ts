import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, readdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { calibrationRules } from "@iconograph/domain";
import { Layer } from "effect";
import sharp from "sharp";
import { type CalibrationReport, main } from "../src/calibrate-cli";
import { sfaceConfig } from "../src/face-embedder";
import { facenetConfig } from "../src/held-out-embedder";
import { dataVolume, fixture, realFaceEmbedder, realHeldOutEmbedder } from "./face-models";
import { git, isolateGitEnvironment, repository, withEnvironment } from "./git-environment";
import { spawnCli } from "./spawn-cli";
import { temporaryDirectories } from "./temporary-directory";

const temporaryDirectory = temporaryDirectories("calibrate-cli");
isolateGitEnvironment();

const realEmbedders = () => Layer.mergeAll(realFaceEmbedder(), realHeldOutEmbedder());

async function run(args: string[]): Promise<CalibrationReport> {
  let output = "";
  await main(args, { embedders: realEmbedders, stdout: (text) => (output += text) });
  return JSON.parse(output);
}

const neverLoaded = () => {
  throw new Error("model loaded");
};

/**
 * A calibration folder of fixture copies outside the repository (symlinks into
 * the repository would be refused by the never-committed guard): Biden and
 * Obama as Subjects, a photo without a face, and Candidates labelled like
 * (Biden's 2021 portrait as HEIC) and unlike (Obama mirrored, so its pixels
 * differ from his real photo).
 */
async function fixtureFolder() {
  const root = join(await temporaryDirectory(), "calibration");
  const place = async (path: string, name: string) => {
    await mkdir(join(root, path, ".."), { recursive: true });
    await copyFile(fixture(name), join(root, path));
  };
  await place("biden/2013.jpg", "biden-2013.jpg");
  await place("biden/2021.jpg", "biden-2021.jpg");
  await place("biden/2022.jpg", "biden-2022.jpg");
  await place("biden/earth.jpg", "earth-apollo17.jpg");
  await place("biden/candidates/like/2021.heic", "biden-2021.heic");
  await place("obama/2012.jpg", "obama-2012.jpg");
  await place("obama/group.jpg", "obama-biden-2015.jpg");
  await mkdir(join(root, "biden/candidates/unlike"), { recursive: true });
  await sharp(fixture("obama-2012.jpg"))
    .flop()
    .toFile(join(root, "biden/candidates/unlike/obama-mirrored.jpg"));
  await Bun.write(join(root, ".DS_Store"), "");
  return root;
}

describe("faces:calibrate in-process", () => {
  test("reports per-model distributions, rates and suggestions for real and Candidate pairs", async () => {
    const root = await fixtureFolder();
    const report = await run([root]);
    // Neither the folder nor its real location appears in the report.
    expect(report).not.toHaveProperty("root");
    expect(JSON.stringify(report)).not.toContain(root);
    expect(JSON.stringify(report)).not.toContain(await realpath(root));
    expect(Object.keys(report)).toEqual([
      "targetFar",
      "rules",
      "subjects",
      "skipped",
      "models",
      "warnings",
    ]);
    // The sets the thresholds come from lead.
    expect(Object.keys(report.models.facenet)).toEqual([
      "model",
      "configured",
      "realAnchor",
      "candidateAnchor",
      "real",
      "candidatePhoto",
    ]);
    expect(Object.keys(report.models.sface.realAnchor)).toEqual([
      "same",
      "different",
      "rates",
      "suggestion",
      "equalErrorRate",
      "warnings",
    ]);
    expect(Object.keys(report.models.sface)).toEqual([
      "model",
      "configured",
      "realAnchor",
      "candidateAnchor",
      "real",
      "candidatePhoto",
      "ceiling",
    ]);
    expect(report.targetFar).toBe(0.01);
    expect(report.rules).toEqual(calibrationRules);
    expect(report.subjects).toEqual([
      { name: "biden", photos: 3, like: 1, unlike: 1 },
      { name: "obama", photos: 1, like: 0, unlike: 0 },
    ]);
    // Skipped images are named relative to the folder, never by absolute path.
    expect(report.skipped).toEqual([
      { path: "biden/earth.jpg", reason: "no face" },
      { path: "obama/group.jpg", reason: "2 faces" },
    ]);
    expect(report.warnings).toEqual([]);

    const { sface, facenet } = report.models;
    expect(sface.model).toBe("sface");
    expect(sface.configured).toEqual(sfaceConfig.thresholds);
    expect(facenet.model).toBe("facenet");
    expect(facenet.configured).toEqual({ threshold: facenetConfig.threshold });

    for (const model of [sface, facenet]) {
      // 3 Biden pairs; 3 Biden × 1 Obama pairs.
      expect(model.real.same?.count).toBe(3);
      expect(model.real.different?.count).toBe(3);
      // Pairwise sets are context only.
      expect(model.real).not.toHaveProperty("suggestion");
      expect(model.candidatePhoto).not.toHaveProperty("equalErrorRate");
      expect(model.real.warnings).toContain("Only 3 same-person pairs (fewer than 30)");
      // Each Biden photo against the anchor of his other two; across: Biden's 3 photos against
      // Obama's anchor and Obama's photo against Biden's anchor.
      expect(model.realAnchor.same?.count).toBe(3);
      expect(model.realAnchor.different?.count).toBe(4);
      // Fixtures are widely separated: the suggestion lies in the gap and costs no FRR.
      const gate = model.realAnchor.suggestion!;
      expect(gate.threshold).toBeGreaterThan(model.realAnchor.different!.max);
      expect(gate.threshold).toBeLessThanOrEqual(model.realAnchor.same!.min);
      expect(gate).toMatchObject({ far: 0, frr: 0 });
      const eer = model.realAnchor.equalErrorRate!;
      expect(eer.threshold).toBeGreaterThan(model.realAnchor.different!.max);
      expect(eer.threshold).toBeLessThanOrEqual(model.realAnchor.same!.min);
      // Against an anchor, same-person similarity is higher than photo against photo.
      expect(model.realAnchor.same!.median).toBeGreaterThan(model.real.same!.median);
      // The like Candidate pairs with Biden's 3 photos and his anchor, the unlike one too.
      expect(model.candidatePhoto?.same?.count).toBe(3);
      expect(model.candidatePhoto?.different?.count).toBe(3);
      expect(model.candidateAnchor?.same?.count).toBe(1);
      expect(model.candidateAnchor?.different?.count).toBe(1);
      expect(model.candidateAnchor!.same!.min).toBeGreaterThan(
        model.candidateAnchor!.different!.max,
      );
    }
    // The configured values are in the rate tables.
    expect(sface.real.rates.map(({ threshold }) => threshold)).toContain(
      sfaceConfig.thresholds.identityGate,
    );
    expect(facenet.real.rates.map(({ threshold }) => threshold)).toContain(facenetConfig.threshold);
    // Evidence from the issue: SFace same-person 0.63–0.79 vs different 0.14; FaceNet 0.80+ vs < 0.13.
    expect(sface.real.same!.min).toBeGreaterThan(0.6);
    expect(sface.real.different!.max).toBeLessThan(0.3);
    expect(facenet.real.same!.min).toBeGreaterThan(0.75);
    expect(facenet.real.different!.max).toBeLessThan(0.3);

    expect(sface.ceiling).toEqual({
      suggested: sface.real.same!.median,
      pooledMedian: sface.real.same!.median,
      subjects: [{ name: "biden", value: sface.real.same!.median, pairs: 3 }],
    });
    expect(facenet).not.toHaveProperty("ceiling");
  });

  test("takes the target FAR from --target-far", async () => {
    const report = await run(["--target-far", "0.5", await fixtureFolder()]);
    expect(report.targetFar).toBe(0.5);
    // Half of the 4 different anchor pairs may be accepted: the suggestion drops below the top two.
    const { realAnchor } = report.models.sface;
    expect(realAnchor.suggestion!.threshold).toBeLessThanOrEqual(realAnchor.different!.max);
    expect(realAnchor.suggestion!.far).toBe(0.5);
  });

  test("rejects too few usable Subjects or photos once faceless photos are skipped", async () => {
    const root = join(await temporaryDirectory(), "calibration");
    await mkdir(join(root, "biden"), { recursive: true });
    await mkdir(join(root, "obama"), { recursive: true });
    await copyFile(fixture("biden-2013.jpg"), join(root, "biden", "2013.jpg"));
    await copyFile(fixture("biden-2022.jpg"), join(root, "biden", "2022.jpg"));
    await copyFile(fixture("earth-apollo17.jpg"), join(root, "obama", "earth.jpg"));
    await Bun.write(join(root, "notes.txt"), "");
    await expect(run([root])).rejects.toThrow(
      "Calibration needs real photos of at least 2 Subjects (one folder each), got 1; skipped: notes.txt (not in a Subject folder), obama/earth.jpg (no face)",
    );
  });

  test("warns about Candidates of a Subject whose real photos all lack a face", async () => {
    const root = await fixtureFolder();
    await mkdir(join(root, "nobody", "candidates", "like"), { recursive: true });
    // Mirrored, so their pixels differ from the copies already in the folder.
    await sharp(fixture("earth-apollo17.jpg"))
      .flop()
      .toFile(join(root, "nobody", "earth.jpg"));
    await sharp(fixture("biden-2022.jpg"))
      .flop()
      .toFile(join(root, "nobody", "candidates", "like", "biden.jpg"));
    const report = await run([root]);
    expect(report.subjects).toContainEqual({ name: "nobody", photos: 0, like: 1, unlike: 0 });
    expect(report.warnings).toEqual([
      "Subject nobody has no real photo with one face, so its Candidates are left unpaired",
    ]);
  });

  test("rejects the same image twice, by relative path", async () => {
    const root = await fixtureFolder();
    await copyFile(fixture("biden-2013.jpg"), join(root, "obama", "copy.jpg"));
    await expect(run([root])).rejects.toMatchObject({
      photo: "obama/copy.jpg",
      message: "Images biden/2013.jpg and obama/copy.jpg are the same image",
    });
  });

  test("names an undecodable photo relative to the folder", async () => {
    const root = await fixtureFolder();
    await Bun.write(join(root, "obama", "notes.jpg"), "plain text");
    const error = await run([root]).catch((caught: Error & { photo?: string }) => caught);
    expect(error).toMatchObject({ photo: "obama/notes.jpg" });
    expect((error as Error).message).toStartWith("Photo obama/notes.jpg could not be decoded");
    expect((error as Error).message).not.toContain(root);
  });

  test("checks arguments, the folder and the git guard before loading any model", async () => {
    await expect(main([], { embedders: neverLoaded })).rejects.toThrow(
      "Expected one calibration folder, got 0 paths",
    );
    for (const rate of ["1", "-0.1", "", "abc"]) {
      await expect(
        main([`--target-far=${rate}`, "folder"], { embedders: neverLoaded }),
      ).rejects.toThrow("--target-far expects a rate in [0, 1)");
    }
    const lonely = join(await temporaryDirectory(), "calibration");
    await mkdir(join(lonely, "ada"), { recursive: true });
    await copyFile(fixture("biden-2013.jpg"), join(lonely, "ada", "1.jpg"));
    await expect(main([lonely], { embedders: neverLoaded })).rejects.toThrow("at least 2 Subjects");
    // A folder inside a working tree git doesn't ignore.
    const repo = await repository(temporaryDirectory);
    const inRepo = join(repo, "calibration");
    await mkdir(join(inRepo, "ada"), { recursive: true });
    await mkdir(join(inRepo, "bob"), { recursive: true });
    await copyFile(fixture("biden-2013.jpg"), join(inRepo, "ada", "1.jpg"));
    await copyFile(fixture("obama-2012.jpg"), join(inRepo, "bob", "1.jpg"));
    await expect(main([inRepo], { embedders: neverLoaded })).rejects.toThrow(
      `The calibration folder ${inRepo}: git doesn't ignore its files and would add them`,
    );
  });
});

describe("faces:calibrate as a process", () => {
  const cli = fileURLToPath(new URL("../src/calibrate-cli.ts", import.meta.url));
  const spawn = (args: string[]) => spawnCli([cli, ...args]);

  test("exits 0 with the report on stdout and nothing on stderr, storing nothing", async () => {
    const data = await dataVolume(temporaryDirectory, ["yunet", "sface", "facenet"]);
    const root = await fixtureFolder();
    const before = (await readdir(root, { recursive: true })).sort();
    const { stdout, stderr, exitCode } = await spawn(["--data-dir", data, root]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const report: CalibrationReport = JSON.parse(stdout);
    expect(report.models.sface.real.same?.count).toBe(3);
    expect(await readdir(data)).toEqual(["models"]);
    expect((await readdir(root, { recursive: true })).sort()).toEqual(before);
  });

  test("refuses, as a process, a folder the operator's GIT_DIR and GIT_WORK_TREE cover", async () => {
    // A bare repository over the folder's parent; the spawned CLI must see these variables.
    const bare = join(await temporaryDirectory(), "dotfiles.git");
    git(await temporaryDirectory(), "init", "--quiet", "--bare", bare);
    const root = await fixtureFolder();
    const { stderr, exitCode } = await withEnvironment(
      { GIT_DIR: bare, GIT_WORK_TREE: dirname(root) },
      async () => spawn([root]),
    );
    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr).error).toStartWith(
      `The calibration folder ${root}: git (with your GIT_* settings) doesn't ignore its files`,
    );
  });

  test("exits nonzero with a JSON error for a missing folder", async () => {
    const missing = join(await temporaryDirectory(), "missing");
    const { stderr, exitCode } = await spawn([missing]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/^\{.*\}\n$/);
    expect(JSON.parse(stderr).error).toStartWith(
      `The calibration folder ${missing} could not be read`,
    );
  });
});
