import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pricingSpecs, type PriceQuote } from "@iconograph/domain";
import { createClient } from "@libsql/client";
import { Effect, Schema } from "effect";
import {
  decodeLiteLLMPrices,
  openPriceSource,
  PriceFetchError,
  pricesDatabase,
  PriceStoreError,
  readPriceSnapshot,
  type PriceSource,
  type PriceSourceOptions,
} from "../src";
import { litellmPricesUrl, PriceSnapshot } from "../src/prices";
import { main } from "../src/prices-cli";

// A trimmed excerpt of LiteLLM's model_prices_and_context_window.json at
// commit a1c5829f6b7664135974e902bdee2419c53ef825 (2026-11-01), unedited entries.
const recorded = await readFile(new URL("fixtures/litellm-prices.json", import.meta.url), "utf8");
const recordedJson = JSON.parse(recorded) as Record<string, Record<string, unknown>>;
const { "gpt-image-2.5-sunburst": _sunburst, ...withoutSunburst } = recordedJson;

const hits = new Map<string, number>();
const routes: Record<string, () => Response> = {
  "/prices.json": () => new Response(recorded),
  "/not-json": () => new Response("<html>rate limited</html>"),
  "/empty": () => Response.json({}),
  "/partial": () => Response.json(withoutSunburst),
  // Other entries malformed in every way the decoder can see; our models must still price.
  "/junk-entries": () =>
    Response.json({
      ...recordedJson,
      "junk/null-price": { input_cost_per_token: null, output_cost_per_token: 1 },
      "junk/string-price": { input_cost_per_token: "0.1", output_cost_per_token: 1 },
      "junk/negative-price": { input_cost_per_token: -1, output_cost_per_token: 1 },
      "junk/not-an-object": "x",
    }),
  // The Vertex entry priced differently, to prove Gemini reads the Gemini API entry.
  "/vertex-differs": () =>
    Response.json({
      ...recordedJson,
      "gemini-nano-banana-2.1": {
        ...recordedJson["gemini-nano-banana-2.1"],
        input_cost_per_token: 9e-6,
        output_cost_per_token: 9e-6,
        output_cost_per_image_token: 9e-5,
        output_cost_per_image: 0.9,
      },
    }),
  // A default model's entry malformed: the refresh must fail rather than drop it.
  "/bad-default": () =>
    Response.json({
      ...recordedJson,
      "claude-sonnet-5-5": {
        ...recordedJson["claude-sonnet-5-5"],
        input_cost_per_token: "0.000003",
      },
    }),
  // Sends the start of a body and never finishes it.
  "/hang": () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{"));
        },
      }),
    ),
};
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const path = new URL(request.url).pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    return routes[path]?.() ?? new Response("unavailable", { status: 503 });
  },
});
afterAll(() => server.stop(true));
const at = (path: string) => new URL(path, server.url).href;

// A port that was just released, so connecting to it is refused.
const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
const refusedUrl = new URL("/prices.json", closed.url).href;
await closed.stop(true);

const start = new Date("2026-11-01T12:00:00Z");
let clock = start;
const advanceHours = (hours: number) => {
  clock = new Date(clock.getTime() + hours * 3_600_000);
};

let directory: string;
const opened: PriceSource[] = [];
async function open(options: Partial<PriceSourceOptions> = {}) {
  const source = await openPriceSource({
    dataDirectory: directory,
    url: at("/prices.json"),
    now: () => clock,
    ...options,
  });
  opened.push(source);
  return source;
}
const lookup = (source: PriceSource, model: string) => Effect.runPromise(source.lookup(model));
const lookupError = (source: PriceSource, model: string) =>
  Effect.runPromise(Effect.flip(source.lookup(model)));
/** Corrupt the price database behind the price source's back. */
async function tamper(sql: string) {
  const raw = createClient({ url: pathToFileURL(pricesDatabase(directory)).href });
  await raw.execute(sql);
  raw.close();
}

beforeEach(async () => {
  hits.clear();
  clock = start;
  directory = await mkdtemp(join(tmpdir(), "iconograph-prices-"));
});
afterEach(async () => {
  for (const source of opened.splice(0)) source.close();
  await rm(directory, { recursive: true, force: true });
});

describe("LiteLLM fetch and cache", () => {
  test("parses the recorded response and stores it with its fetch time", async () => {
    const source = await open();
    expect(await source.refresh()).toEqual({ refreshed: true, fetchedAt: start, rejected: [] });
    advanceHours(1);
    expect(await lookup(source, "gpt-image-2.5-sunburst")).toEqual({
      model: "gpt-image-2.5-sunburst",
      pricing: {
        _tag: "OpenAIImage",
        inputPerToken: 5e-6,
        inputPerImageToken: 8e-6,
        outputPerImageToken: 3e-5,
      },
      source: { _tag: "litellm", asOf: start.toISOString(), ageSeconds: 3600, stale: false },
    });
    expect(await Bun.file(pricesDatabase(directory)).exists()).toBe(true);

    // A second process on the same data volume reads the same cache.
    const reopened = await open();
    expect((await lookup(reopened, "claude-sonnet-5-5")).pricing).toEqual({
      _tag: "Llm",
      inputPerToken: 2e-6,
      outputPerToken: 1e-5,
    });
    expect(hits.get("/prices.json")).toBe(1);
  });

  test("Gemini reads the Gemini API entry, not Vertex, with the 2K price from image tokens", async () => {
    const source = await open({ url: at("/vertex-differs") });
    await source.refresh();
    const { pricing } = await lookup(source, "gemini-nano-banana-2.1");
    expect(pricing).toMatchObject({
      _tag: "GeminiImage",
      inputPerToken: 1.5e-6,
      outputPerToken: 7.5e-6,
      outputPerImageToken: 3e-5,
      outputPerImage: 0.0336,
    });
    expect(pricing._tag === "GeminiImage" && pricing.outputPer2KImage).toBeCloseTo(0.0504, 10);
  });

  test("tolerates unknown fields and unpriced entries; skips the format's sample_spec", () => {
    const { prices, rejected } = decodeLiteLLMPrices(recordedJson);
    expect([...prices.keys()].sort()).toEqual([
      "claude-sonnet-5-5",
      "gemini-nano-banana-2.1",
      "gemini/gemini-nano-banana-2.1",
      "gpt-image-2.5-flare",
      "gpt-image-2.5-sunburst",
    ]);
    expect(rejected).toEqual([]);
    expect(prices.get("claude-sonnet-5-5")).toEqual({
      input_cost_per_token: 2e-6,
      output_cost_per_token: 1e-5,
    });
  });

  test("malformed unrelated entries are dropped and reported; our models still price", async () => {
    const source = await open({ url: at("/junk-entries") });
    expect((await source.refresh()).rejected).toEqual([
      "junk/null-price",
      "junk/string-price",
      "junk/negative-price",
      "junk/not-an-object",
    ]);
    expect((await lookup(source, "claude-sonnet-5-5")).source._tag).toBe("litellm");
    expect(await lookupError(source, "junk/null-price")).toMatchObject({ _tag: "Unpriced" });
  });

  test("a default model missing from a fetched cache is unpriced, not taken from the snapshot", async () => {
    const source = await open({ url: at("/partial") });
    await source.refresh();
    const error = await lookupError(source, "gpt-image-2.5-sunburst");
    expect(error).toMatchObject({ _tag: "Unpriced", model: "gpt-image-2.5-sunburst" });
    expect(error.message).toBe(
      `No price for model gpt-image-2.5-sunburst: not in the LiteLLM price data fetched ${start.toISOString()}`,
    );
  });

  test.each([
    ["an HTTP error", { url: at("/unavailable") }, `HTTP 503 from ${at("/unavailable")}`],
    [
      "a body that is not JSON",
      { url: at("/not-json") },
      `LiteLLM price data from ${at("/not-json")} is invalid: JSON Parse error`,
    ],
    [
      "data with no priced model",
      { url: at("/empty") },
      `LiteLLM price data from ${at("/empty")} is invalid: No model in the price data has a price`,
    ],
    [
      "a refused connection",
      { url: refusedUrl },
      `LiteLLM price fetch from ${refusedUrl} failed: `,
    ],
    [
      "a body that never finishes",
      { url: at("/hang"), timeoutMs: 50 },
      `LiteLLM price fetch from ${at("/hang")} failed: `,
    ],
    [
      "a malformed entry for a default model",
      { url: at("/bad-default") },
      `LiteLLM price data from ${at("/bad-default")} has malformed prices for default model claude-sonnet-5-5; keeping the existing cache`,
    ],
  ])("%s is an error and leaves the existing cache intact", async (_, options, message) => {
    await (await open()).refresh();
    advanceHours(30);
    const broken = await open(options);
    await expect(broken.refresh()).rejects.toThrow(message);
    await expect(broken.ensureFresh()).rejects.toBeInstanceOf(PriceFetchError);
    expect((await lookup(broken, "claude-sonnet-5-5")).source).toEqual({
      _tag: "litellm",
      asOf: start.toISOString(),
      ageSeconds: 30 * 3600,
      stale: true,
    });
  });

  test("a failed first fetch leaves no cache, so the snapshot answers", async () => {
    const source = await open({ url: at("/unavailable") });
    await expect(source.ensureFresh()).rejects.toThrow("HTTP 503");
    const snapshot = readPriceSnapshot();
    expect((await lookup(source, "claude-sonnet-5-5")).source).toMatchObject({
      _tag: "snapshot",
      asOf: snapshot.fetchedAt,
      commit: snapshot.commit,
    });
  });

  test("an unreadable stored price is a PriceStoreError, not a defect", async () => {
    const source = await open();
    await source.refresh();
    await tamper("UPDATE litellm_prices SET fields = 'not json' WHERE model = 'claude-sonnet-5-5'");
    const error = await lookupError(source, "claude-sonnet-5-5");
    expect(error).toBeInstanceOf(PriceStoreError);
    expect(error.message).toStartWith(
      "Reading the price of claude-sonnet-5-5 from the price database failed: ",
    );
  });

  test("a tampered stored date is a PriceStoreError, not a defect", async () => {
    const source = await open();
    await source.refresh();
    await tamper("UPDATE litellm_fetch SET fetched_at = 'abc'");
    const error = await lookupError(source, "claude-sonnet-5-5");
    expect(error).toBeInstanceOf(PriceStoreError);
    expect(error.message).toContain("Stored date abc is invalid");
  });

  test("an injected fetch that throws synchronously is a PriceFetchError", async () => {
    const source = await open({
      fetch: () => {
        throw new Error("no network in this sandbox");
      },
    });
    const failure = source.refresh();
    await expect(failure).rejects.toBeInstanceOf(PriceFetchError);
    await expect(failure).rejects.toThrow("failed: no network in this sandbox");
  });

  test("aborting the signal ends a hanging refresh with a PriceFetchError, cache intact", async () => {
    await (await open()).refresh();
    advanceHours(30);
    const answered = Promise.withResolvers<void>();
    const hanging = await open({
      url: at("/hang"),
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        answered.resolve();
        return response;
      },
    });
    const abort = new AbortController();
    const failure = hanging.ensureFresh({ signal: abort.signal });
    // Mid-body: the headers have arrived and the body never finishes.
    await answered.promise;
    abort.abort(new Error("server stopping"));
    await expect(failure).rejects.toBeInstanceOf(PriceFetchError);
    await expect(failure).rejects.toThrow("server stopping");
    expect((await lookup(hanging, "claude-sonnet-5-5")).source).toMatchObject({
      _tag: "litellm",
      asOf: start.toISOString(),
    });
  });

  test("a write waits for another process's lock instead of failing at once", async () => {
    const source = await open();
    // libsql's local calls block the JS thread while busy-waiting, so the lock is
    // held by a separate process (as the server and CLI would be), released after 300 ms.
    const holder = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { createClient } from "@libsql/client";
        const client = createClient({ url: ${JSON.stringify(pathToFileURL(pricesDatabase(directory)).href)} });
        const transaction = await client.transaction("write");
        await transaction.execute("DELETE FROM price_overrides");
        console.log("locked");
        setTimeout(async () => { await transaction.commit(); client.close(); }, 300);`,
      ],
      { cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "inherit" },
    );
    try {
      const reader = holder.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("locked");
      const stored = await source.setOverride("local-judge", {
        input_cost_per_token: 0,
        output_cost_per_token: 0,
      });
      expect(stored.fields).toEqual({ input_cost_per_token: 0, output_cost_per_token: 0 });
      expect(await holder.exited).toBe(0);
    } finally {
      holder.kill();
    }
  });
});

describe("refresh rule", () => {
  test("no request while the cache is younger than 24 h; one request once it is older", async () => {
    const source = await open();
    expect((await source.ensureFresh()).refreshed).toBe(true);
    advanceHours(23.9);
    expect(await source.ensureFresh()).toEqual({ refreshed: false, fetchedAt: start });
    expect(hits.get("/prices.json")).toBe(1);
    advanceHours(0.2);
    expect(await source.ensureFresh()).toMatchObject({ refreshed: true, fetchedAt: clock });
    expect(hits.get("/prices.json")).toBe(2);
    expect((await lookup(source, "claude-sonnet-5-5")).source).toMatchObject({ ageSeconds: 0 });
  });

  test("a cache dated in the future (clock moved back) is stale and refetched", async () => {
    const source = await open();
    await source.refresh();
    advanceHours(-1);
    expect((await lookup(source, "claude-sonnet-5-5")).source).toEqual({
      _tag: "litellm",
      asOf: start.toISOString(),
      ageSeconds: 0,
      stale: true,
    });
    expect((await source.ensureFresh()).refreshed).toBe(true);
    expect(hits.get("/prices.json")).toBe(2);
  });
});

describe("snapshot and overrides", () => {
  test("the bundled snapshot prices every default model", async () => {
    const source = await open({ url: at("/unavailable") });
    for (const model of Object.keys(pricingSpecs)) {
      expect((await lookup(source, model)).source._tag).toBe("snapshot");
    }
  });

  test.each(["soon", "1", "Nov 1 2026", "2026-11-01"])(
    "a snapshot dated %p is rejected, injected or bundled",
    async (fetchedAt) => {
      const snapshot = { ...readPriceSnapshot(), fetchedAt };
      expect(() => Schema.decodeUnknownSync(PriceSnapshot)(snapshot)).toThrow(
        "Expected an ISO 8601 date-time with a time zone",
      );
      await expect(open({ snapshot })).rejects.toThrow("Expected an ISO 8601 date-time");
    },
  );

  test("an override beats the cache until cleared", async () => {
    const source = await open();
    await source.refresh();
    advanceHours(1);
    const fields = { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 };
    expect(await source.setOverride("claude-sonnet-5-5", fields)).toEqual({ fields, setAt: clock });
    advanceHours(1);
    expect(await lookup(source, "claude-sonnet-5-5")).toEqual({
      model: "claude-sonnet-5-5",
      pricing: { _tag: "Llm", inputPerToken: 1e-6, outputPerToken: 2e-6 },
      source: { _tag: "override", asOf: "2026-11-01T13:00:00.000Z", ageSeconds: 3600 },
    });
    expect(await source.clearOverride("claude-sonnet-5-5")).toBe(true);
    expect(await source.clearOverride("claude-sonnet-5-5")).toBe(false);
    expect((await lookup(source, "claude-sonnet-5-5")).source._tag).toBe("litellm");
  });

  test("an override prices a model LiteLLM lacks", async () => {
    const source = await open();
    await source.refresh();
    expect(await lookupError(source, "local-judge")).toMatchObject({
      _tag: "Unpriced",
      model: "local-judge",
    });
    await source.setOverride("local-judge", { input_cost_per_token: 0, output_cost_per_token: 0 });
    expect((await lookup(source, "local-judge")).source._tag).toBe("override");
  });

  test.each([
    [
      "gpt-image-2.5-flare",
      "a misspelt field",
      { input_cost_per_tokn: 1, output_cost_per_token: 1 },
      "excess property",
    ],
    [
      "gpt-image-2.5-flare",
      "a negative price",
      { input_cost_per_token: -1, output_cost_per_token: 1 },
      "greater than",
    ],
    [
      "gpt-image-2.5-flare",
      "a field the pricing mode needs",
      { input_cost_per_token: 1, output_cost_per_token: 1 },
      "needs input_cost_per_image_token, output_cost_per_image_token",
    ],
    [
      "local-image-model",
      "image prices on an unmapped model",
      { input_cost_per_token: 1, output_cost_per_token: 1, output_cost_per_image: 1 },
      "output_cost_per_image make it more than an LLM",
    ],
  ])("an override for %s with %s is rejected and not stored", async (model, _, fields, message) => {
    const source = await open({ url: at("/unavailable") });
    await expect(source.setOverride(model, fields)).rejects.toThrow(message);
    expect(await source.clearOverride(model)).toBe(false);
  });
});

describe("prices command", () => {
  // Only the default LiteLLM URL and the local server are reachable; anything else fails loudly.
  const fetchRecorded = (url: string, init?: RequestInit) => {
    if (url === litellmPricesUrl) return fetch(at("/prices.json"), init);
    if (url.startsWith(server.url.href)) return fetch(url, init);
    throw new Error(`Test tried to reach ${url}`);
  };

  type Printed = PriceQuote & {
    refresh: { refreshed: boolean; fetchedAt?: string; rejected?: string[]; error?: string };
  };
  async function capture<T = Printed>(args: string[]): Promise<T> {
    let output = "";
    await main([...args, "--data-dir", directory], {
      fetch: fetchRecorded,
      now: () => clock,
      stdout: (text) => (output += text),
    });
    return JSON.parse(output) as T;
  }

  test("prints price, source and age; reruns use the cache until it is 24 h old", async () => {
    const first = await capture(["claude-sonnet-5-5"]);
    expect(first).toEqual({
      model: "claude-sonnet-5-5",
      pricing: { _tag: "Llm", inputPerToken: 2e-6, outputPerToken: 1e-5 },
      source: { _tag: "litellm", asOf: start.toISOString(), ageSeconds: 0, stale: false },
      refresh: { refreshed: true, fetchedAt: start.toISOString(), rejected: [] },
    });
    advanceHours(2);
    const second = await capture(["claude-sonnet-5-5"]);
    expect(second.source).toMatchObject({ ageSeconds: 7200 });
    expect(second.refresh).toEqual({ refreshed: false, fetchedAt: start.toISOString() });
    expect((await capture(["claude-sonnet-5-5", "--refresh"])).refresh).toMatchObject({
      refreshed: true,
    });
    expect(hits.get("/prices.json")).toBe(2);
  });

  test("sets and clears an override", async () => {
    const set = await capture<unknown>([
      "claude-sonnet-5-5",
      "--set-override",
      '{"input_cost_per_token":1,"output_cost_per_token":2}',
    ]);
    expect(set).toEqual({
      model: "claude-sonnet-5-5",
      override: { input_cost_per_token: 1, output_cost_per_token: 2 },
      setAt: start.toISOString(),
    });
    expect((await capture(["claude-sonnet-5-5"])).source._tag).toBe("override");
    expect(await capture<unknown>(["claude-sonnet-5-5", "--clear-override"])).toEqual({
      model: "claude-sonnet-5-5",
      cleared: true,
    });
    expect((await capture(["claude-sonnet-5-5"])).source._tag).toBe("litellm");
  });

  test("an implicit refresh that fails is reported while the snapshot answers", async () => {
    const quote = await capture(["gpt-image-2.5-flare", "--url", at("/unavailable")]);
    expect(quote.source._tag).toBe("snapshot");
    expect(quote.refresh).toEqual({
      refreshed: false,
      error: `LiteLLM price fetch failed: HTTP 503 from ${at("/unavailable")}`,
    });
  });

  test("rejects bad arguments, conflicting actions and invalid override JSON", async () => {
    await expect(capture([])).rejects.toThrow("Expected exactly one MODEL");
    await expect(capture(["a", "b"])).rejects.toThrow("Expected exactly one MODEL");
    await expect(capture(["a", "--refresh", "--clear-override"])).rejects.toThrow("at most one");
    await expect(capture(["a", "--set-override", "{input_cost_per_token: 1}"])).rejects.toThrow(
      "--set-override is not valid JSON: ",
    );
  });

  test("an implicit refresh failing for a reason other than fetching fails the command", async () => {
    // `refresh` reads the clock only after a successful fetch and decode. Only that
    // first call throws, so the lookup succeeds and only the rethrow can fail `main`.
    let calls = 0;
    const broken = main(["claude-sonnet-5-5", "--data-dir", directory], {
      fetch: fetchRecorded,
      now: () => {
        if (calls++ === 0) throw new Error("clock unavailable");
        return start;
      },
      stdout: () => {},
    });
    await expect(broken).rejects.toThrow(/^clock unavailable$/);
    expect(hits.get("/prices.json")).toBe(1);
  });

  // The root script, run as an operator would, against the local recorded server.
  async function script(...args: string[]) {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const child = Bun.spawn([process.execPath, "run", "--silent", "prices", ...args], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  test("the root script prints a price as JSON and exits zero", async () => {
    const result = await script(
      "claude-sonnet-5-5",
      "--data-dir",
      directory,
      "--url",
      at("/prices.json"),
    );
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(result.stdout).source._tag).toBe("litellm");
  });

  test("an unpriced model is a JSON Unpriced error on stderr with a nonzero exit", async () => {
    const result = await script(
      "no-such-model",
      "--data-dir",
      directory,
      "--url",
      at("/prices.json"),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    const report = JSON.parse(result.stderr);
    expect(report).toMatchObject({ _tag: "Unpriced", model: "no-such-model" });
    expect(report.error).toStartWith(
      "No price for model no-such-model: not in the LiteLLM price data fetched ",
    );
  });

  test("a failed explicit --refresh is a JSON error on stderr with a nonzero exit", async () => {
    const url = at("/unavailable");
    const result = await script(
      "claude-sonnet-5-5",
      "--refresh",
      "--data-dir",
      directory,
      "--url",
      url,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      error: `LiteLLM price fetch failed: HTTP 503 from ${url}`,
    });
  });

  test("an unpriced lookup after a failed implicit refresh reports that refresh on stderr", async () => {
    const url = at("/unavailable");
    const result = await script("no-such-model", "--data-dir", directory, "--url", url);
    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stderr)).toEqual({
      error: `No price for model no-such-model: not in the bundled price snapshot of ${readPriceSnapshot().fetchedAt}`,
      _tag: "Unpriced",
      model: "no-such-model",
      refresh: { refreshed: false, error: `LiteLLM price fetch failed: HTTP 503 from ${url}` },
    });
  });
});
