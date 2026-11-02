import { describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FaceEmbedder } from "@iconograph/domain";
import { Effect, Layer } from "effect";
import { sfaceConfig } from "../src/face-embedder";
import type { ReferencePhotoReport } from "../src/reference-photos";
import { main } from "../src/photos-cli";
import {
  corruptAllWeights,
  dataVolume,
  fixture,
  realFaceEmbedder,
  rightmostFace,
  spawnCli,
} from "./face-models";
import { expectStripped } from "./metadata";
import { temporaryDirectories } from "./temporary-directory";

const temporaryDirectory = temporaryDirectories("cli");

async function run(args: string[]) {
  let output = "";
  await main(args, { embedder: () => realFaceEmbedder(), stdout: (text) => (output += text) });
  return output;
}

test("a warning logged while the backend shuts down goes to stderr as JSON, not stdout", async () => {
  // A backend whose finalizer warns, as a failed model release does.
  const warning = Layer.effect(FaceEmbedder)(
    Effect.acquireRelease(
      Effect.succeed({
        model: "fake",
        thresholds: sfaceConfig.thresholds,
        detect: () => Effect.succeed([]),
        embed: () => Effect.die("unreachable"),
      }),
      () => Effect.logWarning("probe-warning"),
    ),
  );
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  let output = "";
  try {
    await main(["--data-dir", await temporaryDirectory(), fixture("earth-apollo17.jpg")], {
      embedder: () => warning,
      stdout: (text) => (output += text),
    });
    expect(log).not.toHaveBeenCalled();
    const lines = error.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(lines).toEqual([expect.objectContaining({ level: "WARN", message: "probe-warning" })]);
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  expect(JSON.parse(output).photos[0].verdict).toBe("rejected");
});

describe("photos:validate in-process", () => {
  test("rejects 0 or more than 8 photos before loading any model", async () => {
    const neverLoaded = () => {
      throw new Error("model loaded");
    };
    for (const count of [0, 9]) {
      const paths = Array.from({ length: count }, () => fixture("biden-2022.jpg"));
      await expect(main(paths, { embedder: neverLoaded })).rejects.toThrow(
        `Expected 1 to 8 photo paths, got ${count}`,
      );
    }
  });

  test("rejects malformed or repeated face choices", async () => {
    for (const choice of ["2", "0:1", "1:x", "1:2:3"]) {
      await expect(run(["--face", choice, fixture("biden-2022.jpg")])).rejects.toThrow(
        "--face expects PHOTO:FACE",
      );
    }
    await expect(
      run(["--face", "1:1", "--face", "1:2", fixture("obama-biden-2015.jpg")]),
    ).rejects.toThrow("--face given twice for photo 1");
  });

  test("prints one JSON report with a verdict per photo for a mixed set", async () => {
    const data = await temporaryDirectory();
    // Ask without a choice first, then choose the Subject (Biden, on the right) by position.
    const first: ReferencePhotoReport = JSON.parse(
      await run(["--data-dir", data, fixture("obama-biden-2015.jpg")]),
    );
    const group = first.photos[0]!;
    if (group.verdict !== "choice-required") throw new Error("expected a choice to be required");
    expect(first.warnings).toEqual([{ code: "none-accepted", message: expect.any(String) }]);
    const report: ReferencePhotoReport = JSON.parse(
      await run([
        "--data-dir",
        data,
        "--face",
        `4:${rightmostFace(group.faces)}`,
        fixture("biden-2022.jpg"),
        fixture("earth-apollo17.jpg"),
        fixture("obama-2012.jpg"),
        fixture("obama-biden-2015.jpg"),
        fixture("biden-2013-gps-rotated.jpg"),
      ]),
    );
    expect(report.photos.map(({ photo, verdict }) => ({ photo, verdict }))).toEqual([
      { photo: 1, verdict: "accepted" },
      { photo: 2, verdict: "rejected" },
      { photo: 3, verdict: "flagged" },
      { photo: 4, verdict: "accepted" },
      { photo: 5, verdict: "accepted" },
    ]);
    expect(report.identity?.photos).toEqual([1, 4, 5]);
    expect(report.photos[2]).toMatchObject({ similarityTo: "accepted-anchor" });
    expect(report.photos[0]).toMatchObject({ similarityTo: "accepted-anchor" });
    expect(report.warnings).toEqual([]);
    // What the command stored is the stripped re-encode, not the upload.
    const stored = report.photos.flatMap((photo) =>
      photo.verdict === "accepted" ? [photo.stored.path] : [],
    );
    expect(stored).toHaveLength(3);
    for (const path of stored) {
      expect(path).toStartWith(join(data, "images"));
      await expectStripped(path);
    }
  });
});

describe("photos:validate as a process", () => {
  const spawn = (args: string[]) => spawnCli("photos-cli.ts", args);
  const sfaceVolume = () => dataVolume(temporaryDirectory, ["yunet", "sface"]);

  test("exits 0 with the report on stdout", async () => {
    const child = spawn(["--data-dir", await sfaceVolume(), fixture("biden-2021.jpg")]);
    expect(await child.exited).toBe(0);
    const report: ReferencePhotoReport = JSON.parse(await new Response(child.stdout).text());
    expect(report.photos[0]?.verdict).toBe("accepted");
  });

  test("exits nonzero with a JSON error for no photos or an unreadable one", async () => {
    const none = spawn([]);
    expect(await none.exited).toBe(1);
    expect(JSON.parse(await new Response(none.stderr).text())).toEqual({
      error: "Expected 1 to 8 photo paths, got 0; use --help for usage",
    });

    const notAnImage = fileURLToPath(new URL("../package.json", import.meta.url));
    const unreadable = spawn(["--data-dir", await sfaceVolume(), notAnImage]);
    expect(await unreadable.exited).toBe(1);
    // Compare the raw text first so a stray line (e.g. a native library's log) shows in the diff.
    const stderr = await new Response(unreadable.stderr).text();
    expect(stderr).toMatch(/^\{.*\}\n?$/);
    expect(JSON.parse(stderr)).toMatchObject({ photo: notAnImage });
  });

  test("exits nonzero with a JSON error when a weight file is corrupt", async () => {
    const data = await temporaryDirectory();
    await corruptAllWeights(data);
    const child = spawn(["--data-dir", data, fixture("biden-2021.jpg")]);
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stdout).text()).toBe("");
    const { error } = JSON.parse(await new Response(child.stderr).text());
    expect(error).toStartWith("Verifying face-model weights failed:");
    expect(error).toContain("failed SHA-256 verification");
  });
});
