import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Effect } from "effect";
import sharp from "sharp";
import { facenetConfig } from "../src/held-out-embedder";
import { type HeldOutReport, main } from "../src/heldout-cli";
import { decodeReferencePhoto } from "../src/reference-photos";
import { dataVolume, fixture, realHeldOutEmbedder, rightmostFace, spawnCli } from "./face-models";
import { temporaryDirectories } from "./temporary-directory";

const temporaryDirectory = temporaryDirectories("heldout-cli");

async function run(args: string[]): Promise<HeldOutReport> {
  let output = "";
  await main(args, { embedder: () => realHeldOutEmbedder(), stdout: (text) => (output += text) });
  return JSON.parse(output);
}

describe("faces:heldout in-process", () => {
  test("passes the Subject against the held-out anchor of their Reference Photos", async () => {
    const report = await run([
      fixture("biden-2022.jpg"),
      fixture("biden-2013.jpg"),
      fixture("biden-2021.jpg"),
    ]);
    expect(report.model).toBe("facenet");
    expect(report.threshold).toBe(facenetConfig.threshold);
    expect(report.candidate.path).toBe(fixture("biden-2022.jpg"));
    expect(report.references.map(({ photo, path }) => ({ photo, path }))).toEqual([
      { photo: 1, path: fixture("biden-2013.jpg") },
      { photo: 2, path: fixture("biden-2021.jpg") },
    ]);
    for (const { similarity } of report.references) {
      expect(similarity).toBeGreaterThanOrEqual(facenetConfig.threshold);
    }
    expect(report.anchorSimilarity).toBeGreaterThanOrEqual(facenetConfig.threshold);
    expect(report.pass).toBe(true);
  });

  test("fails a different person", async () => {
    const report = await run([
      fixture("obama-2012.jpg"),
      fixture("biden-2013.jpg"),
      fixture("biden-2021.jpg"),
    ]);
    expect(report.anchorSimilarity).toBeLessThan(facenetConfig.threshold);
    expect(report.pass).toBe(false);
  });

  test("takes face choices as photos:validate does when a photo shows several faces", async () => {
    const group = fixture("obama-biden-2015.jpg");
    const error = await run([group, fixture("biden-2013.jpg")]).catch((caught: Error) => caught);
    expect(error).toMatchObject({ photo: group });
    expect((error as Error).message).toContain(`Candidate ${group} shows 2 faces; choose one`);
    const faces = JSON.parse((error as Error).message.slice((error as Error).message.indexOf("[")));
    const biden = String(rightmostFace(faces));
    // Biden in the group photo, as Candidate and as Reference Photo 2.
    const asCandidate = await run(["--candidate-face", biden, group, fixture("biden-2013.jpg")]);
    expect(asCandidate.candidate.face.face).toBe(Number(biden));
    expect(asCandidate.pass).toBe(true);
    const asReference = await run([
      "--face",
      `2:${biden}`,
      fixture("biden-2021.jpg"),
      fixture("biden-2013.jpg"),
      group,
    ]);
    expect(asReference.references[1]?.face.face).toBe(Number(biden));
    expect(asReference.pass).toBe(true);
  });

  test("rejects a missing Candidate, 0 or more than 8 Reference Photos before loading any model", async () => {
    const neverLoaded = () => {
      throw new Error("model loaded");
    };
    for (const count of [0, 1, 10]) {
      const paths = Array.from({ length: count }, (_, index) => `photo-${index}.jpg`);
      await expect(main(paths, { embedder: neverLoaded })).rejects.toThrow(
        `Expected a Candidate and 1 to 8 Reference Photo paths, got ${count} paths`,
      );
    }
    await expect(
      main(["--candidate-face", "0", "a.jpg", "b.jpg"], { embedder: neverLoaded }),
    ).rejects.toThrow("--candidate-face expects a face number from 1");
  });

  test("rejects a Candidate without a face and the same Reference Photo twice", async () => {
    const earth = fixture("earth-apollo17.jpg");
    await expect(run([earth, fixture("biden-2013.jpg")])).rejects.toThrow(
      `Candidate ${earth} shows no face`,
    );
    await expect(
      run([fixture("biden-2022.jpg"), fixture("biden-2013.jpg"), fixture("biden-2013.jpg")]),
    ).rejects.toThrow("are the same file");
  });

  /** `name`'s decoded pixels re-encoded losslessly as PNG: other bytes, the same image. */
  async function samePixelsAsPng(name: string) {
    const { image } = await Effect.runPromise(decodeReferencePhoto(fixture(name)));
    const path = join(await temporaryDirectory(), `${name}.png`);
    await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 3 } })
      .png()
      .toFile(path);
    return path;
  }

  test("rejects the Candidate given again as a Reference Photo, by path or by pixels", async () => {
    const candidate = fixture("biden-2022.jpg");
    await expect(run([candidate, fixture("biden-2013.jpg"), candidate])).rejects.toThrow(
      `The Candidate ${candidate} and Reference Photo ${candidate} are the same file`,
    );
    const copy = await samePixelsAsPng("biden-2022.jpg");
    await expect(run([candidate, fixture("biden-2013.jpg"), copy])).rejects.toMatchObject({
      photo: copy,
      message: `The Candidate ${candidate} and Reference Photo ${copy} are the same image`,
    });
  });

  test("names an unreadable or undecodable Candidate as the Candidate", async () => {
    const directory = await temporaryDirectory();
    const missing = join(directory, "missing.jpg");
    await expect(run([missing, fixture("biden-2013.jpg")])).rejects.toThrow(
      `Candidate ${missing} could not be read`,
    );
    const notAnImage = join(directory, "not-an-image.jpg");
    await Bun.write(notAnImage, "plain text");
    await expect(run([notAnImage, fixture("biden-2013.jpg")])).rejects.toThrow(
      `Candidate ${notAnImage} could not be decoded`,
    );
  });

  test("rejects two Reference Photos with identical pixels", async () => {
    const copy = await samePixelsAsPng("biden-2013.jpg");
    await expect(
      run([fixture("biden-2022.jpg"), fixture("biden-2013.jpg"), copy]),
    ).rejects.toMatchObject({
      photo: copy,
      message: `Reference Photos ${fixture("biden-2013.jpg")} and ${copy} are the same image`,
    });
  });

  test("accepts exactly 8 Reference Photos", async () => {
    const directory = await temporaryDirectory();
    // Mirrored copies give distinct images of the Subject beyond the fixtures.
    const mirrored = await Promise.all(
      ["biden-2013.jpg", "biden-2021.jpg", "biden-2022.jpg"].map(async (name) => {
        const path = join(directory, `mirrored-${name}`);
        await sharp(fixture(name)).flop().toFile(path);
        return path;
      }),
    );
    const references = [
      fixture("biden-2013.jpg"),
      fixture("biden-2021.jpg"),
      fixture("biden-2021.heic"),
      fixture("biden-2013-gps-rotated.jpg"),
      fixture("obama-2012.jpg"),
      ...mirrored,
    ];
    const report = await run([fixture("biden-2022.jpg"), ...references]);
    expect(report.references.map(({ path }) => path)).toEqual(references);
  });

  test("the threshold is the 0.52 calibrated in issue #11 (ADR-0008)", () => {
    expect(facenetConfig.threshold).toBe(0.52);
  });
});

describe("faces:heldout as a process", () => {
  const spawn = (args: string[]) => spawnCli("heldout-cli.ts", args);
  const heldOutVolume = () => dataVolume(temporaryDirectory, ["yunet", "facenet"]);

  test("exits 0 with the report on stdout", async () => {
    const data = await heldOutVolume();
    const child = spawn(["--data-dir", data, fixture("biden-2021.jpg"), fixture("biden-2013.jpg")]);
    expect(await child.exited).toBe(0);
    const report: HeldOutReport = JSON.parse(await new Response(child.stdout).text());
    expect(report.pass).toBe(true);
  });

  test("exits nonzero with a JSON error for a missing Candidate or an unreadable photo", async () => {
    const none = spawn([]);
    expect(await none.exited).toBe(1);
    expect(JSON.parse(await new Response(none.stderr).text())).toEqual({
      error:
        "Expected a Candidate and 1 to 8 Reference Photo paths, got 0 paths; use --help for usage",
    });

    const data = await heldOutVolume();
    const missing = join(data, "missing.jpg");
    const unreadable = spawn(["--data-dir", data, missing, fixture("biden-2013.jpg")]);
    expect(await unreadable.exited).toBe(1);
    const stderr = await new Response(unreadable.stderr).text();
    expect(stderr).toMatch(/^\{.*\}\n?$/);
    expect(JSON.parse(stderr)).toMatchObject({ photo: missing });
  });
});
