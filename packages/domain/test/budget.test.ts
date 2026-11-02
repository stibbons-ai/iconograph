import { describe, expect, test } from "bun:test";
import { checkBudget, type LedgerEntry, remainingMicros, toMicros, toUsd } from "../src";

const reserved = (usd: number): LedgerEntry => ({
  estimateMicros: toMicros(usd),
  settled: false,
  actualMicros: null,
});
const settled = (estimateUsd: number, actualUsd: number | null): LedgerEntry => ({
  estimateMicros: toMicros(estimateUsd),
  settled: true,
  actualMicros: actualUsd === null ? null : toMicros(actualUsd),
});

describe("Budget arithmetic", () => {
  test("remaining is Budget − actual spent − estimates reserved in flight", () => {
    const budget = toMicros(1);
    expect(remainingMicros(budget, [])).toBe(toMicros(1));
    expect(remainingMicros(budget, [settled(0.1, 0.07), reserved(0.1)])).toBe(toMicros(0.83));
  });

  test("a call whose cost is unknown counts at its estimate, never as free", () => {
    expect(remainingMicros(toMicros(1), [settled(0.1, null)])).toBe(toMicros(0.9));
    // An HTTP error the vendor doesn't bill settles at 0.
    expect(remainingMicros(toMicros(1), [settled(0.1, 0)])).toBe(toMicros(1));
  });

  test("an exact fit fits, with no float drift", () => {
    // In float USD, 0.15 − 0.05 − 0.05 is 0.04999…, which would reject the third call.
    const ledger = [reserved(0.05), reserved(0.05)];
    expect(checkBudget(toMicros(0.15), ledger, toMicros(0.05))).toEqual({ fits: true });
    const over = checkBudget(toMicros(0.15), ledger, toMicros(0.05) + 1);
    expect(over.fits).toBe(false);
    expect(!over.fits && over.error.remainingMicros).toBe(toMicros(0.05));
  });

  test("reserving for N parallel calls admits only those that fit", () => {
    const budget = toMicros(0.25);
    const estimate = toMicros(0.1);
    const ledger: LedgerEntry[] = [];
    for (let call = 0; call < 3; call++) {
      if (checkBudget(budget, ledger, estimate).fits) ledger.push(reserved(0.1));
    }
    expect(ledger).toHaveLength(2);
    expect(remainingMicros(budget, ledger)).toBe(toMicros(0.05));
  });

  test("a retry is one more billable call and must fit too", () => {
    const budget = toMicros(0.2);
    // The first attempt failed transiently and wasn't billed; the second is in flight.
    const ledger = [settled(0.1, 0), reserved(0.1)];
    expect(checkBudget(budget, ledger, toMicros(0.1)).fits).toBe(true);
    const unknownFirst = [settled(0.1, null), reserved(0.1)];
    expect(checkBudget(budget, unknownFirst, toMicros(0.1)).fits).toBe(false);
  });

  test("remaining is never negative when a call cost more than its estimate", () => {
    expect(remainingMicros(toMicros(0.1), [settled(0.05, 0.3)])).toBe(0);
    const check = checkBudget(toMicros(0.1), [settled(0.05, 0.3)], 0);
    expect(check).toEqual({ fits: true });
  });

  test("micro-dollar conversion round-trips cent amounts", () => {
    expect(toMicros(0.0504)).toBe(50_400);
    expect(toUsd(toMicros(5))).toBe(5);
  });
});
