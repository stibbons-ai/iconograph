import { expect, test } from "bun:test";
import { NativeImageModels, openPriceSource } from "@iconograph/adapters";
import { ImageModels } from "@iconograph/domain";
import { Effect } from "effect";
import { temporaryDirectories } from "../../adapters/test/temporary-directory";
import { refreshOnFirstLookup, vendorsPricedBy } from "../src/vendors";
import { FAKE_PRICE } from "./support/fake-image-models";

const temporaryDirectory = temporaryDirectories("vendors");

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

test("a caller's refresh before the first lookup is the only one, and reports its own failure", async () => {
  let refreshes = 0;
  const fetch = Promise.withResolvers<{ refreshed: boolean; fetchedAt: Date }>();
  const warnings: string[] = [];
  const events: string[] = [];
  const prices = refreshOnFirstLookup(
    {
      ensureFresh: () => {
        refreshes++;
        return fetch.promise;
      },
      lookup: (model) =>
        Effect.sync(() => {
          events.push("lookup");
          return { ...FAKE_PRICE, model };
        }),
    },
    (warning) => warnings.push(warning),
  );
  const refresh = prices.ensureFresh();
  // Started while the caller's refresh is in flight: no second fetch, and it waits for that one.
  const lookup = Effect.runPromise(prices.lookup("claude-sonnet-5-5"));
  await Bun.sleep(0); // One event-loop turn: a lookup that doesn't wait would run now.
  events.push("refresh settled");
  fetch.reject(new Error("HTTP 503"));
  await expect(refresh).rejects.toThrow("HTTP 503");
  expect((await lookup).model).toBe("claude-sonnet-5-5");
  expect(events).toEqual(["refresh settled", "lookup"]);
  await Effect.runPromise(prices.lookup("claude-sonnet-5-5"));
  expect(refreshes).toBe(1);
  expect(warnings).toEqual([]);
});

test("the vendors' prices refresh through their caller's refresh: one fetch, reported by the caller", async () => {
  let fetches = 0;
  const released = Promise.withResolvers<void>();
  const source = await openPriceSource({
    dataDirectory: await temporaryDirectory(),
    fetch: async () => {
      fetches++;
      await released.promise;
      return new Response("unavailable", { status: 503 });
    },
  });
  const warnings: string[] = [];
  const vendors = vendorsPricedBy(source, (warning) => warnings.push(warning), {
    GEMINI_API_KEY: "AIzaFAKEFAKEFAKEFAKEFAKE",
  });
  const get = () =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* ImageModels).get("gemini-nano-banana-2.1");
      }).pipe(Effect.provide(vendors.imageModels), Effect.result),
    );
  try {
    const refresh = vendors.ensurePricesFresh!();
    const got = get();
    released.resolve();
    await expect(refresh).rejects.toThrow("HTTP 503");
    expect((await got)._tag).toBe("Success");
    expect((await get())._tag).toBe("Success");
    expect(fetches).toBe(1);
    expect(warnings).toEqual([]);
  } finally {
    vendors.close();
  }
});
