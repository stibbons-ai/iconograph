import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TARGET_LOOK,
  type EncodedImage,
  JUDGE_MAX_OUTPUT_TOKENS,
  CURRENT_RUBRIC,
  judgeImageTokens,
  judgeInstructions,
  judgeMessage,
  judgeTimeoutMs,
  JudgeVerdict,
  type Judge,
  type JudgeCallResult,
  type JudgeEffort,
  type JudgeRequest,
  Judges,
  type PriceQuote,
} from "@iconograph/domain";
import type { MastraModelConfig } from "@mastra/core/llm";
import { MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock";
import { Effect } from "effect";
import { toMastraSchema } from "@iconograph/adapters";
import { MastraJudges } from "../src/judge";
import { faceFixture } from "./support/fake-image-models";
import { FAKE_VERDICT } from "./support/fake-judges";

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

/** Every vendor's key, and Bun's idle timeout as `bun run run` sets it. */
const allKeys = {
  ANTHROPIC_API_KEY: KEY,
  OPENAI_API_KEY: KEY,
  GOOGLE_GENERATIVE_AI_API_KEY: KEY,
  BUN_CONFIG_HTTP_IDLE_TIMEOUT: "900",
};

/** Judges whose model router is replaced by a mock model answering with `respond`. */
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
  const get = (
    model = "anthropic/claude-sonnet-5-5",
    effort: JudgeEffort = "low",
    recorded?: PriceQuote,
  ) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Judges).get({ model, effort }, recorded);
      }).pipe(Effect.provide(layer)),
    );
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
    expect(sent!.maxOutputTokens).toBe(JUDGE_MAX_OUTPUT_TOKENS.low);
  });

  test.each([
    ["anthropic/claude-sonnet-5-5", "low", { anthropic: { effort: "low" } }],
    ["openai/gpt-5.5", "medium", { openai: { reasoningEffort: "medium" } }],
    [
      "google/gemini-3.1-pro-preview",
      "high",
      { google: { thinkingConfig: { thinkingLevel: "high" } } },
    ],
  ] as const)(
    "%s at %s effort sets the vendor's reasoning parameter",
    async (model, effort, expected) => {
      const fake = judges(answer(JSON.stringify(FAKE_VERDICT)));
      await call(await fake.get(model, effort));
      expect(fake.calls[0]!.providerOptions).toEqual(expected);
    },
  );

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
    ["status 401 on its cause", { cause: { statusCode: 401 } }, "failed", 0],
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

  test("a Judge whose calls could outlast Bun's fetch idle timeout is refused, naming the fix", async () => {
    const { BUN_CONFIG_HTTP_IDLE_TIMEOUT: _, ...bunDefault } = allKeys;
    // Bun's default idle timeout is 300 s: more than low effort's 180 s, not more than medium's
    // 300 s or high's 600 s.
    await expect(judges(answer("{}"), bunDefault).get(undefined, "low")).resolves.toBeDefined();
    for (const effort of ["medium", "high"] as const) {
      await expect(judges(answer("{}"), bunDefault).get(undefined, effort)).rejects.toThrow(
        `before its ${judgeTimeoutMs(effort) / 1000} s timeout`,
      );
    }
    await expect(judges(answer("{}")).get(undefined, "high")).resolves.toBeDefined();
    // Bun takes whole seconds only: 900.5 leaves its 300 s default.
    await expect(
      judges(answer("{}"), { ...bunDefault, BUN_CONFIG_HTTP_IDLE_TIMEOUT: "900.5" }).get(
        undefined,
        "high",
      ),
    ).rejects.toThrow("OS environment");
  });

  test.each([
    ["anthropic/claude-sonnet-5-5", "ANTHROPIC_BASE_URL"],
    ["openai/gpt-5.5", "OPENAI_BASE_URL"],
    ["google/gemini-3.1-pro-preview", "GOOGLE_BASE_URL"],
  ] as const)(
    "%s is refused while %s is set, even empty: the key and photos would go there",
    async (model, variable) => {
      for (const value of ["https://user:secret-token@proxy.example:8443/v1", ""]) {
        const fake = judges(answer("{}"), { ...allKeys, [variable]: value });
        const error = await fake.get(model).catch((failure: unknown) => failure as Error);
        expect(String(error)).toContain(`${variable} is set`);
        expect(String(error)).not.toContain("secret-token");
        expect(fake.lookups).toEqual([]);
      }
      // Another vendor's variable doesn't block this Judge.
      const other = variable === "ANTHROPIC_BASE_URL" ? "OPENAI_BASE_URL" : "ANTHROPIC_BASE_URL";
      await expect(
        judges(answer("{}"), { ...allKeys, [other]: "https://elsewhere" }).get(model),
      ).resolves.toBeDefined();
    },
  );

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
