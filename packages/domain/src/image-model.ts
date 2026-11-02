import { Context, Data, Duration, Effect } from "effect";
import { type BudgetExhausted, fitsBudget } from "./budget";
import type { PriceQuote, Unpriced } from "./prices";

/**
 * What an Image Model can do, as its adapter declares (ADR-0004). Every call
 * returns at most one image, for every adapter (OpenAI with `n=1`), so N
 * Candidates are N calls and the Budget reserves per Candidate.
 */
export interface ImageModelCapabilities {
  /** How many reference images the model keeps a character's identity from. */
  readonly maxCharacterReferences: number;
  /** The sizes it can generate; the first is the Lane's size. */
  readonly sizes: readonly [string, ...string[]];
  /** Empty when the model has no quality setting. */
  readonly qualities: readonly string[];
}

/** An encoded image, e.g. a stripped Reference Photo or a generated Candidate. */
export interface EncodedImage {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

export interface ImageRequest {
  readonly prompt: string;
  /** Character references of the Subject, in order; at most `maxCharacterReferences`. */
  readonly references: readonly EncodedImage[];
  /** One of the model's `sizes`. */
  readonly size: string;
}

/** Vendor token counts by name, e.g. `{ inputTokens: 4780, outputImageTokens: 1680 }`. */
export type Usage = Readonly<Record<string, number>>;

/** A cost estimate for one call, made before the call and checked against the Budget. */
export interface CallEstimate {
  readonly micros: number;
  /** The usage the estimate assumes. */
  readonly usage: Usage;
}

/**
 * What one billable call returned, classified by the adapter. `costMicros` is
 * the actual cost from the vendor's usage report: 0 when the vendor doesn't
 * bill the response (Google doesn't bill HTTP errors), null when unknown (no
 * usable response, or a response that may have been billed but whose usage
 * report is missing or too incomplete to price without undercounting).
 */
export type CallResult =
  | {
      readonly kind: "image";
      readonly image: EncodedImage;
      /** Null when the vendor sent no usage report; the image may still have been billed. */
      readonly usage: Usage | null;
      /** Null when the usage report is missing or too incomplete to price the call without undercounting. */
      readonly costMicros: number | null;
    }
  /** A safety block or the model declining; never retried. */
  | {
      readonly kind: "refused";
      readonly reason: string;
      readonly usage: Usage | null;
      readonly costMicros: number | null;
    }
  /** Rate limit, server error or network failure: worth retrying. */
  | { readonly kind: "transient"; readonly reason: string; readonly costMicros: number | null }
  | {
      readonly kind: "failed";
      readonly reason: string;
      readonly usage: Usage | null;
      readonly costMicros: number | null;
    };

/** One specific image-generation model behind our own interface (ADR-0004). */
export interface ImageModel {
  readonly model: string;
  readonly capabilities: ImageModelCapabilities;
  /** The price its estimates and actual costs use: the one recorded when the Run started. */
  readonly price: PriceQuote;
  readonly estimate: (request: ImageRequest) => CallEstimate;
  /**
   * Exactly one billable call returning at most one image; never fails, every
   * outcome is a `CallResult`. Interrupting it aborts the request.
   */
  readonly call: (request: ImageRequest) => Effect.Effect<CallResult>;
}

/** An Image Model that can't be used: unknown, or missing its credentials. */
export class ImageModelUnavailable extends Data.TaggedError("ImageModelUnavailable")<{
  message: string;
  model: string;
}> {}

/**
 * The Image Models a Run can use, by model id. Getting one checks its
 * credentials and price, so a Run fails before any billable call. Given a
 * `price` (the one recorded at Run start), the model uses it instead of a
 * fresh lookup, so later steps cost calls exactly as the Run was quoted. That
 * price must be for the requested model; otherwise `get` fails with `Unpriced`.
 */
export class ImageModels extends Context.Service<
  ImageModels,
  {
    readonly get: (
      model: string,
      price?: PriceQuote,
    ) => Effect.Effect<ImageModel, ImageModelUnavailable | Unpriced>;
  }
>()("@iconograph/domain/ImageModels") {}

/** Transient errors are retried with exponential backoff (issue #1: up to twice). */
export interface RetryPolicy {
  readonly maxRetries: number;
  /** The first retry waits this long; each later one twice as long as the one before. */
  readonly baseDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxRetries: 2, baseDelayMs: 1000 };

/**
 * The Budget's view of one Candidate's billable calls, by attempt (from 0).
 * `reserve` must succeed before a call is made; `settle` records what it cost.
 */
export interface CallGate<E = never> {
  readonly reserve: (
    attempt: number,
    estimate: CallEstimate,
  ) => Effect.Effect<void, BudgetExhausted | E>;
  readonly settle: (attempt: number, result: CallResult) => Effect.Effect<void, E>;
}

export type Generation =
  | { readonly kind: "image"; readonly image: EncodedImage }
  | { readonly kind: "refused"; readonly reason: string }
  /** `budgetExhausted`: a retry was due but didn't fit the Budget, so it wasn't made. */
  | { readonly kind: "failed"; readonly reason: string; readonly budgetExhausted: boolean };

export interface GenerateCandidateOptions<E> {
  readonly model: ImageModel;
  readonly request: ImageRequest;
  /** Attempt 0 is already reserved: the caller reserves every first call before launching any. */
  readonly gate: CallGate<E>;
  readonly policy?: RetryPolicy;
}

/** The result booked for a reserved call that was never sent: failed, at $0. */
export const notSent = (why: string): CallResult => ({
  kind: "failed",
  reason: `Not sent: ${why}`,
  usage: null,
  costMicros: 0,
});

/**
 * One Candidate: the reserved first call, then a retry per transient error up
 * to the policy's limit, each retry reserved against the Budget first. A
 * refusal is final; a retry that doesn't fit ends the Candidate as Failed.
 *
 * When interrupted (e.g. a sibling step failed), the attempt in progress is
 * settled: a call already sent as of unknown cost, since the vendor may still
 * bill it; a reservation whose call was never sent as $0. A failed settle is
 * logged as a warning; the unsettled row then counts at its estimate.
 */
export const generateCandidate = <E>(options: GenerateCandidateOptions<E>) =>
  Effect.suspend(() => {
    const { model, request, gate, policy = DEFAULT_RETRY_POLICY } = options;
    // The current attempt: reserved (attempt 0 by the caller), sent, or settled.
    let attempt = 0;
    let state: "reserved" | "sent" | "settled" = "reserved";
    const settleOnInterrupt = Effect.suspend(() => {
      if (state === "settled") return Effect.void;
      const result: CallResult =
        state === "sent"
          ? { kind: "transient", reason: "Interrupted before the call finished", costMicros: null }
          : notSent("interrupted first");
      return gate
        .settle(attempt, result)
        .pipe(
          Effect.ignore({ log: "Warn", message: `Settling interrupted call ${attempt} failed` }),
        );
    });
    return Effect.gen(function* () {
      const estimate = model.estimate(request);
      for (;;) {
        state = "sent";
        const result = yield* model.call(request);
        // A settle and its bookkeeping complete together, so an interrupt can't
        // overwrite a recorded result.
        yield* Effect.uninterruptible(
          gate.settle(attempt, result).pipe(
            Effect.tap(
              Effect.sync(() => {
                state = "settled";
              }),
            ),
          ),
        );
        switch (result.kind) {
          case "image":
            return { kind: "image", image: result.image } satisfies Generation;
          case "refused":
            return { kind: "refused", reason: result.reason } satisfies Generation;
          case "failed":
            return {
              kind: "failed",
              reason: result.reason,
              budgetExhausted: false,
            } satisfies Generation;
        }
        if (attempt >= policy.maxRetries) {
          const tries = attempt + 1;
          return {
            kind: "failed",
            reason: `${result.reason} (gave up after ${tries} attempt${tries === 1 ? "" : "s"})`,
            budgetExhausted: false,
          } satisfies Generation;
        }
        yield* Effect.sleep(Duration.millis(policy.baseDelayMs * 2 ** attempt));
        // Likewise a reservation and the switch to the next attempt.
        const fits = yield* Effect.uninterruptible(
          fitsBudget(gate.reserve(attempt + 1, estimate)).pipe(
            Effect.tap((reserved) =>
              Effect.sync(() => {
                if (!reserved) return;
                attempt++;
                state = "reserved";
              }),
            ),
          ),
        );
        if (!fits) {
          return {
            kind: "failed",
            reason: `${result.reason}; retry not made: Budget exhausted`,
            budgetExhausted: true,
          } satisfies Generation;
        }
      }
    }).pipe(Effect.onInterrupt(() => settleOnInterrupt));
  });
