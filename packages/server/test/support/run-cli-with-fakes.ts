/**
 * The Run CLI with the fake Image Model, the Judge of `fakeJudgesFromEnv` and
 * the Optimizer of `fakeOptimizersFromEnv` (the fake ones, or with
 * FAKE_ANTHROPIC_ORIGIN the real ones on a fake Anthropic API) and the real
 * face models, for tests that need a real process (exit code, stderr). It
 * lives in the test tree, so no production entry point or environment
 * variable can select the fakes. The scripts of fake responses come from
 * FAKE_IMAGE_SCRIPT (JSON: an array, or one per model id), FAKE_JUDGE_SCRIPT
 * and FAKE_OPTIMIZER_SCRIPT (JSON arrays; may be left out). With
 * FAKE_RELEASE_WARNING set, releasing the face backend logs that text as a
 * warning, as a failing release would.
 */
import { runCommand } from "@iconograph/adapters";
import { Effect, Layer } from "effect";
import { realFaceEmbedder } from "../../../adapters/test/face-models";
import { main } from "../../src/cli";
import { type FakeScript, fakeImageModels } from "./fake-image-models";
import { type FakeJudgeResponse, fakeJudgesFromEnv } from "./fake-judges";
import { type FakeOptimizerResponse, fakeOptimizersFromEnv } from "./fake-optimizers";

const script: FakeScript = JSON.parse(process.env.FAKE_IMAGE_SCRIPT ?? "[]");
const judgeScript: FakeJudgeResponse[] = JSON.parse(process.env.FAKE_JUDGE_SCRIPT ?? "[]");
const optimizerScript: FakeOptimizerResponse[] = JSON.parse(
  process.env.FAKE_OPTIMIZER_SCRIPT ?? "[]",
);
const releaseWarning = process.env.FAKE_RELEASE_WARNING;

await runCommand((args) =>
  main(args, {
    vendors: async () => ({
      imageModels: fakeImageModels(script).layer,
      judges: fakeJudgesFromEnv(judgeScript),
      optimizers: fakeOptimizersFromEnv(optimizerScript),
      close: () => {},
    }),
    faceEmbedder: () =>
      releaseWarning
        ? Layer.merge(
            realFaceEmbedder(),
            Layer.effectDiscard(Effect.addFinalizer(() => Effect.logWarning(releaseWarning))),
          )
        : realFaceEmbedder(),
    retryPolicy: { maxRetries: 2, baseDelayMs: 0 },
  }),
);
