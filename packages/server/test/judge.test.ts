import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_TARGET_LOOK,
  type EncodedImage,
  type Effort,
  MAX_OUTPUT_TOKENS,
  CURRENT_RUBRIC,
  judgeImageTokens,
  judgeInstructions,
  judgeMessage,
  llmVendor,
  JudgeVerdict,
  type Judge,
  type JudgeCallResult,
  type JudgeRequest,
  Judges,
  type PriceQuote,
} from "@iconograph/domain";
import type { MastraModelConfig } from "@mastra/core/llm";
import { MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock";
import { Effect, type Layer } from "effect";
import { toMastraSchema } from "@iconograph/adapters";
import { withEnvironment } from "../../adapters/test/git-environment";
import { MastraJudges } from "../src/judge";
import type { LlmAgentsOptions } from "../src/llm";
import { faceFixture } from "./support/fake-image-models";
import { FAKE_VERDICT, judgesOnFakeAnthropic } from "./support/fake-judges";
import { fakeVendorServer, vendorAnswer, vendorError } from "./support/fake-vendors";

const KEY = "SENTINEL-JUDGE-KEY-0123456789";

const sonnetPrice: PriceQuote = {
  model: "claude-sonnet-5-5",
  pricing: { _tag: "Llm", inputPerToken: 2e-6, outputPerToken: 1e-5 },
  source: { _tag: "override", asOf: "2026-11-01T00:00:00.000Z", ageSeconds: 0 },
};

type CallOptions = MastraLanguageModelV2Mock["doGenerateCalls"][number];

/** What the mock model answers: text, finish reason and usage, or a thrown error. */
interface MockAnswer {
  readonly text: string;
  readonly finishReason?: "stop" | "content-filter" | "length";
  readonly usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}

const answer =
  (text: string, options: Omit<MockAnswer, "text"> = {}) =>
  async (): Promise<MockAnswer> => ({ text, ...options });

/** Every vendor's key. */
const allKeys = {
  ANTHROPIC_API_KEY: KEY,
  OPENAI_API_KEY: KEY,
  GOOGLE_GENERATIVE_AI_API_KEY: KEY,
};

/** Gets a Judge from Judges built by `layer`. */
const getJudge = (
  layer: Layer.Layer<Judges>,
  model = "anthropic/claude-sonnet-5-5",
  effort: Effort = "low",
  recorded?: PriceQuote,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* Judges).get({ model, effort }, recorded);
    }).pipe(Effect.provide(layer)),
  );

/** The real provider-built Judges, their network replaced by `network`. */
const providerJudges = (network: NonNullable<LlmAgentsOptions["fetch"]>, timeoutMs?: number) =>
  MastraJudges({
    env: allKeys,
    ...(timeoutMs !== undefined && { timeoutMs }),
    prices: { lookup: (priced) => Effect.succeed({ ...sonnetPrice, model: priced }) },
    fetch: network,
  });

/** Judges whose language model is replaced by a mock model answering with `respond`. */
function judges(
  respond: (options: CallOptions) => Promise<MockAnswer>,
  env: Record<string, string | undefined> = allKeys,
  timeoutMs?: number,
) {
  const calls: CallOptions[] = [];
  const keys: string[] = [];
  const lookups: string[] = [];
  const layer = MastraJudges({
    env,
    ...(timeoutMs !== undefined && { timeoutMs }),
    prices: {
      lookup: (model) =>
        Effect.sync(() => {
          lookups.push(model);
          return { ...sonnetPrice, model };
        }),
    },
    languageModel: (_, apiKey) => {
      keys.push(apiKey);
      const mock = new MastraLanguageModelV2Mock({
        doGenerate: async (options) => {
          calls.push(options);
          const { text, finishReason = "stop", usage } = await respond(options);
          return {
            content: text ? [{ type: "text", text }] : [],
            finishReason,
            usage: usage ?? { inputTokens: 9_000, outputTokens: 300, totalTokens: 9_300 },
            warnings: [],
          };
        },
      });
      // The mock's declared `response` type differs from Mastra's under exactOptionalPropertyTypes.
      return mock as unknown as MastraModelConfig;
    },
  });
  const get = (model?: string, effort?: Effort, recorded?: PriceQuote) =>
    getJudge(layer, model, effort, recorded);
  return { get, calls, keys, lookups };
}

const photo = async (name: string): Promise<EncodedImage> => ({
  bytes: await Bun.file(faceFixture(name)).bytes(),
  mimeType: "image/jpeg",
});

async function judgeRequest(): Promise<JudgeRequest> {
  return {
    references: await Promise.all(
      ["biden-2022.jpg", "biden-2021.jpg", "biden-2013.jpg"].map(photo),
    ),
    candidate: await photo("obama-2012.jpg"),
    targetLook: DEFAULT_TARGET_LOOK,
  };
}

const call = async (judge: Judge) => Effect.runPromise(judge.call(await judgeRequest()));
const base64 = (image: EncodedImage) => Buffer.from(image.bytes).toString("base64");

describe("Mastra Judge", () => {
  test("sends the Rubric, then 3 Reference Photos before the Candidate, and decodes the verdict with its cost", async () => {
    const fake = judges(answer(JSON.stringify(FAKE_VERDICT)));
    const judge = await fake.get();
    const result = await call(judge);
    // $2/M input and $10/M output: 9,000 × 2e-6 + 300 × 1e-5 = $0.021.
    expect(result).toEqual({
      kind: "judged",
      verdict: FAKE_VERDICT,
      usage: { inputTokens: 9_000, outputTokens: 300, totalTokens: 9_300 },
      costMicros: 21_000,
    });
    expect(fake.keys).toEqual([KEY]);
    expect(fake.lookups).toEqual(["claude-sonnet-5-5"]);

    const [sent] = fake.calls;
    const [system, user] = sent!.prompt;
    expect(system).toMatchObject({
      role: "system",
      content: expect.stringContaining("Rubric rubric-v1"),
    });
    if (user?.role !== "user") throw new Error("expected a user message");
    const request = await judgeRequest();
    const parts = user.content.map((part) =>
      part.type === "text" ? part.text : { mediaType: part.mediaType, data: part.data },
    );
    expect(parts.slice(0, 9)).toEqual([
      "Reference Photo 1 of 3:",
      { mediaType: "image/jpeg", data: base64(request.references[0]!) },
      "Reference Photo 2 of 3:",
      { mediaType: "image/jpeg", data: base64(request.references[1]!) },
      "Reference Photo 3 of 3:",
      { mediaType: "image/jpeg", data: base64(request.references[2]!) },
      "Candidate:",
      { mediaType: "image/jpeg", data: base64(request.candidate) },
      expect.stringContaining(`Pose: ${JSON.stringify(DEFAULT_TARGET_LOOK.pose)}`),
    ]);
    // Structured output against the verdict's JSON Schema: integer levels 1–5, capped output.
    expect(sent!.responseFormat).toMatchObject({
      type: "json",
      schema: {
        properties: {
          levels: {
            properties: { resemblance: { type: "integer", minimum: 1, maximum: 5 } },
          },
        },
      },
    });
    expect(sent!.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS.low);
  });

  test.each([
    [
      "anthropic/claude-sonnet-5-5",
      "low",
      "ANTHROPIC_BASE_URL",
      "https://api.anthropic.com/v1/messages",
      ["x-api-key", KEY],
      { model: "claude-sonnet-5-5", output_config: { effort: "low" } },
    ],
    [
      "openai/gpt-5.5",
      "medium",
      "OPENAI_BASE_URL",
      "https://api.openai.com/v1/responses",
      ["authorization", `Bearer ${KEY}`],
      { model: "gpt-5.5", reasoning: { effort: "medium" } },
    ],
    [
      "google/gemini-3.1-pro-preview",
      "high",
      "GOOGLE_BASE_URL",
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent",
      ["x-goog-api-key", KEY],
      // The model is in the URL. @ai-sdk/google reads no base-URL variable (only Mastra's router
      // read GOOGLE_BASE_URL), so this case guards the endpoint rather than an override.
      { generationConfig: { thinkingConfig: { thinkingLevel: "high" } } },
    ],
  ] as const)(
    "%s at %s effort sends its key, photos and reasoning effort only to its vendor's API, whatever %s says",
    async (model, effort, variable, url, [header, auth], reasoning) => {
      // The fetch seam is the provider's whole network: every request it sends is seen here.
      const sent: { url: string; init: BunFetchRequestInit }[] = [];
      const layer = providerJudges(async (input, init) => {
        sent.push({ url: String(input), init });
        return vendorAnswer(llmVendor(model)!, JSON.stringify(FAKE_VERDICT));
      });
      const request = await judgeRequest();
      const result = await withEnvironment({ [variable]: "https://proxy.example/v1" }, async () =>
        Effect.runPromise((await getJudge(layer, model, effort)).call(request)),
      );
      // $2/M input and $10/M output: 9,000 × 2e-6 + 300 × 1e-5 = $0.021.
      expect(result).toMatchObject({ kind: "judged", verdict: FAKE_VERDICT, costMicros: 21_000 });
      expect(sent.map((request) => request.url)).toEqual([url]);
      const { init } = sent[0]!;
      expect(new Headers(init.headers).get(header)).toBe(auth);
      // Bun's fetch idle timeout is off: the per-effort abort is the only deadline.
      expect(init.timeout).toBe(false);
      expect(JSON.parse(String(init.body))).toMatchObject(reasoning);
      expect(String(init.body)).toContain(base64(request.references[0]!));
      expect(String(init.body)).toContain(base64(request.candidate));
    },
  );

  test.each(["anthropic/claude-sonnet-5-5", "openai/gpt-5.5", "google/gemini-3.1-pro-preview"])(
    "%s: a call past the timeout aborts the vendor request itself",
    async (model) => {
      const signals: (AbortSignal | undefined)[] = [];
      const layer = providerJudges((_, init) => {
        // Never answers; fails only when its signal aborts.
        const { promise, reject } = Promise.withResolvers<Response>();
        signals.push(init.signal ?? undefined);
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        return promise;
      }, 150);
      expect(await call(await getJudge(layer, model))).toEqual({
        kind: "transient",
        reason: "Judge request timed out after 0.15 s",
        costMicros: null,
      });
      // With the idle timeout off, this signal is all that closes the connection.
      expect(signals.map((signal) => signal?.aborted)).toEqual([true]);
    },
  );

  test.each(["anthropic/claude-sonnet-5-5", "openai/gpt-5.5", "google/gemini-3.1-pro-preview"])(
    "%s: an answer cut off at the output cap fails the judging at its cost",
    async (model) => {
      const layer = providerJudges(async () =>
        vendorAnswer(llmVendor(model)!, '{"levels": {"resemblance": 4', true),
      );
      expect(await call(await getJudge(layer, model))).toMatchObject({
        kind: "failed",
        costMicros: 21_000,
        reason: `The Judge hit its ${MAX_OUTPUT_TOKENS.low}-token output cap, reasoning included, before finishing its answer`,
      });
    },
  );

  test.each([
    [
      "a 429",
      async () => vendorError(429, "rate_limit_error", `slow down, ${KEY}`),
      { kind: "transient", costMicros: 0, reason: expect.stringMatching(/HTTP 429.*\[redacted\]/) },
    ],
    [
      "a refused connection",
      // Port 1 on loopback: nothing listens, so Bun's fetch fails to connect.
      (_: unknown, init: BunFetchRequestInit) => fetch("http://127.0.0.1:1/", init),
      { kind: "transient", costMicros: 0 },
    ],
    [
      "an idle connection cut by a TimeoutError the deadline didn't raise",
      async () => {
        throw new DOMException(`The operation timed out (${KEY}).`, "TimeoutError");
      },
      {
        kind: "transient",
        costMicros: null,
        reason:
          "Judge connection idle timeout, not the Judge's 180 s deadline: The operation timed out ([redacted]).",
      },
    ],
  ] as const)(
    "through the Anthropic provider, %s is classified, the key redacted",
    async (_, network, expected) => {
      const result = await call(await getJudge(providerJudges(network)));
      expect(result).toMatchObject(expected);
      expect(JSON.stringify(result)).not.toContain(KEY);
    },
  );

  test("the fake Anthropic Judge refuses a request to any other vendor before it is sent", async () => {
    const vendor = fakeVendorServer(() => vendorAnswer("anthropic", JSON.stringify(FAKE_VERDICT)));
    try {
      const result = await withEnvironment({ OPENAI_API_KEY: KEY }, async () =>
        call(await getJudge(judgesOnFakeAnthropic(vendor.origin), "openai/gpt-5.5")),
      );
      // Failed at $0 and not retried, so no test can reach a live vendor by accident.
      expect(result).toMatchObject({ kind: "failed", costMicros: 0 });
      expect(vendor.requests).toEqual([]);
    } finally {
      await vendor.stop();
    }
  });

  test("a call outlasting Bun's fetch idle timeout completes, where a plain fetch is cut off", async () => {
    const script = fileURLToPath(new URL("./support/slow-vendor-judge.ts", import.meta.url));
    // The script runs with a 1 s idle timeout. The fake Anthropic API never answers its plain
    // fetch, and answers the Judge only after Bun has cut that fetch off. The two requests must
    // arrive within a second of each other: Bun's idle sweep is coarse, so a Judge request
    // arriving seconds later could be answered before its own cut. A real wait: the idle timer
    // is Bun's native one, which fake timers can't drive (it fires about 8 s in).
    const { promise: plainCutOff, resolve } = Promise.withResolvers<void>();
    const arrivedAt: Record<string, number> = {};
    const vendor = fakeVendorServer(async (request) => {
      const { pathname } = new URL(request.url);
      arrivedAt[pathname] = performance.now();
      if (pathname === "/") {
        request.signal.addEventListener("abort", () => resolve());
        return new Promise<Response>(() => {});
      }
      await plainCutOff;
      return vendorAnswer("anthropic", JSON.stringify(FAKE_VERDICT));
    });
    const child = Bun.spawn([process.execPath, script, vendor.origin], {
      env: { ...Bun.env, ANTHROPIC_API_KEY: KEY, BUN_CONFIG_HTTP_IDLE_TIMEOUT: "1" },
      stderr: "inherit",
    });
    try {
      const [stdout, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        child.exited,
      ]);
      expect({ stdout, exitCode }).toEqual({
        stdout: JSON.stringify({ judge: "judged", plainFetch: "TimeoutError" }),
        exitCode: 0,
      });
      expect(arrivedAt["/v1/messages"]! - arrivedAt["/"]!).toBeLessThan(1_000);
      expect(vendor.requests.map(({ path }) => path).sort()).toEqual(["/", "/v1/messages"]);
    } finally {
      child.kill();
      await vendor.stop();
    }
  }, 30_000);

  test("an answer outside the verdict schema fails the judging, says where, and still costs what was billed", async () => {
    const outOfRange = { ...FAKE_VERDICT, levels: { ...FAKE_VERDICT.levels, realism: 7 } };
    const result = await call(await judges(answer(JSON.stringify(outOfRange))).get());
    expect(result).toMatchObject({
      kind: "failed",
      costMicros: 21_000,
      reason: expect.stringMatching(/verdict schema: .*levels.*realism/),
    });
    expect(await call(await judges(answer("not json")).get())).toMatchObject({
      kind: "failed",
      reason: expect.stringContaining("verdict schema"),
    });
  });

  test.each([
    ["medium", 8_192],
    ["high", 16_384],
  ] as const)("an answer cut off at the %s-effort output cap says so", async (effort, cap) => {
    const fake = judges(answer('{"levels": {"resemblance": 4', { finishReason: "length" }));
    const result = await call(await fake.get("anthropic/claude-sonnet-5-5", effort));
    expect(fake.calls[0]!.maxOutputTokens).toBe(cap);
    expect(result).toMatchObject({
      kind: "failed",
      costMicros: 21_000,
      reason: `The Judge hit its ${cap}-token output cap, reasoning included, before finishing its answer`,
    });
  });

  test("an empty answer says so", async () => {
    expect(await call(await judges(answer("")).get())).toMatchObject({
      kind: "failed",
      reason: "The Judge gave an empty answer",
    });
  });

  test("a call that runs past the timeout is aborted, transient at unknown cost", async () => {
    const hang = (options: CallOptions) =>
      new Promise<MockAnswer>((_, reject) =>
        options.abortSignal?.addEventListener("abort", () => reject(options.abortSignal?.reason)),
      );
    const result = await call(await judges(hang, allKeys, 50).get());
    expect(result).toEqual({
      kind: "transient",
      reason: "Judge request timed out after 0.05 s",
      costMicros: null,
    });
  });

  test("a recorded price is used without a lookup; one for another model is Unpriced", async () => {
    const fake = judges(answer(JSON.stringify(FAKE_VERDICT)));
    const tenfold = {
      ...sonnetPrice,
      pricing: { _tag: "Llm", inputPerToken: 2e-5, outputPerToken: 1e-4 },
    } as const;
    const result = await call(await fake.get("anthropic/claude-sonnet-5-5", "low", tenfold));
    expect(fake.lookups).toEqual([]);
    expect(result).toMatchObject({ kind: "judged", costMicros: 210_000 });
    await expect(
      fake.get("anthropic/claude-sonnet-5-5", "low", { ...sonnetPrice, model: "gpt-5.5" }),
    ).rejects.toThrow("the recorded price is for gpt-5.5");
  });

  test("a content-filtered answer is a refusal", async () => {
    const result = await call(await judges(answer("", { finishReason: "content-filter" })).get());
    expect(result).toMatchObject({ kind: "refused", costMicros: 21_000 });
  });

  test.each([
    ["status 529", { statusCode: 529 }, "transient", 0],
    ["status 429", { statusCode: 429 }, "transient", 0],
    ["status 400", { statusCode: 400 }, "failed", 0],
    ["status 503 on its cause", { cause: { statusCode: 503 } }, "transient", 0],
    ["status 401 on its cause", { cause: { statusCode: 401 } }, "non-recoverable", 0],
    ["status 403", { statusCode: 403 }, "non-recoverable", 0],
    ["status 404", { statusCode: 404 }, "non-recoverable", 0],
    ["no status", {}, "transient", null],
    [
      "status 200 whose body broke off (ECONNRESET)",
      {
        statusCode: 200,
        cause: Object.assign(new TypeError("socket closed"), { code: "ECONNRESET" }),
      },
      "transient",
      null,
    ],
  ] as const)(
    "an error with %s is %s at cost %s, made once, and never quotes the key",
    async (_, fields, kind, costMicros) => {
      const fake = judges(async () => {
        throw Object.assign(new Error(`upstream said no to ${KEY}`), {
          name: "AI_APICallError",
          ...fields,
        });
      });
      const result: JudgeCallResult = await call(await fake.get());
      expect(result).toMatchObject({ kind, costMicros });
      expect(fake.calls).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain(KEY);
      expect(JSON.stringify(result)).toContain("[redacted]");
    },
  );

  test.each([
    ["ENOTFOUND", 0],
    ["EAI_AGAIN", 0],
    ["ConnectionRefused", 0],
    ["ERR_TLS_CERT_ALTNAME_INVALID", null],
  ] as const)(
    "a network error coded %s is transient (retried) at cost %s",
    async (code, costMicros) => {
      const fake = judges(async () => {
        throw Object.assign(new TypeError(`fetch failed (${KEY})`), { code });
      });
      const result = await call(await fake.get());
      expect(result).toMatchObject({ kind: "transient", costMicros });
      expect(JSON.stringify(result)).not.toContain(KEY);
    },
  );

  test("a model with no documented image-token bound can't be a Judge", async () => {
    await expect(judges(answer("{}")).get("openai/gpt-4o-mini")).rejects.toThrow(
      "no documented upper bound on its image tokens",
    );
  });

  test.each([
    ["an uncoded TypeError", new TypeError(`cannot read properties of undefined (${KEY})`), null],
    ["an uncoded SyntaxError", new SyntaxError(`unexpected token (${KEY})`), null],
    ["an uncoded RangeError", new RangeError(`invalid array length (${KEY})`), null],
    [
      "Bun's ERR_MISSING_ARGS",
      Object.assign(new TypeError(`missing argument ${KEY}`), { code: "ERR_MISSING_ARGS" }),
      null,
    ],
    [
      "Bun's ERR_INVALID_URL (thrown before sending)",
      Object.assign(new TypeError(`bad URL ${KEY}`), { code: "ERR_INVALID_URL" }),
      0,
    ],
    [
      "Bun's ERR_INVALID_ARG_TYPE (stream or buffer misuse, maybe after a billed response)",
      Object.assign(new TypeError(`bad argument ${KEY}`), { code: "ERR_INVALID_ARG_TYPE" }),
      null,
    ],
    [
      "Bun's ERR_INVALID_STATE (maybe after a billed response)",
      Object.assign(new TypeError(`stream locked ${KEY}`), { code: "ERR_INVALID_STATE" }),
      null,
    ],
  ] as const)(
    "%s is a local error: failed and not retried, at cost %s",
    async (_, thrown, costMicros) => {
      const fake = judges(async () => {
        throw thrown;
      });
      const result = await call(await fake.get());
      expect(result).toMatchObject({ kind: "failed", costMicros });
      expect(fake.calls).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain(KEY);
    },
  );

  test("a code merely containing ARG (…_LARGE_TARGET) is no argument error: it stays a network error", async () => {
    const result = await call(
      await judges(async () => {
        throw Object.assign(new TypeError("too large"), { code: "ERR_BUFFER_TOO_LARGE_TARGET" });
      }).get(),
    );
    expect(result).toMatchObject({ kind: "transient", costMicros: null });
  });

  test("ECONNREFUSED three causes deep is a network error that sent nothing", async () => {
    const refused = Object.assign(new Error("connect"), { code: "ECONNREFUSED" });
    const result = await call(
      await judges(async () => {
        throw new TypeError("fetch failed", {
          cause: new Error("socket", { cause: new Error("connection", { cause: refused }) }),
        });
      }).get(),
    );
    expect(result).toMatchObject({ kind: "transient", costMicros: 0 });
  });

  test("a network code on a TypeError's cause makes it a network error", async () => {
    const result = await call(
      await judges(async () => {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("getaddrinfo"), { code: "ENOTFOUND" }),
        });
      }).get(),
    );
    expect(result).toMatchObject({ kind: "transient", costMicros: 0 });
  });

  test("an HTTP error with an empty body says so", async () => {
    const result = await call(
      await judges(async () => {
        throw Object.assign(new Error(""), { name: "AI_APICallError", statusCode: 500 });
      }).get(),
    );
    expect(result).toMatchObject({ kind: "transient", reason: "Judge HTTP 500: (empty body)" });
  });

  test("the estimate counts the instructions, the schema as sent and the message", async () => {
    const judge = await judges(answer("{}")).get();
    const targetLook = DEFAULT_TARGET_LOOK;
    const { usage } = judge.estimate({ references: 3, targetLook });
    const image: EncodedImage = { bytes: new Uint8Array(0), mimeType: "image/jpeg" };
    const sentText =
      judgeInstructions(CURRENT_RUBRIC) +
      JSON.stringify(
        toMastraSchema(JudgeVerdict)["~standard"].jsonSchema.input({ target: "draft-07" }),
      ) +
      judgeMessage({ references: [image, image, image], candidate: image, targetLook })
        .map((part) => (part.kind === "text" ? part.text : ""))
        .join("");
    expect(usage.inputTokens).toBeGreaterThanOrEqual(
      Math.ceil(sentText.length / 2.5) +
        4 * judgeImageTokens("anthropic/claude-sonnet-5-5")! +
        1_000,
    );
  });

  test("a missing key, an unknown vendor or a non-LLM price fail before any call or lookup", async () => {
    const noKey = judges(answer("{}"), {});
    await expect(noKey.get()).rejects.toThrow("ANTHROPIC_API_KEY is not set");
    expect(noKey.lookups).toEqual([]);
    await expect(
      judges(answer("{}"), { GOOGLE_API_KEY: KEY }).get("google/gemini-3.1-pro-preview"),
    ).resolves.toBeDefined();
    await expect(judges(answer("{}")).get("mistral/large")).rejects.toThrow(
      'No Judge for "mistral/large"',
    );
    const wrongPrice = MastraJudges({
      env: { ANTHROPIC_API_KEY: KEY },
      prices: {
        lookup: () =>
          Effect.succeed({
            ...sonnetPrice,
            pricing: {
              _tag: "OpenAIImage",
              inputPerToken: 0,
              inputPerImageToken: 0,
              outputPerImageToken: 0,
            },
          }),
      },
    });
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          return yield* (yield* Judges).get({
            model: "anthropic/claude-sonnet-5-5",
            effort: "low",
          });
        }).pipe(Effect.provide(wrongPrice)),
      ),
    );
    expect(error).toMatchObject({ _tag: "Unpriced" });
    expect(JSON.stringify(error)).not.toContain(KEY);
  });
});
