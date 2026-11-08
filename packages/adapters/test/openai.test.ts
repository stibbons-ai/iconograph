import { describe, expect, test } from "bun:test";
import { ImageModels, type ImageRequest, toMicros } from "@iconograph/domain";
import { Duration, Effect, type Layer } from "effect";
import { geminiTestPrice } from "./gemini-fixtures";
import { NativeImageModels } from "../src/image-models";
import { OPENAI_IMAGE_EDITS_URL, type OpenAIFetch, openaiImageModel } from "../src/openai";
import { openaiTestPrice as price, recordedOpenAI as recorded } from "./openai-fixtures";
import {
  generateRecorded,
  hangingFetch,
  recordedReplies,
  type Sent,
  scriptedFetch,
} from "./scripted-fetch";

const API_KEY = "sk-test-NOT-REAL-0123456789WXYZ";
const { pricing } = price;

const reply = recordedReplies(recorded);

const reference = (byte: number) => ({
  bytes: new Uint8Array([0xff, 0xd8, 0xff, byte]),
  mimeType: "image/jpeg",
});
const request: ImageRequest = {
  prompt: "A professional headshot of the person in the reference photos.",
  references: Array.from({ length: 16 }, (_, index) => reference(index)),
  size: "1024x1024",
};

const modelWith = (fetch: OpenAIFetch) =>
  openaiImageModel({ model: "gpt-image-2.5-sunburst", apiKey: API_KEY, price, fetch });

const generate = (fetch: OpenAIFetch) => generateRecorded(modelWith(fetch), request);

const classify = async (respond: () => Promise<Response>) =>
  Effect.runPromise(modelWith(scriptedFetch([respond]).fetch).call(request));

describe("OpenAI adapter against recorded responses", () => {
  test("sends one high-quality square image edit with the prompt and 16 references, key in a header only", async () => {
    const { fetch, sent } = scriptedFetch([reply(200, "image-with-usage.json")]);
    await Effect.runPromise(modelWith(fetch).call(request));
    expect(sent).toHaveLength(1);
    const [{ url, init }] = sent as [Sent];
    expect(url).toBe(OPENAI_IMAGE_EDITS_URL);
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(headers.get("content-type")).toBe("application/json");
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      model: "gpt-image-2.5-sunburst",
      prompt: request.prompt,
      images: request.references.map(({ bytes }) => ({
        image_url: `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`,
      })),
      quality: "high",
      size: "1024x1024",
      n: 1,
      output_format: "jpeg",
    });
    expect(String(init.body)).not.toContain(API_KEY);
    expect(modelWith(fetch).capabilities).toEqual({
      maxCharacterReferences: 16,
      sizes: ["1024x1024"],
      qualities: ["high"],
    });
  });

  test("an image with usage yields the image, its usage and the actual cost from usage", async () => {
    const result = await classify(reply(200, "image-with-usage.json"));
    const fixture = JSON.parse(await recorded("image-with-usage.json"));
    expect(result.kind).toBe("image");
    if (result.kind !== "image") return;
    expect(Buffer.from(result.image.bytes).toString("base64")).toBe(fixture.data[0].b64_json);
    expect(result.image.mimeType).toBe("image/jpeg");
    expect(result.usage).toEqual({
      inputTextTokens: 120,
      inputImageTokens: 6300,
      outputImageTokens: 1756,
    });
    // 120 × $5/M + 6300 × $8/M + 1756 × $30/M = $0.0006 + $0.0504 + $0.05268
    expect(result.costMicros).toBe(toMicros(0.0006 + 0.0504 + 0.05268));
  });

  test("an image without usage is kept at an unknown cost, never free", async () => {
    const result = await classify(reply(200, "image-without-usage.json"));
    expect(result).toMatchObject({ kind: "image", usage: null, costMicros: null });
  });

  test("usage whose input split doesn't add up, or without an output count, costs as unknown", async () => {
    const fixture = JSON.parse(await recorded("image-with-usage.json"));
    for (const usage of [
      { ...fixture.usage, input_tokens: 9999 },
      { ...fixture.usage, input_tokens_details: { text_tokens: 120 } },
      { ...fixture.usage, output_tokens: undefined },
    ]) {
      const result = await classify(async () =>
        Response.json({ ...fixture, usage }, { status: 200 }),
      );
      expect(result).toMatchObject({ kind: "image", costMicros: null });
    }
  });

  test("odd usage or output_format (null, wrong types) keeps the image, at an unknown cost", async () => {
    const fixture = JSON.parse(await recorded("image-with-usage.json"));
    for (const odd of [
      { usage: null },
      { usage: "n/a" },
      { usage: { ...fixture.usage, input_tokens_details: null } },
      { usage: { ...fixture.usage, input_tokens: "6420" } },
      { output_format: null, usage: null },
    ]) {
      const result = await classify(async () =>
        Response.json({ ...fixture, ...odd }, { status: 200 }),
      );
      expect(result).toMatchObject({ kind: "image", costMicros: null });
      if (result.kind === "image") expect(result.image.mimeType).toBe("image/jpeg");
    }
    // Null side details that aren't needed for pricing don't matter.
    const priced = await classify(async () =>
      Response.json(
        {
          ...fixture,
          output_format: null,
          usage: { ...fixture.usage, output_tokens_details: null },
        },
        { status: 200 },
      ),
    );
    expect(priced).toMatchObject({
      kind: "image",
      costMicros: toMicros(0.0006 + 0.0504 + 0.05268),
    });
  });

  test("an image whose usage reports no output tokens costs as unknown, never $0", async () => {
    const fixture = JSON.parse(await recorded("image-with-usage.json"));
    for (const usage of [
      { ...fixture.usage, output_tokens: 0 },
      {
        input_tokens: 0,
        input_tokens_details: { text_tokens: 0, image_tokens: 0 },
        output_tokens: 0,
      },
    ]) {
      const result = await classify(async () =>
        Response.json({ ...fixture, usage }, { status: 200 }),
      );
      expect(result).toMatchObject({ kind: "image", costMicros: null });
    }
  });

  test("a moderation block with null or odd details is still Refused with OpenAI's message", async () => {
    const message = "Your request was rejected by the safety system.";
    for (const [moderation_details, suffix] of [
      [null, ""],
      [{ moderation_stage: null, categories: ["sexual"] }, " (categories sexual)"],
      [{ moderation_stage: "output", categories: [{ name: "x" }, 3] }, " (stage output)"],
      ["blocked", ""],
    ] as const) {
      const result = await classify(async () =>
        Response.json(
          {
            error: {
              message,
              type: "image_generation_user_error",
              code: "moderation_blocked",
              param: null,
              moderation_details,
            },
          },
          { status: 400 },
        ),
      );
      expect(result).toEqual({
        kind: "refused",
        reason: `moderation_blocked: ${message}${suffix}`,
        usage: null,
        costMicros: null,
      });
    }
  });

  test("a moderation block is Refused with OpenAI's reason and details, not retried", async () => {
    const { fetch, sent } = scriptedFetch([reply(400, "error-moderation-blocked-400.json")]);
    const { generation, settled } = await generate(fetch);
    expect(sent).toHaveLength(1);
    expect(generation).toEqual({
      kind: "refused",
      reason:
        "moderation_blocked: Your request was rejected by the safety system. If you believe this is an error, contact us at help.openai.com and include the request ID req_REDACTED. (stage input; categories harassment)",
    });
    // Whether a blocked request is billed isn't documented: it counts at its estimate.
    expect(settled).toEqual([expect.objectContaining({ kind: "refused", costMicros: null })]);
  });

  test("a transient error then success: retried once, then the image", async () => {
    const { fetch, sent } = scriptedFetch([
      reply(503, "error-overloaded-503.json"),
      reply(200, "image-with-usage.json"),
    ]);
    const { generation, settled } = await generate(fetch);
    expect(sent).toHaveLength(2);
    expect(generation.kind).toBe("image");
    expect(settled.map(({ kind }) => kind)).toEqual(["transient", "image"]);
  });

  test("a persistent transient error (429, 500, 503) is retried twice, then Failed", async () => {
    const { fetch, sent } = scriptedFetch([
      reply(429, "error-rate-limit-429.json"),
      reply(500, "error-server-500.json"),
      reply(503, "error-overloaded-503.json"),
    ]);
    const { generation, settled } = await generate(fetch);
    expect(sent).toHaveLength(3);
    expect(generation).toMatchObject({ kind: "failed", budgetExhausted: false });
    expect(generation.kind === "failed" && generation.reason).toContain("gave up after 3 attempts");
    expect(settled.map((result) => [result.kind, result.costMicros])).toEqual([
      ["transient", null],
      ["transient", null],
      ["transient", null],
    ]);
    expect(settled[0]).toMatchObject({
      reason: expect.stringContaining("OpenAI HTTP 429 requests rate_limit_exceeded"),
    });
  });

  test("every quota, credit and spend-limit 429 is Failed at once: retrying can't restore credit", async () => {
    const { fetch, sent } = scriptedFetch([reply(429, "error-insufficient-quota-429.json")]);
    const { generation } = await generate(fetch);
    expect(sent).toHaveLength(1);
    expect(generation).toEqual({
      kind: "failed",
      reason:
        "OpenAI HTTP 429 insufficient_quota insufficient_quota: You exceeded your current quota, please check your plan and billing details.",
      budgetExhausted: false,
    });
    for (const code of [
      "insufficient_quota",
      "credit_balance_exhausted",
      "billing_hard_limit_reached",
      "organization_spend_limit_exceeded",
      "project_spend_limit_exceeded",
      "organization_usage_limit_exceeded",
    ]) {
      const result = await classify(async () =>
        Response.json({ error: { message: "limit", type: "requests", code } }, { status: 429 }),
      );
      expect(result).toMatchObject({ kind: "failed", reason: expect.stringContaining(code) });
    }
    // The type alone marks a quota error too; a plain rate limit stays transient.
    expect(
      await classify(async () =>
        Response.json({ error: { message: "q", type: "insufficient_quota" } }, { status: 429 }),
      ),
    ).toMatchObject({ kind: "failed" });
    expect(
      await classify(async () =>
        Response.json(
          { error: { message: "slow", type: "rate_limit_error", code: "slow_down" } },
          { status: 429 },
        ),
      ),
    ).toMatchObject({ kind: "transient" });
  });

  test("a rejected key is Failed at once, with OpenAI's masked echo of the key redacted", async () => {
    const { fetch, sent } = scriptedFetch([reply(401, "error-invalid-key-401.json")]);
    const { generation } = await generate(fetch);
    expect(sent).toHaveLength(1);
    expect(generation).toEqual({
      kind: "failed",
      reason:
        "OpenAI HTTP 401 invalid_request_error invalid_api_key: Incorrect API key provided: [redacted]. You can find your API key at https://platform.openai.com/account/api-keys.",
      budgetExhausted: false,
    });
    // Whatever the key's prefix, e.g. a Gemini key pasted into ICONOGRAPH_OPENAI_API_KEY.
    const result = await classify(async () =>
      Response.json(
        {
          error: {
            message: "Incorrect API key provided: AIzaSyAB****wxyz. You can find your API key at …",
            code: "invalid_api_key",
          },
        },
        { status: 401 },
      ),
    );
    expect(result).toMatchObject({
      kind: "failed",
      reason:
        "OpenAI HTTP 401 invalid_api_key: Incorrect API key provided: [redacted]. You can find your API key at …",
    });
  });

  test("masks with other prefixes, separators and three asterisks are redacted too", async () => {
    const reasonFor = async (message: string) => {
      const result = await classify(async () =>
        Response.json({ error: { message, code: "invalid_api_key" } }, { status: 401 }),
      );
      return result.kind === "failed" ? result.reason : "";
    };
    for (const masked of ["sk-…****abcd", "sk-proj.****abcd", "abc/***wxyz", "key+****wxyz"]) {
      const reason = await reasonFor(`Incorrect API key provided: ${masked}. Check it.`);
      expect(reason).toBe(
        "OpenAI HTTP 401 invalid_api_key: Incorrect API key provided: [redacted]. Check it.",
      );
    }
  });

  test("a huge untrusted error message is truncated and redacted quickly", async () => {
    for (const message of [
      "a".repeat(1_000_000),
      `${"a*".repeat(500_000)}`,
      `sk-x****${".".repeat(1_000_000)}`,
    ]) {
      const started = performance.now();
      const result = await classify(async () =>
        Response.json({ error: { message, code: "server_error" } }, { status: 400 }),
      );
      expect(performance.now() - started).toBeLessThan(1000);
      expect(result.kind).toBe("failed");
      if (result.kind !== "failed") continue;
      expect(result.reason.length).toBeLessThan(2100);
      expect(result.reason).toEndWith("… (truncated)");
    }
    // The text kept after the cut is still masked.
    const masked = await classify(async () =>
      Response.json(
        {
          error: {
            message: `Incorrect key sk-x****abcd ${"a".repeat(1_000_000)}`,
            code: "invalid_api_key",
          },
        },
        { status: 401 },
      ),
    );
    expect(masked).toMatchObject({
      kind: "failed",
      reason: expect.stringContaining("Incorrect key [redacted] "),
    });
    expect(JSON.stringify(masked)).not.toContain("sk-x****");
  });

  test("a masked key straddling the cut is scrubbed whole, not left in part", async () => {
    // The reason is "OpenAI HTTP 400 server_error: " (30 characters) + message: the echo
    // starts 10 characters before the cut at 2000.
    const message = `${"a".repeat(1_959)} sk-proj-****abcd ${"b".repeat(1_000)}`;
    const result = await classify(async () =>
      Response.json({ error: { message, code: "server_error" } }, { status: 400 }),
    );
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.reason).not.toContain("*");
    expect(result.reason).toEndWith("… (truncated)");
    expect(result.reason.length).toBeLessThanOrEqual(2000 + "… (truncated)".length);
  });

  test("a masked key with a longer visible prefix is scrubbed at every offset across the cut", async () => {
    // The reason is "OpenAI HTTP 400 server_error: " (30 characters) + message; the echo
    // starts from 24 characters before the cut at 2000 to 8 characters after it.
    for (let start = 1_976; start <= 2_008; start++) {
      const message = `${"a".repeat(start - 31)} sk-proj-abcdefgh****wxyz ${"b".repeat(1_000)}`;
      const result = await classify(async () =>
        Response.json({ error: { message, code: "server_error" } }, { status: 400 }),
      );
      expect(result.kind).toBe("failed");
      if (result.kind !== "failed") return;
      expect(result.reason).not.toContain("*");
      expect(result.reason).not.toContain("wxyz");
    }
  });

  test("the key is removed before the cut, so the cut can't leave part of it", async () => {
    // The reason is "OpenAI HTTP 400 server_error: " + message; the key's first 15 characters
    // fall before the 2000-character cut, the rest after it.
    const prefix = "OpenAI HTTP 400 server_error: ";
    const padding = "x".repeat(2000 - 15 - prefix.length);
    const result = await classify(async () =>
      Response.json(
        { error: { message: `${padding}${API_KEY} tail`, code: "server_error" } },
        { status: 400 },
      ),
    );
    expect(result.kind).toBe("failed");
    const text = JSON.stringify(result);
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(API_KEY.slice(0, 8));
  });

  test("an odd entry after the first image doesn't discard it", async () => {
    const fixture = JSON.parse(await recorded("image-with-usage.json"));
    const result = await classify(async () =>
      Response.json(
        { ...fixture, data: [...fixture.data, null, { b64_json: 42 }] },
        { status: 200 },
      ),
    );
    expect(result).toMatchObject({
      kind: "image",
      costMicros: toMicros(0.0006 + 0.0504 + 0.05268),
    });
  });

  test("an image reported with fewer than 16 output tokens costs as unknown; 16 is priced", async () => {
    const fixture = JSON.parse(await recorded("image-with-usage.json"));
    for (const output_tokens of [1, 15]) {
      const result = await classify(async () =>
        Response.json({ ...fixture, usage: { ...fixture.usage, output_tokens } }, { status: 200 }),
      );
      expect(result).toMatchObject({ kind: "image", costMicros: null });
    }
    const floor = await classify(async () =>
      Response.json(
        { ...fixture, usage: { ...fixture.usage, output_tokens: 16 } },
        { status: 200 },
      ),
    );
    expect(floor).toMatchObject({
      kind: "image",
      costMicros: toMicros(0.0006 + 0.0504 + 16 * 3e-5),
    });
  });

  test("408 is transient; another 4xx, or an error body that isn't JSON, is Failed", async () => {
    expect(await classify(async () => new Response("timeout", { status: 408 }))).toMatchObject({
      kind: "transient",
      reason: "OpenAI HTTP 408: no error message",
    });
    expect(
      await classify(async () =>
        Response.json(
          { error: { message: "Invalid size", type: "invalid_request_error", code: null } },
          { status: 400 },
        ),
      ),
    ).toEqual({
      kind: "failed",
      reason: "OpenAI HTTP 400 invalid_request_error: Invalid size",
      usage: null,
      costMicros: null,
    });
  });

  test("a malformed 200 is Failed with a clear reason and an unknown cost", async () => {
    const cases: [string, string][] = [
      ["<html>bad gateway</html>", "OpenAI returned a malformed images response"],
      ['{"data":"nope"}', "OpenAI returned a malformed images response"],
      ['{"data":[]}', "OpenAI returned no image"],
      [
        '{"data":[{"url":"https://example.com/x.png"}]}',
        "OpenAI returned an image without b64_json data",
      ],
      ['{"data":[{"b64_json":""}]}', "OpenAI returned an empty image"],
    ];
    for (const [body, reason] of cases) {
      expect(await classify(async () => new Response(body, { status: 200 }))).toEqual({
        kind: "failed",
        reason,
        usage: null,
        costMicros: null,
      });
    }
  });

  test("a network failure is transient at an unknown cost; a quoted key is redacted", async () => {
    const result = await classify(async () => {
      throw new TypeError(`Header 'authorization' has invalid value: 'Bearer ${API_KEY}'`);
    });
    expect(result).toMatchObject({
      kind: "transient",
      reason: expect.stringContaining("[redacted]"),
      costMicros: null,
    });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
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

  test("the per-call timeout aborts a request that never answers, as a transient error", async () => {
    const { fetch, state } = hangingFetch();
    // A real 10 ms timer: the timeout is the platform's AbortSignal.timeout, which fake timers don't drive.
    const model = openaiImageModel({
      model: price.model,
      apiKey: API_KEY,
      price,
      fetch,
      timeoutMs: 10,
    });
    const result = await Effect.runPromise(model.call(request));
    expect(state.aborted).toBe(true);
    expect(result).toMatchObject({ kind: "transient", costMicros: null });
  });

  test("the estimate prices a high-quality square image plus each reference and the prompt", () => {
    const model = modelWith(scriptedFetch([]).fetch);
    const none = model.estimate({ ...request, references: [] });
    const all = model.estimate(request);
    const promptTokens = Math.ceil(request.prompt.length / 3);
    expect(none.micros).toBe(
      toMicros(promptTokens * pricing.inputPerToken + 1756 * pricing.outputPerImageToken),
    );
    expect(all.usage).toMatchObject({ inputImageTokens: 16 * 6144, outputImageTokens: 1756 });
    expect(all.micros).toBe(
      toMicros(
        promptTokens * pricing.inputPerToken +
          16 * 6144 * pricing.inputPerImageToken +
          1756 * pricing.outputPerImageToken,
      ),
    );
  });
});

describe("OpenAI Image Model selection", () => {
  const lookups: string[] = [];
  const prices = {
    lookup: (model: string) => Effect.sync(() => (lookups.push(model), { ...price, model })),
  };
  const get = (layer: Layer.Layer<ImageModels>, model: string) =>
    Effect.gen(function* () {
      return yield* (yield* ImageModels).get(model);
    }).pipe(Effect.provide(layer));

  test("a missing or malformed ICONOGRAPH_OPENAI_API_KEY fails before any call or price lookup", async () => {
    for (const [env, message] of [
      [{}, "ICONOGRAPH_OPENAI_API_KEY is not set"],
      [
        { ICONOGRAPH_GEMINI_API_KEY: "AIzaFAKEFAKEFAKEFAKEFAKE" },
        "ICONOGRAPH_OPENAI_API_KEY is not set",
      ],
      // OpenAI's standard variable is never read: coding agents would bill the API with it.
      [{ OPENAI_API_KEY: "sk-FAKEFAKEFAKEFAKEFAKE" }, "ICONOGRAPH_OPENAI_API_KEY is not set"],
      [
        { ICONOGRAPH_OPENAI_API_KEY: "sk-FAKE" },
        "ICONOGRAPH_OPENAI_API_KEY is shorter than 20 characters",
      ],
      [{ ICONOGRAPH_OPENAI_API_KEY: "sk-FAKE FAKEFAKEFAKEFAKE" }, "contains spaces"],
    ] as const) {
      const { fetch, sent } = scriptedFetch([]);
      const layer = NativeImageModels({ prices, env, openaiFetch: fetch });
      const error = await Effect.runPromise(Effect.flip(get(layer, "gpt-image-2.5-sunburst")));
      expect(error).toMatchObject({ _tag: "ImageModelUnavailable" });
      expect(error.message).toContain(message);
      expect(JSON.stringify(error)).not.toContain("FAKE");
      expect(sent).toHaveLength(0);
    }
    expect(lookups).toHaveLength(0);
  });

  test("with a key, sunburst and flare are priced and each sends its own model id", async () => {
    for (const id of ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare"]) {
      const { fetch, sent } = scriptedFetch([reply(200, "image-with-usage.json")]);
      const layer = NativeImageModels({
        prices,
        env: { ICONOGRAPH_OPENAI_API_KEY: API_KEY },
        openaiFetch: fetch,
      });
      const model = await Effect.runPromise(get(layer, id));
      expect(model.model).toBe(id);
      expect(model.price).toEqual({ ...price, model: id });
      await Effect.runPromise(model.call(request));
      expect(JSON.parse(String(sent[0]!.init.body)).model).toBe(id);
    }
    expect(lookups).toEqual(["gpt-image-2.5-sunburst", "gpt-image-2.5-flare"]);
  });

  test("an OpenAI model priced in another mode is Unpriced, not called", async () => {
    const layer = NativeImageModels({
      prices: { lookup: (model) => Effect.succeed({ ...geminiTestPrice, model }) },
      env: { ICONOGRAPH_OPENAI_API_KEY: API_KEY },
    });
    const error = await Effect.runPromise(Effect.flip(get(layer, "gpt-image-2.5-sunburst")));
    expect(error).toMatchObject({
      _tag: "Unpriced",
      reason: "priced as GeminiImage, not as an OpenAI image model",
    });
  });
});
