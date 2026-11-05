import { describe, expect, test } from "bun:test";
import { ImageModels, type ImageRequest, toMicros } from "@iconograph/domain";
import { Duration, Effect } from "effect";
import {
  GEMINI_API_REVISION,
  GEMINI_INTERACTIONS_URL,
  type GeminiFetch,
  geminiImageModel,
} from "../src/gemini";
import { NativeImageModels } from "../src/image-models";
import { geminiTestPrice as price, recordedGemini as recorded } from "./gemini-fixtures";
import {
  generateRecorded,
  hangingFetch,
  recordedReplies,
  type Sent,
  scriptedFetch,
} from "./scripted-fetch";

const API_KEY = "test-key-NOT-REAL-0123456789";
const { pricing } = price;

const reply = recordedReplies(recorded);

const reference = (byte: number) => ({
  bytes: new Uint8Array([0xff, 0xd8, 0xff, byte]),
  mimeType: "image/jpeg",
});
const request: ImageRequest = {
  prompt: "A professional headshot of the person in the reference photos.",
  references: [reference(1), reference(2), reference(3), reference(4)],
  size: "2K",
};

const modelWith = (fetch: GeminiFetch) =>
  geminiImageModel({ model: "gemini-nano-banana-2.1", apiKey: API_KEY, price, fetch });

const generate = (fetch: GeminiFetch) => generateRecorded(modelWith(fetch), request);

describe("Gemini adapter against recorded responses", () => {
  test("sends one stateless 2K interaction with the prompt and references, key in a header only", async () => {
    const { fetch, sent } = scriptedFetch([reply(200, "completed-image.json")]);
    await Effect.runPromise(modelWith(fetch).call(request));
    expect(sent).toHaveLength(1);
    const [{ url, init }] = sent as [Sent];
    expect(url).toBe(GEMINI_INTERACTIONS_URL);
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("x-goog-api-key")).toBe(API_KEY);
    expect(headers.get("api-revision")).toBe(GEMINI_API_REVISION);
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: "gemini-nano-banana-2.1",
      store: false,
      response_format: { type: "image", image_size: "2K", mime_type: "image/jpeg" },
    });
    expect(body.response_format).not.toHaveProperty("delivery");
    expect(body.input[0]).toEqual({ type: "text", text: request.prompt });
    const images = body.input.slice(1);
    expect(images).toHaveLength(4);
    expect(images[0]).toEqual({
      type: "image",
      mime_type: "image/jpeg",
      data: Buffer.from(request.references[0]!.bytes).toString("base64"),
    });
    expect(String(init.body)).not.toContain(API_KEY);
    expect(modelWith(fetch).capabilities).toMatchObject({
      maxCharacterReferences: 4,
      sizes: ["2K"],
    });
  });

  test("a completed interaction yields its image, usage and the actual cost from usage", async () => {
    const { fetch } = scriptedFetch([reply(200, "completed-image.json")]);
    const result = await Effect.runPromise(modelWith(fetch).call(request));
    const fixture = JSON.parse(await recorded("completed-image.json"));
    const data = fixture.steps[1].content[1].data;
    expect(result.kind).toBe("image");
    if (result.kind !== "image") return;
    expect(Buffer.from(result.image.bytes).toString("base64")).toBe(data);
    expect(result.image.mimeType).toBe("image/jpeg");
    expect(result.usage).toEqual({
      inputTokens: 2600,
      outputImageTokens: 1680,
      outputTextTokens: 10,
      thoughtTokens: 290,
    });
    // 2600 × $1.50/M + 1680 × $30/M + (10 + 290) × $7.50/M = $0.0039 + $0.0504 + $0.00225
    expect(result.costMicros).toBe(toMicros(0.0039 + 0.0504 + 0.00225));
  });

  test("a safety block is Refused with the vendor's reason, not retried and not billed", async () => {
    const { fetch, sent } = scriptedFetch([reply(400, "error-safety-400.json")]);
    const { generation, settled } = await generate(fetch);
    expect(sent).toHaveLength(1);
    expect(generation).toEqual({
      kind: "refused",
      reason:
        "safety: Request blocked due to safety violations (harmful content). Please modify your input and retry.",
    });
    expect(settled).toEqual([expect.objectContaining({ kind: "refused", costMicros: 0 })]);
  });

  test("the live policy block (content_blocked, captured 2026-11-01) is Refused, not Failed", async () => {
    const { fetch, sent } = scriptedFetch([reply(400, "error-content-blocked-400.json")]);
    const { generation } = await generate(fetch);
    expect(sent).toHaveLength(1);
    expect(generation).toEqual({
      kind: "refused",
      reason:
        "content_blocked: Request blocked for an unspecified policy reason. Please modify your input and retry.",
    });
  });

  test("a completed interaction without an image is the model declining, with its text", async () => {
    const { fetch } = scriptedFetch([reply(200, "completed-text-only.json")]);
    const result = await Effect.runPromise(modelWith(fetch).call(request));
    expect(result).toMatchObject({
      kind: "refused",
      reason: "I can't create images of this person.",
    });
    // Its tokens are billed: 2600 × $1.50/M + (9 + 120) × $7.50/M.
    expect(result.costMicros).toBe(toMicros(0.0039 + 129 * 7.5e-6));
  });

  test("429 and 5xx are retried twice, then Failed; each try is a recorded, unbilled call", async () => {
    const { fetch, sent } = scriptedFetch([
      reply(429, "error-rate-limit-429.json"),
      reply(503, "error-unavailable-503.json"),
      reply(500, "error-unavailable-503.json"),
    ]);
    const { generation, settled } = await generate(fetch);
    expect(sent).toHaveLength(3);
    expect(generation).toMatchObject({ kind: "failed", budgetExhausted: false });
    expect(generation.kind === "failed" && generation.reason).toContain("gave up after 3 attempts");
    expect(settled.map((result) => [result.kind, result.costMicros])).toEqual([
      ["transient", 0],
      ["transient", 0],
      ["transient", 0],
    ]);
    expect(settled[0]).toMatchObject({ reason: expect.stringContaining("429 RESOURCE_EXHAUSTED") });
  });

  test("succeeds after one retry", async () => {
    const { fetch, sent } = scriptedFetch([
      reply(503, "error-unavailable-503.json"),
      reply(200, "completed-image.json"),
    ]);
    const { generation } = await generate(fetch);
    expect(sent).toHaveLength(2);
    expect(generation.kind).toBe("image");
  });

  test("a non-transient error is Failed at once with the status and message", async () => {
    const { fetch, sent } = scriptedFetch([reply(400, "error-invalid-key-400.json")]);
    const { generation } = await generate(fetch);
    expect(sent).toHaveLength(1);
    expect(generation).toEqual({
      kind: "failed",
      reason: "Gemini HTTP 400 INVALID_ARGUMENT: API key not valid. Please pass a valid API key.",
      budgetExhausted: false,
    });
  });

  test("a malformed response is Failed with a clear reason and an unknown cost", async () => {
    for (const body of ["<html>bad gateway</html>", '{"status":"completed","steps":"nope"}']) {
      const { fetch } = scriptedFetch([async () => new Response(body, { status: 200 })]);
      const result = await Effect.runPromise(modelWith(fetch).call(request));
      expect(result).toEqual({
        kind: "failed",
        reason: "Gemini returned a malformed interaction",
        usage: null,
        costMicros: null,
      });
    }
  });

  test("a network failure is transient with an unknown cost, and never mentions the key", async () => {
    const { fetch } = scriptedFetch([
      async () => {
        throw new TypeError("fetch failed: connect ECONNRESET");
      },
    ]);
    const result = await Effect.runPromise(modelWith(fetch).call(request));
    expect(result).toMatchObject({ kind: "transient", costMicros: null });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  test("an error quoting the key (e.g. a rejected header value) is redacted from the reason", async () => {
    const { fetch } = scriptedFetch([
      async () => {
        throw new TypeError(`Header 'x-goog-api-key' has invalid value: '${API_KEY}'`);
      },
    ]);
    const result = await Effect.runPromise(modelWith(fetch).call(request));
    expect(result).toMatchObject({
      kind: "transient",
      reason: expect.stringContaining("[redacted]"),
    });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  const json = (status: number, body: unknown) => async () =>
    new Response(JSON.stringify(body), { status });
  const usage = { total_input_tokens: 100, total_output_tokens: 10, total_thought_tokens: 0 };
  const completed = (content: unknown[], extra: Record<string, unknown> = { usage }) => ({
    status: "completed",
    steps: [{ type: "model_output", content }],
    ...extra,
  });
  const classify = async (respond: () => Promise<Response>) =>
    Effect.runPromise(modelWith(scriptedFetch([respond]).fetch).call(request));

  test("a text-only answer without usage is Refused at an unknown cost, never free", async () => {
    const result = await classify(
      json(200, completed([{ type: "text", text: "I can't do that." }], {})),
    );
    expect(result).toEqual({
      kind: "refused",
      reason: "I can't do that.",
      usage: null,
      costMicros: null,
    });
  });

  test("a missing or malformed image is Failed, not mistaken for a refusal", async () => {
    const cases: [unknown, string][] = [
      [
        completed([{ type: "image", uri: "https://example.invalid/i.jpg" }]),
        "image without inline data",
      ],
      [{ status: "completed", steps: [], usage }, "no model output"],
      [completed([{ type: "image", mime_type: "image/jpeg", data: "" }]), "an empty image"],
      [{ status: "incomplete", steps: [], usage }, "interaction incomplete"],
      [completed([{ type: "thought" }]), "neither an image nor text"],
    ];
    for (const [body, reason] of cases) {
      const result = await classify(json(200, body));
      expect(result).toMatchObject({ kind: "failed", reason: expect.stringContaining(reason) });
    }
  });

  test("every 200 result without a complete usage report costs as unknown, never too little", async () => {
    const fixture = JSON.parse(await recorded("completed-image.json"));
    const full = fixture.usage;
    const outcomes: [string, (usage: unknown) => unknown, string][] = [
      ["image", (usage) => ({ ...fixture, usage }), "image"],
      ["text refusal", (usage) => completed([{ type: "text", text: "No." }], { usage }), "refused"],
      [
        "safety block",
        (usage) => ({ status: "failed", steps: [], errors: [{ code: "safety" }], usage }),
        "refused",
      ],
      ["incomplete", (usage) => ({ status: "incomplete", steps: [], usage }), "failed"],
      [
        "image without data",
        (usage) => completed([{ type: "image", uri: "https://example.invalid/i.jpg" }], { usage }),
        "failed",
      ],
      [
        "empty image",
        (usage) => completed([{ type: "image", mime_type: "image/jpeg", data: "" }], { usage }),
        "failed",
      ],
    ];
    const without = (key: string) => {
      const { [key]: _, ...rest } = full;
      return rest;
    };
    const withSplit = (split: unknown[]) => ({ ...full, output_tokens_by_modality: split });
    const gaps: [string, unknown][] = [
      ["no input total", without("total_input_tokens")],
      ["no output total", without("total_output_tokens")],
      ["no thought total", without("total_thought_tokens")],
      ["no modality split", without("output_tokens_by_modality")],
      ["empty split", withSplit([])],
      [
        "image entry without tokens",
        withSplit([{ modality: "image" }, { modality: "text", tokens: 10 }]),
      ],
      ["split below the output total", withSplit([{ modality: "text", tokens: 10 }])],
    ];
    for (const [outcome, body, kind] of outcomes) {
      const priced = await classify(json(200, body(full)));
      expect([outcome, priced.kind as string, typeof priced.costMicros]).toEqual([
        outcome,
        kind,
        "number",
      ]);
      for (const [gap, usage] of gaps) {
        const result = await classify(json(200, body(usage)));
        expect([outcome, gap, result.costMicros]).toEqual([outcome, gap, null]);
      }
    }
    // A split that adds up but counts no image tokens: fine for text, never for any image block.
    const textOnly = {
      ...full,
      total_output_tokens: 10,
      output_tokens_by_modality: [{ modality: "text", tokens: 10 }],
    };
    for (const [outcome, body] of outcomes) {
      const result = await classify(json(200, body(textOnly)));
      const hasImageBlock = outcome.includes("image");
      expect([outcome, result.costMicros === null]).toEqual([outcome, hasImageBlock]);
    }
    // No output at all needs no split.
    const noOutput = { ...without("output_tokens_by_modality"), total_output_tokens: 0 };
    const refusal = completed([{ type: "text", text: "No." }], { usage: noOutput });
    expect((await classify(json(200, refusal))).costMicros).toBeNumber();
  });

  test("stored usage keeps only the counts Gemini reported", async () => {
    const fixture = JSON.parse(await recorded("completed-image.json"));
    const { total_thought_tokens: _, ...usage } = fixture.usage;
    const result = await classify(json(200, { ...fixture, usage }));
    expect(result).toMatchObject({ kind: "image", costMicros: null });
    expect(result.kind === "image" && result.usage).toEqual({
      inputTokens: 2600,
      outputImageTokens: 1680,
      outputTextTokens: 10,
    });
    // Without a complete split, the text share isn't stored: it would be a guess.
    const unsplit = await classify(
      json(200, { ...fixture, usage: { ...fixture.usage, output_tokens_by_modality: [] } }),
    );
    expect(unsplit.kind === "image" && unsplit.usage).toEqual({
      inputTokens: 2600,
      thoughtTokens: 290,
    });
  });

  test("a billed image without any usage report is kept, at an unknown cost", async () => {
    const fixture = JSON.parse(await recorded("completed-image.json"));
    const { usage: _, ...withoutUsage } = fixture;
    const result = await classify(json(200, withoutUsage));
    expect(result).toMatchObject({ kind: "image", usage: null, costMicros: null });
  });

  test("a policy block inside a 200 interaction is Refused", async () => {
    const result = await classify(
      json(200, {
        status: "failed",
        steps: [],
        errors: [{ code: "safety", message: "Response blocked" }],
      }),
    );
    expect(result).toMatchObject({ kind: "refused", reason: "safety: Response blocked" });
  });

  test("an HTTP error body quoting the key is redacted from the classified reason", async () => {
    const result = await classify(
      json(400, { error: { code: 400, message: `API key ${API_KEY} not valid` } }),
    );
    expect(result).toMatchObject({ kind: "failed", reason: expect.stringContaining("[redacted]") });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  test("every documented safety code is Refused at $0; 408 is transient", async () => {
    for (const code of [
      "safety",
      "jailbreak",
      "prohibited_content",
      "blocklist",
      "content_blocked",
    ]) {
      const result = await classify(json(400, { error: { code, message: "Input blocked: test" } }));
      expect(result).toMatchObject({
        kind: "refused",
        reason: `${code}: Input blocked: test`,
        costMicros: 0,
      });
    }
    const timeout = await classify(json(408, { error: { code: 408, message: "Request timeout" } }));
    expect(timeout).toMatchObject({ kind: "transient", costMicros: 0 });
  });

  test("interrupting a call aborts its request", async () => {
    const { fetch, state } = hangingFetch();
    await Effect.runPromise(
      modelWith(fetch)
        .call(request)
        .pipe(Effect.timeout(Duration.millis(20)), Effect.ignore),
    );
    expect(state.aborted).toBe(true);
  });

  test("the estimate covers a 2K image and grows with the references", () => {
    const model = modelWith(scriptedFetch([]).fetch);
    const four = model.estimate(request);
    const none = model.estimate({ ...request, references: [] });
    expect(four.micros).toBeGreaterThan(toMicros(pricing.outputPer2KImage));
    expect(four.micros - none.micros).toBe(toMicros(4 * 1120 * pricing.inputPerToken));
  });
});

describe("Image Model selection", () => {
  const lookups: string[] = [];
  const prices = { lookup: (model: string) => Effect.sync(() => (lookups.push(model), price)) };

  test("a missing GEMINI_API_KEY fails before any call or price lookup", async () => {
    const { fetch, sent } = scriptedFetch([]);
    const layer = NativeImageModels({ prices, env: {}, geminiFetch: fetch });
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* ImageModels).get("gemini-nano-banana-2.1");
      }).pipe(Effect.flip, Effect.provide(layer)),
    );
    expect(error).toMatchObject({ _tag: "ImageModelUnavailable" });
    expect(error.message).toContain("GEMINI_API_KEY is not set");
    expect(sent).toHaveLength(0);
    expect(lookups).toHaveLength(0);
  });

  test("a short key, or one with control, space or non-ASCII characters, is rejected without echoing it", async () => {
    for (const bad of [
      "AIzaFAKEFAKEFAKEFAKE\nx",
      "AIzaFAKEFAKEFAKEFAKÉ€",
      "AIza FAKEFAKEFAKEFAKE",
      "AIzaFAKE",
      "AIzaFAKEFAKEFAKEFAK", // 19 characters
    ]) {
      const { fetch, sent } = scriptedFetch([]);
      const layer = NativeImageModels({ prices, env: { GEMINI_API_KEY: bad }, geminiFetch: fetch });
      const error = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* ImageModels).get("gemini-nano-banana-2.1");
        }).pipe(Effect.flip, Effect.provide(layer)),
      );
      expect(error).toMatchObject({ _tag: "ImageModelUnavailable" });
      expect(JSON.stringify(error)).not.toContain("FAK");
      expect(sent).toHaveLength(0);
    }
    // 20 characters is long enough (given a recorded price, so nothing is looked up).
    const minimal = NativeImageModels({ prices, env: { GEMINI_API_KEY: "AIzaFAKEFAKEFAKEFAKE" } });
    await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* ImageModels).get("gemini-nano-banana-2.1", price);
      }).pipe(Effect.provide(minimal)),
    );
    expect(lookups).toHaveLength(0);
  });

  test("given the price recorded at Run start, the model uses it and looks nothing up", async () => {
    const before = lookups.length;
    const layer = NativeImageModels({ prices, env: { GEMINI_API_KEY: API_KEY } });
    const recordedPrice = { ...price, source: { ...price.source, ageSeconds: 99 } };
    const model = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* ImageModels).get("gemini-nano-banana-2.1", recordedPrice);
      }).pipe(Effect.provide(layer)),
    );
    expect(model.price).toEqual(recordedPrice);
    expect(lookups).toHaveLength(before);
  });

  test("a recorded price for another model is refused, not used", async () => {
    const layer = NativeImageModels({ prices, env: { GEMINI_API_KEY: API_KEY } });
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* ImageModels).get("gemini-nano-banana-2.1", {
          ...price,
          model: "other-model",
        });
      }).pipe(Effect.flip, Effect.provide(layer)),
    );
    expect(error).toMatchObject({
      _tag: "Unpriced",
      reason: "the recorded price is for other-model",
    });
  });

  test("with a key, the Gemini model is priced and ready; other models have no adapter", async () => {
    const layer = NativeImageModels({ prices, env: { GEMINI_API_KEY: API_KEY } });
    const [model, missing] = await Effect.runPromise(
      Effect.gen(function* () {
        const models = yield* ImageModels;
        return [
          yield* models.get("gemini-nano-banana-2.1"),
          yield* Effect.flip(models.get("dall-e-9")),
        ] as const;
      }).pipe(Effect.provide(layer)),
    );
    expect(model.price).toEqual(price);
    expect(missing).toMatchObject({ _tag: "ImageModelUnavailable" });
    expect(JSON.stringify(missing)).not.toContain(API_KEY);
  });
});
