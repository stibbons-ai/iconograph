import { Effect, Schema } from "effect";

/**
 * Budget amounts are integer micro-dollars (1 USD = 1,000,000), so sums and the
 * exact-fit comparison are exact; float USD would make $0.15 − 3 × $0.05 miss.
 */
const MICRO_DECIMALS = 6;
const MICROS_PER_USD = 10 ** MICRO_DECIMALS;

export function toMicros(usd: number): number {
  return Math.round(usd * MICROS_PER_USD);
}

export function toUsd(micros: number): number {
  return micros / MICROS_PER_USD;
}

/**
 * Whether a USD amount is a whole number of micro-dollars: at most
 * `MICRO_DECIMALS` decimals. Comparing that rendering is exact for every
 * amount whose micros are a safe integer (the Budget's range), where an
 * absolute tolerance on `usd × 1e6` breaks for large amounts.
 */
export function isWholeMicros(usd: number): boolean {
  return Number(usd.toFixed(MICRO_DECIMALS)) === usd;
}

/** One billable call in a Run's ledger. */
export interface LedgerEntry {
  /** Reserved before the call was made. */
  readonly estimateMicros: number;
  /** False while the call is in flight. */
  readonly settled: boolean;
  /** The vendor-reported cost once settled; null when unknown (e.g. the connection dropped). */
  readonly actualMicros: number | null;
}

/**
 * What one call counts against the Budget: its estimate while in flight, its
 * actual cost once settled, and its estimate when the actual cost is unknown
 * (a call that may have been billed is never counted as free).
 */
function committedMicros(entry: LedgerEntry): number {
  return entry.settled && entry.actualMicros !== null ? entry.actualMicros : entry.estimateMicros;
}

/**
 * Budget − actual spent − estimates reserved by in-flight calls, never below 0
 * (a call that cost more than its estimate can overshoot; nothing more fits then).
 */
export function remainingMicros(budgetMicros: number, ledger: readonly LedgerEntry[]): number {
  const committed = ledger.reduce((sum, entry) => sum + committedMicros(entry), 0);
  return Math.max(0, budgetMicros - committed);
}

/** The next billable call didn't fit the remaining Budget, so it wasn't made. */
export class BudgetExhausted extends Schema.TaggedError<BudgetExhausted>()("BudgetExhausted", {
  estimateMicros: Schema.Int,
  remainingMicros: Schema.Int,
}) {
  override get message() {
    return `Budget exhausted: the next call is estimated at $${toUsd(this.estimateMicros)}, $${toUsd(this.remainingMicros)} remains`;
  }
}

/**
 * Whether a call estimated at `estimateMicros` fits; an exact fit does. Returns
 * the decision with the remaining Budget it was made against.
 */
export function checkBudget(
  budgetMicros: number,
  ledger: readonly LedgerEntry[],
  estimateMicros: number,
): { fits: true } | { fits: false; error: BudgetExhausted } {
  const remaining = remainingMicros(budgetMicros, ledger);
  return estimateMicros <= remaining
    ? { fits: true }
    : {
        fits: false,
        error: new BudgetExhausted({ estimateMicros, remainingMicros: remaining }),
      };
}

/** Whether a reservation fit: `BudgetExhausted` becomes false, so the caller can stop the Lane. */
export const fitsBudget = <E, R>(reservation: Effect.Effect<void, BudgetExhausted | E, R>) =>
  reservation.pipe(
    Effect.as(true),
    Effect.catchTag("BudgetExhausted", () => Effect.succeed(false)),
  );
