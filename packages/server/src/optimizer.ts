import {
  checkProposedPrompt,
  estimateOptimizerCall,
  OPTIMIZER_INSTRUCTIONS,
  type OptimizerCallResult,
  optimizerMessage,
  OptimizerProposal,
  type OptimizerRequest,
  Optimizers,
  OptimizerUnavailable,
} from "@iconograph/domain";
import { Effect, Layer } from "effect";
import { llmCaller, type LlmAgentsOptions, llmModel, llmPrice, type ReadAnswer } from "./llm";

/** An Optimizer call that answered with a Prompt a Lane can send. */
type Optimized = Extract<OptimizerCallResult, { kind: "optimized" }>;

/**
 * The Optimizers behind Mastra agents on their vendor's AI SDK provider, built
 * as the Judges are (`llm.ts`): the vendor, its API key and its LLM price are
 * checked when one is got, so a Run fails before any billable call. Each call
 * is one structured-output generation whose answer must decode as a proposal
 * holding a Prompt a Lane can send (`checkProposedPrompt`). Only the Target
 * Look and the Lane's recent Prompts, outcomes and Judge notes are sent, as
 * text; never a photo.
 */
export const MastraOptimizers = (options: LlmAgentsOptions) =>
  Layer.succeed(Optimizers)({
    checkCredentials: (model) =>
      Effect.asVoid(
        llmModel(
          "Optimizer",
          model,
          options,
          (message) => new OptimizerUnavailable({ model, message }),
        ),
      ),
    get: ({ model, effort }, recorded) =>
      Effect.gen(function* () {
        const unavailable = (message: string) => new OptimizerUnavailable({ model, message });
        const llm = yield* llmModel("Optimizer", model, options, unavailable);
        const { price, pricing } = yield* llmPrice(model, recorded, options, unavailable);
        const caller = llmCaller<OptimizerProposal, Optimized>({
          role: "Optimizer",
          instructions: OPTIMIZER_INSTRUCTIONS,
          model: llm,
          effort,
          pricing,
          timeoutMs: options.timeoutMs,
          schema: OptimizerProposal,
          schemaName: "its output schema",
          read: (proposal, cost): ReadAnswer<Optimized> => {
            const checked = checkProposedPrompt(proposal.prompt);
            return checked._tag === "Rejected"
              ? { _tag: "Rejected", problem: checked.problem }
              : {
                  _tag: "Accepted",
                  success: { kind: "optimized", prompt: checked.prompt, ...cost },
                };
          },
        });

        return {
          model,
          effort,
          price,
          estimate: (request: OptimizerRequest) =>
            estimateOptimizerCall(effort, pricing, caller.prompt, request),
          call: (request: OptimizerRequest) =>
            caller.call([{ role: "user", content: optimizerMessage(request) }]),
        };
      }),
  });
