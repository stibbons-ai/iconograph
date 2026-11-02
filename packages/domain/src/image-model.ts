import { Context, Data, Duration, Effect, Schema } from "effect";
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
 * A billable call that produced nothing usable, classified by the adapter;
 * shared by every kind of billable call (Image Model, Judge). `costMicros` is
 * the actual cost from the vendor's usage report: 0 when the vendor doesn't
 * bill the response (Google doesn't bill HTTP errors), null when unknown (no
 * usable response, or a response that may have been billed but whose usage
 * report is missing or too incomplete to price without undercounting).
 */
export type UnsuccessfulCall =
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

/** What one Image Model call returned (see `UnsuccessfulCall` for `costMicros`). */
export type CallResult =
  | {
      readonly kind: "image";
      readonly image: EncodedImage;
      /** Null when the vendor sent no usage report; the image may still have been billed. */
      readonly usage: Usage | null;
      /** Null when the usage report is missing or too incomplete to price the call without undercounting. */
      readonly costMicros: number | null;
    }
  | UnsuccessfulCall;

/** How any billable call ended, as the Budget's ledger records it. */
export const SettledCallKind = Schema.Literals([
  "image",
  "judged",
  "refused",
  "transient",
  "failed",
]);

/** What the Budget's ledger records of any billable call's result (Image Model or Judge). */
export interface SettledCall {
  readonly kind: typeof SettledCallKind.Type;
  readonly costMicros: number | null;
  readonly usage?: Usage | null;
  readonly reason?: string;
}

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
 * The Budget's view of one subject's billable calls (a Candidate's Image Model
 * calls, or its Judge calls), by attempt (from 0). `reserve` must succeed
 * before a call is made; `settle` records what it cost.
 */
export interface CallGate<E = never> {
  readonly reserve: (
    attempt: number,
    estimate: CallEstimate,
  ) => Effect.Effect<void, BudgetExhausted | E>;
  readonly settle: (attempt: number, result: SettledCall) => Effect.Effect<void, E>;
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
export const notSent = (why: string): UnsuccessfulCall => ({
  kind: "failed",
  reason: `Not sent: ${why}`,
  usage: null,
  costMicros: 0,
});

type Transient = Extract<UnsuccessfulCall, { kind: "transient" }>;
const isTransient = (result: SettledCall): result is Transient => result.kind === "transient";

/** A call that kept failing transiently: retries ran out, or the next didn't fit the Budget. */
export interface GaveUp {
  readonly kind: "gave-up";
  readonly reason: string;
  /** A retry was due but didn't fit the Budget, so it wasn't made. */
  readonly budgetExhausted: boolean;
}

export interface RetriedCallOptions<S extends SettledCall, E> {
  readonly estimate: CallEstimate;
  /** One billable call; never fails, every outcome is a result. Interrupting it aborts the request. */
  readonly call: Effect.Effect<S | UnsuccessfulCall>;
  /** Attempt 0 is already reserved: the caller reserves every first call before launching any. */
  readonly gate: CallGate<E>;
  readonly policy?: RetryPolicy;
}

/**
 * One billable call: the reserved first attempt, then a retry per transient
 * error up to the policy's limit, each retry reserved against the Budget
 * first. Returns the first non-transient result, or `GaveUp`.
 *
 * When interrupted (e.g. a sibling step failed), the attempt in progress is
 * settled: a call already sent as of unknown cost, since the vendor may still
 * bill it; a reservation whose call was never sent as $0. A failed settle is
 * logged as a warning; the unsettled row then counts at its estimate.
 */
export const callWithRetries = <S extends SettledCall, E>(options: RetriedCallOptions<S, E>) =>
  Effect.suspend(() => {
    const { estimate, call, gate, policy = DEFAULT_RETRY_POLICY } = options;
    // The current attempt: reserved (attempt 0 by the caller), sent, or settled.
    let attempt = 0;
    let state: "reserved" | "sent" | "settled" = "reserved";
    const settleOnInterrupt = Effect.suspend(() => {
      if (state === "settled") return Effect.void;
      const result: UnsuccessfulCall =
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
      for (;;) {
        state = "sent";
        const result = yield* call;
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
        if (!isTransient(result)) return result;
        if (attempt >= policy.maxRetries) {
          const tries = attempt + 1;
          return {
            kind: "gave-up",
            reason: `${result.reason} (gave up after ${tries} attempt${tries === 1 ? "" : "s"})`,
            budgetExhausted: false,
          } satisfies GaveUp;
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
            kind: "gave-up",
            reason: `${result.reason}; retry not made: Budget exhausted`,
            budgetExhausted: true,
          } satisfies GaveUp;
        }
      }
    }).pipe(Effect.onInterrupt(() => settleOnInterrupt));
  });

/**
 * One Candidate's Image Model call with retries (`callWithRetries`). A refusal
 * is final; a retry that doesn't fit ends the Candidate as Failed.
 */
export const generateCandidate = <E>({
  model,
  request,
  gate,
  policy,
}: GenerateCandidateOptions<E>) =>
  Effect.suspend(() =>
    callWithRetries({
      estimate: model.estimate(request),
      call: model.call(request),
      gate,
      ...(policy && { policy }),
    }),
  ).pipe(
    Effect.map((result): Generation => {
      switch (result.kind) {
        case "image":
          return { kind: "image", image: result.image };
        case "refused":
          return { kind: "refused", reason: result.reason };
        case "failed":
          return { kind: "failed", reason: result.reason, budgetExhausted: false };
        case "gave-up":
          return { kind: "failed", reason: result.reason, budgetExhausted: result.budgetExhausted };
      }
    }),
  );
