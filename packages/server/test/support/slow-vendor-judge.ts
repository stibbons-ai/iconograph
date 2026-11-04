/**
 * One Judge call through the real Anthropic provider, sent to a fake Anthropic
 * API at the origin in argv[2], beside a plain fetch to the same server: for
 * the idle-timeout test, which runs this with a low
 * BUN_CONFIG_HTTP_IDLE_TIMEOUT (Bun reads it only when it starts) and
 * ANTHROPIC_API_KEY set. Prints the Judge's result kind and how the plain
 * fetch ended, as JSON.
 */
import { DEFAULT_TARGET_LOOK, Judges } from "@iconograph/domain";
import { Effect } from "effect";
import { judgesOnFakeVendor } from "./fake-judges";

const origin = process.argv[2]!;
const image = { bytes: new Uint8Array([0xff, 0xd8, 0xff]), mimeType: "image/jpeg" } as const;
const judged = Effect.gen(function* () {
  const judge = yield* (yield* Judges).get({ model: "anthropic/claude-sonnet-5-5", effort: "low" });
  return yield* judge.call({
    references: [image],
    candidate: image,
    targetLook: DEFAULT_TARGET_LOOK,
  });
}).pipe(Effect.provide(judgesOnFakeVendor(origin)), Effect.runPromise);
const plainFetch = fetch(origin).then(
  () => "answered",
  (error: Error) => error.name,
);
const [result, plain] = await Promise.all([judged, plainFetch]);
process.stdout.write(JSON.stringify({ judge: result.kind, plainFetch: plain }));
