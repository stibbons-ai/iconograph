/**
 * The eval CLI with the fake Image Model and the fake Optimizer, the real
 * Judges on fake vendor APIs (Anthropic at FAKE_ANTHROPIC_ORIGIN, OpenAI at
 * FAKE_OPENAI_ORIGIN; any other request is refused before it leaves) and the
 * real face models, for the walkthrough in a real process. It lives in the
 * test tree, so no production entry point or environment variable can select
 * the fakes. FAKE_IMAGE_SCRIPT is the Image Model's script (JSON).
 */
import { errorLine } from "@iconograph/adapters";
import { realFaceEmbedder, realHeldOutEmbedder } from "../../../adapters/test/face-models";
import { type FakeScript, fakeImageModels } from "../../../server/test/support/fake-image-models";
import { judgesOnFakeVendors } from "../../../server/test/support/fake-judges";
import { fakeOptimizers } from "../../../server/test/support/fake-optimizers";
import { main } from "../../src/cli";

const script: FakeScript = JSON.parse(process.env.FAKE_IMAGE_SCRIPT ?? "[]");

try {
  await main(process.argv.slice(2), {
    vendors: async () => ({
      imageModels: fakeImageModels(script).layer,
      judges: judgesOnFakeVendors({
        anthropic: process.env.FAKE_ANTHROPIC_ORIGIN!,
        openai: process.env.FAKE_OPENAI_ORIGIN!,
      }),
      optimizers: fakeOptimizers().layer,
      close: () => {},
    }),
    faceEmbedder: () => realFaceEmbedder(),
    heldOutEmbedder: () => realHeldOutEmbedder(),
    retryPolicy: { maxRetries: 2, baseDelayMs: 0 },
  });
} catch (error) {
  process.stderr.write(errorLine(error));
  process.exitCode = 1;
}
