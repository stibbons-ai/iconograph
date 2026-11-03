import {
  CURRENT_RUBRIC,
  estimateJudgeCall,
  judgeImageTokens,
  judgeInstructions,
  judgeMessage,
  type JudgeRequest,
  Judges,
  JudgeUnavailable,
  JudgeVerdict,
} from "@iconograph/domain";
import { Effect, Layer } from "effect";
import { llmCaller, type LlmAgentsOptions, llmModel, llmPrice } from "./llm";

const rubric = CURRENT_RUBRIC;
const instructions = judgeInstructions(rubric);

/**
 * The Judges behind Mastra agents on their vendor's AI SDK provider, selected
 * by `vendor/model` id. Getting one checks the vendor, its API key and its LLM
 * price first, so a Run fails before any billable call. Each call is one
 * structured-output generation (`llmCaller`) whose answer must decode against
 * the verdict schema. The schema's objects are open (`additionalProperties:
 * true`), so Mastra sends OpenAI a non-strict schema; Mastra's Anthropic
 * provider strips unsupported bounds and closes objects regardless; the local
 * decode enforces the whole schema either way. Only the Rubric, the Reference
 * Photos, the Candidate and the Target Look are sent, to the vendor's own API
 * endpoint; nothing is stored by Mastra.
 */
export const MastraJudges = (options: LlmAgentsOptions) =>
  Layer.succeed(Judges)({
    checkCredentials: (model) =>
      Effect.asVoid(
        llmModel("Judge", model, options, (message) => new JudgeUnavailable({ model, message })),
      ),
    get: ({ model, effort }, recorded) =>
      Effect.gen(function* () {
        const unavailable = (message: string) => new JudgeUnavailable({ model, message });
        const llm = yield* llmModel("Judge", model, options, unavailable);
        const imageTokens = judgeImageTokens(model);
        if (imageTokens === undefined) {
          return yield* unavailable(
            `${model} has no documented upper bound on its image tokens, so its calls can't be estimated within the Budget; choose another Judge`,
          );
        }
        const { price, pricing } = yield* llmPrice(model, recorded, options, unavailable);
        const caller = llmCaller({
          role: "Judge",
          instructions,
          model: llm,
          effort,
          pricing,
          timeoutMs: options.timeoutMs,
          schema: JudgeVerdict,
          schemaName: "the Rubric's verdict schema",
          read: (verdict, cost) => ({
            _tag: "Accepted",
            success: { kind: "judged" as const, verdict, ...cost },
          }),
        });

        return {
          model,
          effort,
          price,
          rubric,
          estimate: (input) =>
            estimateJudgeCall({ effort, imageTokens }, pricing, caller.prompt, input),
          call: (request: JudgeRequest) =>
            caller.call([
              {
                role: "user",
                content: judgeMessage(request).map((part) =>
                  part.kind === "text"
                    ? { type: "text" as const, text: part.text }
                    : {
                        type: "image" as const,
                        image: part.image.bytes,
                        mediaType: part.image.mimeType,
                      },
                ),
              },
            ]),
        };
      }),
  });
