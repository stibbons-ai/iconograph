import { expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifiedModelsDirectory } from "../../adapters/test/face-models";
import { spawnCli } from "../../adapters/test/spawn-cli";
import { temporaryDirectories } from "../../adapters/test/temporary-directory";
import { faceFixture, type FakeScript, subjectPhotos } from "./support/fake-image-models";
import { FAKE_VERDICT, levels } from "./support/fake-judges";
import { fakeVendorServer, vendorAnswer, vendorError } from "./support/fake-vendors";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const withFakes = fileURLToPath(new URL("./support/run-cli-with-fakes.ts", import.meta.url));
const temporaryDirectory = temporaryDirectories("cli");

async function invoke(
  entry: string,
  args: string[],
  script: FakeScript = [],
  extraEnv: Record<string, string> = {},
) {
  const { stdout, stderr, exitCode } = await spawnCli([entry, ...args], {
    env: { FAKE_IMAGE_SCRIPT: JSON.stringify(script), ...extraEnv },
  });
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
  // The estimate quotes every Iteration (8 by default) and the 7 Optimizer calls between them.
  const events = started.lines.map((line) => JSON.parse(line));
  expect(events).toEqual([
    expect.objectContaining({ event: "estimate", maxIterations: 8, budgetUsd: 0.25 }),
  ]);
  const [{ estimatedUsd, optimizer }] = events;
  expect(optimizer.perCallUsd).toBeGreaterThanOrEqual(0.02);
  expect(estimatedUsd).toBeCloseTo(8 * 0.33 + 7 * optimizer.perCallUsd, 10);
  expect(started.exitCode).toBe(0);
  const report = JSON.parse(started.stdout);
  expect(report.targetLook.background).toBe("dark navy backdrop");
  expect(report.lanes[0]).toMatchObject({
    model: "gemini-nano-banana-2.1",
    stopReason: "budget-exhausted",
    characterReferences: [2, 1],
  });
  // The third Candidate's call didn't fit the Budget: it is stored Failed, saying so.
  expect(report.lanes[0].candidates.map(({ outcome }: { outcome: string }) => outcome)).toEqual([
    "Scored",
    "Gated",
    "Failed",
  ]);
  expect(report.lanes[0].candidates[2]).toMatchObject({ budgetExhausted: true, calls: [] });
  expect(report.totals.estimatedUsd).toBeLessThanOrEqual(0.25);
  // The Scored Candidate was judged by the default Judge; the others never were.
  expect(report.judge).toMatchObject({ model: "anthropic/claude-sonnet-5-5", effort: "low" });
  expect(
    report.lanes[0].candidates.map(({ judgement }: { judgement: unknown }) => judgement),
  ).toEqual([
    expect.objectContaining({ status: "judged", rubricVersion: "rubric-v2" }),
    null,
    null,
  ]);

  const read = await invoke(cli, ["read", ...common, "--run-id", report.runId]);
  expect(read.lines).toEqual([]);
  expect(read.exitCode).toBe(0);
  expect(JSON.parse(read.stdout)).toEqual(report);
}, 60_000);

// End-to-end through the real Judge on a fake Anthropic API; nothing sets Bun's fetch idle timeout.
test("a Run's Judge sends its key and the photos to the Anthropic API, whatever ANTHROPIC_BASE_URL says", async () => {
  const key = "SENTINEL-JUDGE-KEY-0123456789";
  const vendor = fakeVendorServer(() => vendorAnswer("anthropic", JSON.stringify(FAKE_VERDICT)));
  const trap = fakeVendorServer(() => new Response("{}", { status: 500 }));
  try {
    const directory = await temporaryDirectory();
    const common = ["--db", join(directory, "runs.db"), "--data-dir", join(directory, "data")];
    const { stdout, exitCode } = await invoke(
      withFakes,
      [...common, "--candidates", "1", "--max-iterations", "1", ...subjectPhotos],
      ["same"],
      {
        FAKE_ANTHROPIC_ORIGIN: vendor.origin,
        ANTHROPIC_API_KEY: key,
        ANTHROPIC_BASE_URL: trap.origin,
      },
    );
    expect(exitCode).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.lanes[0].candidates[0].judgement).toMatchObject({
      status: "judged",
      levels: FAKE_VERDICT.levels,
      issues: FAKE_VERDICT.issues,
    });
    // One $0.08 image and the Judge's 9,000 input and 300 output tokens at the fake's price.
    expect(report.totals.actualUsd).toBe(0.084875);
    expect(trap.requests).toEqual([]);
    expect(vendor.requests).toHaveLength(1);
    const [sent] = vendor.requests;
    expect(sent!.path).toBe("/v1/messages");
    expect(sent!.headers.get("x-api-key")).toBe(key);
    const body = JSON.parse(sent!.body);
    expect(body).toMatchObject({ model: "claude-sonnet-5-5", output_config: { effort: "low" } });
    // A Reference Photo, then (after the other photos) the Candidate, each as an inline image.
    const parts: { type: string; text?: string }[] = body.messages[0].content;
    const candidate = parts.findIndex((part) => part.text === "Candidate:");
    expect(parts[0]!.text).toStartWith("Reference Photo 1 of ");
    expect([parts[1]!.type, parts[candidate + 1]!.type]).toEqual(["image", "image"]);
    const read = await invoke(cli, ["read", ...common, "--run-id", report.runId]);
    expect(JSON.parse(read.stdout)).toEqual(report);
  } finally {
    await Promise.all([vendor.stop(), trap.stop()]);
  }
}, 60_000);

/** Whether a request to the fake Anthropic API is the Optimizer's: its output schema asks for a Prompt. */
const isOptimizerRequest = (body: string) =>
  "prompt" in (JSON.parse(body).output_config?.format?.schema?.properties ?? {});

// End-to-end walkthrough of the loop: the real Judge and Optimizer on a fake Anthropic API, the
// fake Image Model, in a real process; then the same report read back by a second process.
test("a Run iterates: the Optimizer rewrites the Prompt until the target score stops the Lane", async () => {
  const key = "SENTINEL-ANTHROPIC-KEY-0123456789";
  const better = "A sharper studio headshot of the person in the reference photos.";
  let judged = 0;
  const vendor = fakeVendorServer((_, body) => {
    if (isOptimizerRequest(body)) {
      return vendorAnswer("anthropic", JSON.stringify({ prompt: better }));
    }
    // The first Candidate is judged at level 4 everywhere, the second at level 5.
    judged++;
    const verdict = judged === 1 ? FAKE_VERDICT : { ...FAKE_VERDICT, levels: levels(5) };
    return vendorAnswer("anthropic", JSON.stringify(verdict));
  });
  try {
    const directory = await temporaryDirectory();
    const common = ["--db", join(directory, "runs.db"), "--data-dir", join(directory, "data")];
    const { stdout, exitCode } = await invoke(
      withFakes,
      [...common, "--candidates", "1", ...subjectPhotos],
      ["same", "same"],
      { FAKE_ANTHROPIC_ORIGIN: vendor.origin, ANTHROPIC_API_KEY: key },
    );
    expect(exitCode).toBe(0);
    const report = JSON.parse(stdout);
    const [lane] = report.lanes;
    expect(lane).toMatchObject({
      stopReason: "target-score",
      iterations: 2,
      best: { iteration: 2, candidate: 0 },
    });
    expect(
      lane.prompts.map(({ prompt, source }: { prompt: string; source: string }) => [
        prompt,
        source,
      ]),
    ).toEqual([
      [expect.stringContaining("headshot"), "initial"],
      [better, "optimizer"],
    ]);
    expect(report.optimizer).toMatchObject({
      model: "anthropic/claude-sonnet-5-5",
      effort: "medium",
    });
    // The Optimizer's call went at medium effort, with the key, and without any image.
    const optimizerCalls = vendor.requests.filter(({ body }) => isOptimizerRequest(body));
    const sent = JSON.parse(optimizerCalls[0]!.body);
    expect(sent).toMatchObject({ output_config: { effort: "medium" } });
    expect(optimizerCalls[0]!.body).not.toContain('"type":"image"');
    expect(optimizerCalls[0]!.headers.get("x-api-key")).toBe(key);
    // Iteration 1's Optimizer call, billed: 9,000 input and 300 output tokens at the fake price.
    expect(lane.prompts[0].optimizerCost).toMatchObject({
      actualUsd: 0.004875,
      unknownCostCalls: 0,
    });
    const read = await invoke(cli, ["read", ...common, "--run-id", report.runId]);
    expect(JSON.parse(read.stdout)).toEqual(report);
  } finally {
    await vendor.stop();
  }
}, 60_000);

// End-to-end walkthrough of a rejected Optimizer key: the real Judge and Optimizer on a fake
// Anthropic API that turns the Optimizer away, the fake Image Model, in a real process.
test("a Run whose Optimizer key is rejected stops its Lane optimizer-failed and says why", async () => {
  const key = "SENTINEL-ANTHROPIC-KEY-0123456789";
  // The vendor quotes the key it rejected; the process must never print it.
  const vendor = fakeVendorServer((_, body) =>
    isOptimizerRequest(body)
      ? vendorError(401, "authentication_error", `invalid x-api-key ${key}`)
      : vendorAnswer("anthropic", JSON.stringify(FAKE_VERDICT)),
  );
  try {
    const directory = await temporaryDirectory();
    const common = ["--db", join(directory, "runs.db"), "--data-dir", join(directory, "data")];
    const { stdout, lines, exitCode } = await invoke(
      withFakes,
      [...common, "--candidates", "1", ...subjectPhotos],
      ["same", "same"],
      { FAKE_ANTHROPIC_ORIGIN: vendor.origin, ANTHROPIC_API_KEY: key },
    );
    expect(exitCode).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.lanes[0]).toMatchObject({
      stopReason: "optimizer-failed",
      stopDetail: "Optimizer HTTP 401: invalid x-api-key [redacted]",
      iterations: 1,
      best: { iteration: 1, candidate: 0 },
    });
    expect(stdout).not.toContain(key);
    expect(lines.join("\n")).not.toContain(key);
    // One Judge call and one Optimizer call; no second Iteration.
    expect(vendor.requests).toHaveLength(2);
    expect(report.lanes[0].candidates).toHaveLength(1);
    const read = await invoke(cli, ["read", ...common, "--run-id", report.runId]);
    expect(read.stdout).not.toContain(key);
    expect(JSON.parse(read.stdout)).toEqual(report);
  } finally {
    await vendor.stop();
  }
}, 60_000);

test("the stopping rules and the Optimizer are taken from the command line", async () => {
  const directory = await temporaryDirectory();
  const common = ["--db", join(directory, "runs.db"), "--data-dir", join(directory, "data")];
  const { stdout, exitCode } = await invoke(
    withFakes,
    [
      ...common,
      "--candidates",
      "1",
      "--target-score",
      "9.5",
      "--patience",
      "2",
      "--min-improvement",
      "0.4",
      "--max-iterations",
      "1",
      "--optimizer-model",
      "openai/gpt-5.5",
      "--optimizer-effort",
      "low",
      ...subjectPhotos,
    ],
    ["same"],
  );
  expect(exitCode).toBe(0);
  const report = JSON.parse(stdout);
  expect(report.stopRules).toEqual({
    targetScore: 9.5,
    patience: 2,
    minImprovement: 0.4,
    maxIterations: 1,
  });
  expect(report.optimizer).toMatchObject({ model: "openai/gpt-5.5", effort: "low" });
}, 60_000);

test("engine warnings, even while shutting down, are JSON lines on stderr; stdout stays the report", async () => {
  const directory = await temporaryDirectory();
  const common = ["--db", join(directory, "runs.db"), "--data-dir", join(directory, "data")];
  const { stdout, lines, exitCode } = await invoke(
    withFakes,
    [...common, "--candidates", "1", "--max-iterations", "1", ...subjectPhotos],
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
      "--max-iterations",
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
  expect(report.lanes[0].prompts[0].prompt).toContain("headshot");
  expect(report.lanes[1]).toMatchObject({
    model: "gpt-image-2.5-flare",
    stopReason: "iteration-limit",
    prompts: [
      expect.objectContaining({
        prompt: "A studio headshot of the person in the reference photos.",
        source: "initial",
      }),
    ],
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
      "--max-iterations",
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
    prompts: [expect.objectContaining({ prompt: "A bright studio headshot." })],
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
      "--max-iterations",
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
    "retouching",
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
    [withFakes, [...common, "--judge-model", "sonnet", ...subjectPhotos], "vendor/model id"],
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
