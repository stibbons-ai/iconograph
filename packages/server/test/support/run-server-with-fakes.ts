/**
 * The HTTP server with the fake Image Model, the Judge of `fakeJudgesFromEnv`
 * and the Optimizer of `fakeOptimizersFromEnv` (the fake ones, or with
 * FAKE_ANTHROPIC_ORIGIN the real ones on a fake Anthropic API) and the real
 * face models, for tests that need a real process
 * to kill. It lives in the test tree, so no production entry point or
 * environment variable can select the fakes. Settings:
 * - FAKE_IMAGE_SCRIPT: the fake's responses (JSON array).
 * - FAKE_HANG_GET: getting an Image Model never returns, so a Run stays active in `prepare`.
 * - FAKE_MODELS_FROM: "download" missing face-model weights from this folder of
 *   verified files; with FAKE_MODELS_FAIL_ONCE the first download fails, and
 *   FAKE_MODELS_RETRY_MS sets the retry delay. Without it, nothing is ever
 *   downloaded and the data volume must hold the weights.
 */
import { join } from "node:path";
import { errorLine, readModelLock } from "@iconograph/adapters";
import { ImageModels } from "@iconograph/domain";
import { Effect, Layer } from "effect";
import { missingWeights } from "../../../adapters/test/face-models";
import { serverConfig, startServer } from "../../src/server";
import { type FakeResponse, fakeImageModels } from "./fake-image-models";
import { fakeJudgesFromEnv } from "./fake-judges";
import { fakeOptimizersFromEnv } from "./fake-optimizers";

const script: FakeResponse[] = JSON.parse(process.env.FAKE_IMAGE_SCRIPT ?? "[]");
const layer = process.env.FAKE_HANG_GET
  ? Layer.succeed(ImageModels)({ get: () => Effect.never })
  : fakeImageModels(script).layer;

const modelsFrom = process.env.FAKE_MODELS_FROM;
const files = new Map(readModelLock().models.map(({ url, file }) => [url, file]));
let failNext = Boolean(process.env.FAKE_MODELS_FAIL_ONCE);
const fetchModels = modelsFrom
  ? async (url: string) => {
      if (failNext) {
        failNext = false;
        throw new Error("the first download fails");
      }
      return new Response(Bun.file(join(modelsFrom, files.get(url)!)));
    }
  : missingWeights;

try {
  await startServer(serverConfig(), {
    vendors: async () => ({
      imageModels: layer,
      judges: fakeJudgesFromEnv(),
      optimizers: fakeOptimizersFromEnv(),
      close: () => {},
    }),
    fetchModels,
    ...(process.env.FAKE_MODELS_RETRY_MS && {
      modelsRetryMs: Number(process.env.FAKE_MODELS_RETRY_MS),
    }),
    retryPolicy: { maxRetries: 2, baseDelayMs: 0 },
  });
} catch (error) {
  process.stderr.write(errorLine(error));
  process.exitCode = 1;
}
