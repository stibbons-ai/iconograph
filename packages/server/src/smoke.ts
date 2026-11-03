/**
 * The built image's smoke test (issue #1, seam 4): the bundle with its external
 * packages, as shipped. Each check prints one JSON line; the first failure
 * exits nonzero. The face-model weights must already be in the data volume
 * (`ICONOGRAPH_DATA_DIR`): they are never downloaded here or baked into the image.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalStore,
  errorLine,
  loadHeicDecoder,
  OnnxFaceEmbedder,
  resolveDataDirectory,
  withCleanup,
  workflowsStore,
} from "@iconograph/adapters";
import { FaceEmbedder } from "@iconograph/domain";
import { modelSupportsStructuredOutput } from "@mastra/core/llm";
import { Effect } from "effect";
import sharp from "sharp";
import { jsonLine } from "./warnings";

const checks: Record<string, () => Promise<object>> = {
  // Mastra reads these from JSON beside its package.json, which bundling breaks silently.
  "mastra-capabilities": async () => {
    // The shipped capability data lists gpt-4.1 with structured output; a truncated or
    // missing file gives false or undefined.
    const supported = modelSupportsStructuredOutput("openai/gpt-4.1");
    if (supported !== true) throw new Error(`capability resolved to ${supported}`);
    return { "openai/gpt-4.1": { structuredOutput: supported } };
  },
  "onnxruntime-sface": () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const embedder = yield* FaceEmbedder;
        return { model: embedder.model };
      }).pipe(
        Effect.provide(
          OnnxFaceEmbedder({
            dataDirectory: resolveDataDirectory(),
            fetch: async (url) => {
              throw new Error(`Face-model weights are missing (${url}); mount them in the volume`);
            },
          }),
        ),
      ),
    ),
  "sharp-decodes": async () => {
    const png = await sharp({
      create: { width: 4, height: 3, channels: 3, background: { r: 200, g: 100, b: 50 } },
    })
      .png()
      .toBuffer();
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    if (info.width !== 4 || info.height !== 3 || data[0] !== 200) {
      throw new Error(`decoded ${info.width}×${info.height}, first byte ${data[0]}`);
    }
    return { width: info.width, height: info.height };
  },
  "libsql-opens": async () => {
    const directory = await mkdtemp(join(tmpdir(), "iconograph-smoke-"));
    const store = createLocalStore(join(directory, "smoke.db"));
    // A failing close or removal fails the check only when the query itself succeeded.
    return withCleanup(
      () =>
        withCleanup(
          async () => {
            await store.init();
            const workflows = await workflowsStore(store);
            return { runs: (await workflows.listWorkflowRuns()).total };
          },
          () => store.close(),
        ),
      () => rm(directory, { recursive: true, force: true }),
    );
  },
  "heic-decoder-loads": async () => {
    await loadHeicDecoder();
    return {};
  },
};

for (const [check, run] of Object.entries(checks)) {
  try {
    process.stdout.write(jsonLine({ check, ok: true, ...(await run()) }));
  } catch (error) {
    process.stdout.write(jsonLine({ check, ok: false }));
    process.stderr.write(errorLine(error));
    process.exit(1);
  }
}
