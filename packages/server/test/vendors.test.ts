import { expect, test } from "bun:test";
import { NativeImageModels } from "@iconograph/adapters";
import { ImageModels } from "@iconograph/domain";
import { Effect } from "effect";
import { refreshOnFirstLookup } from "../src/vendors";
import { FAKE_PRICE } from "./support/fake-image-models";

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
