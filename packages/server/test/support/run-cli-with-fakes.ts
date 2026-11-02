/**
 * The Run CLI with the fake Image Model and the real face models, for tests that
 * need a real process (exit code, stderr). It lives in the test tree, so no
 * production entry point or environment variable can select the fake. The
 * script of fake responses comes from FAKE_IMAGE_SCRIPT (JSON array). With
 * FAKE_RELEASE_WARNING set, releasing the face backend logs that text as a
 * warning, as a failing release would.
 */
import { errorLine } from "@iconograph/adapters";
import { Effect, Layer } from "effect";
import { realFaceEmbedder } from "../../../adapters/test/face-models";
import { main } from "../../src/cli";
import { type FakeResponse, fakeImageModels } from "./fake-image-models";

const script: FakeResponse[] = JSON.parse(process.env.FAKE_IMAGE_SCRIPT ?? "[]");
const releaseWarning = process.env.FAKE_RELEASE_WARNING;

try {
  await main(process.argv.slice(2), {
    imageModels: async () => ({ layer: fakeImageModels(script).layer, close: () => {} }),
    faceEmbedder: () =>
      releaseWarning
        ? Layer.merge(
            realFaceEmbedder(),
            Layer.effectDiscard(Effect.addFinalizer(() => Effect.logWarning(releaseWarning))),
          )
        : realFaceEmbedder(),
    retryPolicy: { maxRetries: 2, baseDelayMs: 0 },
  });
} catch (error) {
  process.stderr.write(errorLine(error));
  process.exitCode = 1;
}
