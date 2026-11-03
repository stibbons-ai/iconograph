import { expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NativeImageModels } from "@iconograph/adapters";
import { ImageModels } from "@iconograph/domain";
import { Effect } from "effect";
import { verifiedModelsDirectory } from "../../adapters/test/face-models";
import { temporaryDirectories } from "../../adapters/test/temporary-directory";
import { refreshOnFirstLookup } from "../src/cli";
import {
  FAKE_PRICE,
  faceFixture,
  type FakeScript,
  subjectPhotos,
} from "./support/fake-image-models";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const withFakes = fileURLToPath(new URL("./support/run-cli-with-fakes.ts", import.meta.url));
const temporaryDirectory = temporaryDirectories("cli");

async function invoke(
  entry: string,
  args: string[],
  script: FakeScript = [],
  extraEnv: Record<string, string> = {},
) {
  // The real CLI must never see a real key from the developer's shell.
  const {
    GEMINI_API_KEY: _gemini,
    ANTHROPIC_API_KEY: _anthropic,
    OPENAI_API_KEY: _openai,
    GOOGLE_GENERATIVE_AI_API_KEY: _google,
    GOOGLE_API_KEY: _googleAlias,
    ...env
  } = Bun.env;
  const child = Bun.spawn([Bun.which("bun") ?? "bun", entry, ...args], {
    env: {
      ...env,
      MASTRA_TELEMETRY_DISABLED: "1",
      DO_NOT_TRACK: "1",
      FAKE_IMAGE_SCRIPT: JSON.stringify(script),
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const lines = stderr.trim().split("\n").filter(Boolean);
  return { stdout, lines, exitCode };
}

// End-to-end walkthrough of the operator's command, with the fake Image Model in
// a real process: estimate on stderr first, one JSON report on stdout, then the
// same report read back from the database by a second process.
test("a Run prints its estimate, then a report that read can reproduce", async () => {
  const directory = await temporaryDirectory();
  const look = join(directory, "look.json");
  await writeFile(look, JSON.stringify({ background: "dark navy backdrop" }));
  const common = ["--db", join(directory, "runs.db"), "--data-dir", join(directory, "data")];
  const started = await invoke(
    withFakes,
    [
      ...common,
      "--budget",
      "0.25",
      "--candidates",
      "3",
      "--look",
      look,
      "--pin",
      "2",
      ...subjectPhotos,
    ],
    ["same", "different"],
  );
  expect(started.lines.map((line) => JSON.parse(line))).toEqual([
    expect.objectContaining({ event: "estimate", estimatedUsd: 0.33, budgetUsd: 0.25 }),
  ]);
  expect(started.exitCode).toBe(0);
  const report = JSON.parse(started.stdout);
  expect(report.targetLook.background).toBe("dark navy backdrop");
  expect(report.lanes[0]).toMatchObject({
    model: "gemini-nano-banana-2.1",
    stopReason: "budget-exhausted",
    characterReferences: [2, 1],
  });
  expect(report.lanes[0].candidates.map(({ outcome }: { outcome: string }) => outcome)).toEqual([
    "Scored",
    "Gated",
  ]);
  expect(report.totals.estimatedUsd).toBeLessThanOrEqual(0.25);
  // The Scored Candidate was judged by the default Judge; the Gated one never was.
  expect(report.judge).toMatchObject({ model: "anthropic/claude-sonnet-5-5", effort: "low" });
  expect(
    report.lanes[0].candidates.map(({ judgement }: { judgement: unknown }) => judgement),
  ).toEqual([expect.objectContaining({ status: "judged", rubricVersion: "rubric-v1" }), null]);

  const read = await invoke(cli, ["read", ...common, "--run-id", report.runId]);
  expect(read.lines).toEqual([]);
  expect(read.exitCode).toBe(0);
  expect(JSON.parse(read.stdout)).toEqual(report);
}, 60_000);

test("engine warnings, even while shutting down, are JSON lines on stderr; stdout stays the report", async () => {
  const directory = await temporaryDirectory();
  const common = ["--db", join(directory, "runs.db"), "--data-dir", join(directory, "data")];
  const { stdout, lines, exitCode } = await invoke(
    withFakes,
    [...common, "--candidates", "1", ...subjectPhotos],
    ["same"],
    { FAKE_RELEASE_WARNING: "Releasing the face backend failed" },
  );
  expect(exitCode).toBe(0);
  expect(JSON.parse(stdout).lanes[0].candidates).toHaveLength(1);
  expect(lines.map((line) => JSON.parse(line))).toEqual([
    expect.objectContaining({ event: "estimate" }),
    { level: "Warn", warning: "Releasing the face backend failed" },
  ]);
}, 60_000);

test("--lane runs a Gemini and an OpenAI Lane, each with its photos and Prompt; output per Lane", async () => {
  const directory = await temporaryDirectory();
  const prompt = join(directory, "openai-prompt.txt");
  await writeFile(prompt, "A studio headshot of the person in the reference photos.\n");
  const common = ["--db", join(directory, "runs.db"), "--data-dir", join(directory, "data")];
  const { stdout, lines, exitCode } = await invoke(
    withFakes,
    [
      ...common,
      "--candidates",
      "1",
      "--lane",
      "gemini",
      "--lane",
      `openai:flare,photos=2,prompt=${prompt}`,
      ...subjectPhotos,
    ],
    { "gemini-nano-banana-2.1": ["same"], "gpt-image-2.5-flare": ["different"] },
  );
  expect(exitCode).toBe(0);
  expect(lines.map((line) => JSON.parse(line))).toEqual([
    expect.objectContaining({
      event: "estimate",
      // Two $0.10 image calls and one $0.01 Judge call per Candidate.
      estimatedUsd: 0.22,
      judge: expect.objectContaining({ calls: 2 }),
      lanes: [
        expect.objectContaining({ lane: 0, model: "gemini-nano-banana-2.1", candidates: 1 }),
        expect.objectContaining({ lane: 1, model: "gpt-image-2.5-flare", candidates: 1 }),
      ],
    }),
  ]);
  const report = JSON.parse(stdout);
  expect(report.lanes).toHaveLength(2);
  expect(report.lanes[0]).toMatchObject({
    model: "gemini-nano-banana-2.1",
    stopReason: "iteration-limit",
    characterReferences: [2, 1],
    candidates: [expect.objectContaining({ outcome: "Scored" })],
  });
  expect(report.lanes[0].initialPrompt).toContain("headshot");
  expect(report.lanes[1]).toMatchObject({
    model: "gpt-image-2.5-flare",
    stopReason: "iteration-limit",
    initialPrompt: "A studio headshot of the person in the reference photos.",
    characterReferences: [2],
    candidates: [expect.objectContaining({ outcome: "Gated" })],
  });
}, 60_000);

test("--lane openai and openai:sunburst drive Sunburst; a prompt path may hold commas", async () => {
  const directory = await temporaryDirectory();
  const prompt = join(directory, "prompt, for openai.txt");
  await writeFile(prompt, "A bright studio headshot.");
  const common = ["--db", join(directory, "runs.db"), "--data-dir", join(directory, "data")];
  const { stdout, exitCode } = await invoke(
    withFakes,
    [
      ...common,
      "--candidates",
      "1",
      "--lane",
      `openai,photos=1,prompt=${prompt}`,
      "--lane",
      "openai:sunburst",
      ...subjectPhotos,
    ],
    { "gpt-image-2.5-sunburst": ["same", "same"] },
  );
  expect(exitCode).toBe(0);
  const report = JSON.parse(stdout);
  expect(report.lanes.map(({ model }: { model: string }) => model)).toEqual([
    "gpt-image-2.5-sunburst",
    "gpt-image-2.5-sunburst",
  ]);
  expect(report.lanes[0]).toMatchObject({
    initialPrompt: "A bright studio headshot.",
    characterReferences: [1],
  });
}, 60_000);

test("the Judge's model and effort are taken from the command line", async () => {
  const directory = await temporaryDirectory();
  const common = ["--db", join(directory, "runs.db"), "--data-dir", join(directory, "data")];
  const { stdout, exitCode } = await invoke(
    withFakes,
    [
      ...common,
      "--candidates",
      "1",
      "--judge-model",
      "google/gemini-3.1-pro-preview",
      "--judge-effort",
      "high",
      ...subjectPhotos,
    ],
    ["same"],
  );
  expect(exitCode).toBe(0);
  const report = JSON.parse(stdout);
  expect(report.judge).toMatchObject({ model: "google/gemini-3.1-pro-preview", effort: "high" });
  expect(report.warnings.map(({ code }: { code: string }) => code)).toEqual(["judge-same-vendor"]);
}, 60_000);

test("help documents the arguments, the Budget and the key", async () => {
  const { stdout, exitCode } = await invoke(cli, ["--help"]);
  expect(exitCode).toBe(0);
  for (const text of [
    "--budget USD",
    "--candidates N",
    "--look FILE",
    "--pin PHOTO",
    "--lane SPEC",
    "openai:flare",
    "--judge-model ID",
    "--judge-effort LEVEL",
    "GEMINI_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "30 days",
    "store=false",
    "read",
  ]) {
    expect(stdout).toContain(text);
  }
});

test("errors are one JSON line on stderr with a nonzero exit and nothing on stdout", async () => {
  const directory = await temporaryDirectory();
  const common = ["--db", join(directory, "runs.db"), "--data-dir", join(directory, "data")];
  // The real CLI loads the locked face models from the data volume; link the verified ones.
  await mkdir(join(directory, "data"), { recursive: true });
  await symlink(
    await verifiedModelsDirectory(["yunet", "sface"]),
    join(directory, "data", "models"),
  );
  const cases: [string, string[], string][] = [
    [withFakes, [...common, "--budget", "0", ...subjectPhotos], "budgetUsd"],
    [withFakes, [...common, "--budget", "0.0000004", ...subjectPhotos], "from $0.000001"],
    [
      withFakes,
      [...common, "--budget", "1.0000005", ...subjectPhotos],
      "whole number of micro-dollars",
    ],
    [withFakes, [...common, "--budget", "abc", ...subjectPhotos], "--budget expects a number"],
    [withFakes, [...common, "--candidates", "9", ...subjectPhotos], "candidates"],
    [withFakes, [...common, "--face", "1:1", "--face", "1:2", ...subjectPhotos], "given twice"],
    [withFakes, [...common], "photos"],
    [withFakes, [...common, "--look", join(directory, "missing.json"), ...subjectPhotos], "--look"],
    [withFakes, [...common, faceFixture("earth-apollo17.jpg")], "No Reference Photo was accepted"],
    [withFakes, [...common, "--lane", "dalle", ...subjectPhotos], "unknown Lane dalle"],
    [
      withFakes,
      [...common, "--lane", "openai,photos=x", ...subjectPhotos],
      "photos expects a number",
    ],
    [withFakes, [...common, "--lane", "openai,photos=3", ...subjectPhotos], "A Lane lists photo 3"],
    [withFakes, [...common, "--lane", "openai,size=2K", ...subjectPhotos], "expected photos="],
    [
      withFakes,
      [...common, "--lane", `openai,prompt=${join(directory, "missing.txt")}`, ...subjectPhotos],
      "is not a readable file",
    ],
    [
      withFakes,
      [...common, "--lane", "openai,prompt=p.txt,photos=1", ...subjectPhotos],
      "photos= must come before prompt=",
    ],
    [cli, ["read", ...common, "--run-id", "x", "--lane", "openai"], "read takes only"],
    [withFakes, [...common, "--judge-effort", "extreme", ...subjectPhotos], "effort"],
    [withFakes, [...common, "--judge-model", "sonnet", ...subjectPhotos], "model router id"],
    [
      cli,
      ["read", ...common, "--run-id", "x", "--judge-model", "openai/gpt-5.5"],
      "read takes only",
    ],
    // The real CLI, with every key cleared: the Judge's key is checked first, before any call
    // or price refresh.
    [cli, [...common, ...subjectPhotos], "ANTHROPIC_API_KEY is not set"],
    [cli, ["read", ...common, "--run-id", "missing"], "Run not found"],
    [cli, ["read", "--db", join(directory, "typo.db"), "--run-id", "x"], "no such database file"],
    [cli, ["--unknown"], "Unknown option"],
  ];
  for (const [entry, args, message] of cases) {
    const result = await invoke(entry, args);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    const last = JSON.parse(result.lines.at(-1)!);
    expect(last.error).toContain(message);
    // None of these Runs was stored, so none names a runId `read` can't show.
    expect(last.runId).toBeUndefined();
  }
}, 60_000);

test("prices refresh once, on the first lookup, and never without a key", async () => {
  let refreshes = 0;
  const prices = refreshOnFirstLookup(
    {
      ensureFresh: async () => {
        refreshes++;
        return { refreshed: true, fetchedAt: new Date() };
      },
      lookup: (model) => Effect.succeed({ ...FAKE_PRICE, model }),
    },
    () => {},
  );
  const get = (env: Record<string, string>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* ImageModels).get("gemini-nano-banana-2.1");
      }).pipe(Effect.provide(NativeImageModels({ prices, env })), Effect.result),
    );
  expect((await get({}))._tag).toBe("Failure");
  expect(refreshes).toBe(0);
  const key = { GEMINI_API_KEY: "AIzaFAKEFAKEFAKEFAKEFAKE" };
  expect((await get(key))._tag).toBe("Success");
  expect((await get(key))._tag).toBe("Success");
  expect(refreshes).toBe(1);
});
