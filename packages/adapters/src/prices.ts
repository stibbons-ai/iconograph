import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  DateString,
  needsRefresh,
  PriceFields,
  pricingProblem,
  pricingSpec,
  pricingSpecs,
  resolvePrice,
  type PriceQuote,
  type Unpriced,
} from "@iconograph/domain";
import { createClient } from "@libsql/client";
import { Data, Effect, Schema } from "effect";
import bundledSnapshot from "../litellm-prices.snapshot.json";
import { pricesDatabase } from "./data-directory";

/** LiteLLM's public price data on `main`: deliberately unpinned, so prices stay current. */
export const litellmPricesUrl =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const decodeLiteLLMFile = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
const decodeLiteLLMEntry = Schema.decodeUnknownOption(PriceFields);

export interface LiteLLMPrices {
  /** Price fields keyed by LiteLLM model key, only for entries that carry any. */
  prices: ReadonlyMap<string, PriceFields>;
  /** Keys whose entry is well-formed but carries no price field we read. */
  withoutPrices: ReadonlySet<string>;
  /** Keys whose entry or read price fields were malformed; those models stay unpriced. */
  rejected: string[];
}

/**
 * Decode LiteLLM's JSON model map. Unknown fields are ignored; an entry whose
 * read price fields are not non-negative numbers is dropped and listed in
 * `rejected`, so one bad upstream entry can't block a refresh. Throws when the
 * data is not an object or no model has a price.
 */
export function decodeLiteLLMPrices(json: unknown): LiteLLMPrices {
  const prices = new Map<string, PriceFields>();
  const withoutPrices = new Set<string>();
  const rejected: string[] = [];
  for (const [key, entry] of Object.entries(decodeLiteLLMFile(json))) {
    // `sample_spec` documents the format; it is not a model.
    if (key === "sample_spec") continue;
    const fields = decodeLiteLLMEntry(entry);
    if (fields._tag === "None") rejected.push(key);
    else if (Object.keys(fields.value).length > 0) prices.set(key, fields.value);
    else withoutPrices.add(key);
  }
  if (prices.size === 0) throw new Error("No model in the price data has a price");
  return { prices, withoutPrices, rejected };
}

/** The committed offline fallback, trimmed to the models Iconograph uses. */
export const PriceSnapshot = Schema.Struct({
  source: Schema.String,
  commit: Schema.String,
  fetchedAt: DateString,
  models: Schema.Record(Schema.String, PriceFields),
});
export type PriceSnapshot = typeof PriceSnapshot.Type;

const decodePriceSnapshot = Schema.decodeUnknownSync(PriceSnapshot);

export function readPriceSnapshot(): PriceSnapshot {
  return decodePriceSnapshot(bundledSnapshot);
}

const defaultModelKeys = new Set(Object.values(pricingSpecs).map((spec) => spec.litellmKey));

/** A date read back from the database; a tampered row is an error, not an Invalid Date. */
function storedDate(value: unknown): Date {
  const date = new Date(Number(value));
  if (!Number.isFinite(date.getTime())) throw new Error(`Stored date ${String(value)} is invalid`);
  return date;
}

/**
 * The price data could not be fetched, was invalid, or can't price a default
 * model; the existing cache is untouched.
 */
export class PriceFetchError extends Error {
  override name = "PriceFetchError";
}

/** The price database could not be read, or held data that no longer decodes. */
export class PriceStoreError extends Data.TaggedError("PriceStoreError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export interface PriceSourceOptions {
  /** The data volume; the cache lives in `prices.db` inside it. */
  dataDirectory: string;
  /** Defaults to `litellmPricesUrl`. */
  url?: string;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => Date;
  /** Defaults to the bundled snapshot. */
  snapshot?: PriceSnapshot;
  /** Abort a fetch (including its body) after this long; default 30 s. */
  timeoutMs?: number;
}

export interface Refresh {
  /** False when the cache was younger than 24 h and no request was made. */
  refreshed: boolean;
  fetchedAt: Date;
  /** After a fetch: LiteLLM keys dropped because their price fields were malformed. */
  rejected?: string[];
}

export interface PriceOverride {
  fields: PriceFields;
  setAt: Date;
}

const decodeStoredFields = Schema.decodeUnknownSync(Schema.fromJsonString(PriceFields));
const decodeOverrideFields = Schema.decodeUnknownSync(PriceFields, { onExcessProperty: "error" });

const schema = `
CREATE TABLE IF NOT EXISTS litellm_fetch (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS litellm_prices (model TEXT PRIMARY KEY, fields TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS price_overrides (
  model TEXT PRIMARY KEY,
  fields TEXT NOT NULL,
  set_at INTEGER NOT NULL
);
`;

export interface PriceSource {
  /** Fetch LiteLLM's data now and replace the cache; on any failure the cache is unchanged. */
  refresh(): Promise<Refresh>;
  /**
   * Refresh only when there is no cache, it is 24 h old or more, or it is dated
   * in the future (the clock moved back).
   */
  ensureFresh(): Promise<Refresh>;
  /** Never fetches; call `ensureFresh` first to keep LiteLLM data current. */
  lookup(model: string): Effect.Effect<PriceQuote, Unpriced | PriceStoreError>;
  /**
   * Replace a model's override with these LiteLLM-named fields. Unknown fields,
   * and fields that can't price the model (`pricingProblem`), are rejected.
   */
  setOverride(model: string, input: unknown): Promise<PriceOverride>;
  /** True when an override existed. */
  clearOverride(model: string): Promise<boolean>;
  close(): void;
}

/**
 * Model prices: manual override > cached LiteLLM data > bundled snapshot.
 * Call `ensureFresh` at boot and daily; a failed refresh keeps serving the
 * existing cache, however old, and reports its age.
 */
export async function openPriceSource(options: PriceSourceOptions): Promise<PriceSource> {
  const {
    url = litellmPricesUrl,
    fetch: fetchPrices = fetch,
    now = () => new Date(),
    timeoutMs = 30_000,
  } = options;
  // An injected snapshot is validated like the bundled one.
  const snapshot = decodePriceSnapshot(options.snapshot ?? bundledSnapshot);
  await mkdir(options.dataDirectory, { recursive: true });
  const client = createClient({
    url: pathToFileURL(pricesDatabase(options.dataDirectory)).href,
    // A server and the CLI may share the file; wait for a lock instead of failing at once.
    timeout: 5_000,
  });
  try {
    await client.executeMultiple(schema);
  } catch (error) {
    client.close();
    throw error;
  }
  const snapshotAsOf = new Date(snapshot.fetchedAt);

  async function fetchedAt(): Promise<Date | undefined> {
    const { rows } = await client.execute("SELECT fetched_at FROM litellm_fetch");
    return rows[0] ? new Date(Number(rows[0].fetched_at)) : undefined;
  }

  const fetchFailed = (error: unknown): never => {
    throw new PriceFetchError(`LiteLLM price fetch from ${url} failed: ${message(error)}`, {
      cause: error,
    });
  };

  async function refresh(): Promise<Refresh> {
    // Called inside `then`, so an injected fetch that throws synchronously also becomes a PriceFetchError.
    const response = await Promise.resolve()
      .then(() => fetchPrices(url, { signal: AbortSignal.timeout(timeoutMs) }))
      .catch(fetchFailed);
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new PriceFetchError(`LiteLLM price fetch failed: HTTP ${response.status} from ${url}`);
    }
    const text = await response.text().catch(fetchFailed);
    let decoded: LiteLLMPrices;
    try {
      decoded = decodeLiteLLMPrices(JSON.parse(text));
    } catch (error) {
      throw new PriceFetchError(`LiteLLM price data from ${url} is invalid: ${message(error)}`, {
        cause: error,
      });
    }
    const badDefaults = decoded.rejected.filter((key) => defaultModelKeys.has(key));
    if (badDefaults.length > 0) {
      throw new PriceFetchError(
        `LiteLLM price data from ${url} has malformed prices for default model ${badDefaults.join(", ")}; keeping the existing cache`,
      );
    }
    // A default model whose entry is present but can't price it (e.g. a required
    // field removed upstream) would be unpriced until the next refresh.
    const unpriceable: string[] = [];
    for (const [model, { litellmKey }] of Object.entries(pricingSpecs)) {
      const fields = decoded.prices.get(litellmKey);
      // An absent default key leaves that model unpriced; it doesn't fail the refresh.
      if (fields === undefined && !decoded.withoutPrices.has(litellmKey)) continue;
      const problem = pricingProblem(model, fields ?? {});
      if (problem !== undefined) unpriceable.push(`${litellmKey} (${problem})`);
    }
    if (unpriceable.length > 0) {
      throw new PriceFetchError(
        `LiteLLM price data from ${url} can't price default model ${unpriceable.join(", ")}; keeping the existing cache`,
      );
    }
    const fetched = now();
    await client.batch(
      [
        "DELETE FROM litellm_prices",
        {
          sql: "INSERT INTO litellm_prices (model, fields) SELECT key, value FROM json_each(?)",
          args: [JSON.stringify(Object.fromEntries(decoded.prices))],
        },
        {
          sql: "INSERT OR REPLACE INTO litellm_fetch (id, fetched_at) VALUES (1, ?)",
          args: [fetched.getTime()],
        },
      ],
      "write",
    );
    return { refreshed: true, fetchedAt: fetched, rejected: decoded.rejected };
  }

  return {
    refresh,

    async ensureFresh() {
      const fetched = await fetchedAt();
      if (fetched && !needsRefresh(fetched, now())) return { refreshed: false, fetchedAt: fetched };
      return refresh();
    },

    lookup(model) {
      const { litellmKey } = pricingSpec(model);
      return Effect.tryPromise({
        try: async () => {
          // One read transaction, so a concurrent refresh can't mix fetch times and prices.
          const [fetches, overridden, cached] = await client.batch(
            [
              "SELECT fetched_at FROM litellm_fetch",
              { sql: "SELECT fields, set_at FROM price_overrides WHERE model = ?", args: [model] },
              { sql: "SELECT fields FROM litellm_prices WHERE model = ?", args: [litellmKey] },
            ],
            "read",
          );
          const fetchRow = fetches?.rows[0];
          const overrideRow = overridden?.rows[0];
          const cachedRow = cached?.rows[0];
          return {
            model,
            now: now(),
            override: overrideRow && {
              asOf: storedDate(overrideRow.set_at),
              fields: decodeStoredFields(overrideRow.fields),
            },
            litellm: fetchRow && {
              asOf: storedDate(fetchRow.fetched_at),
              fields: cachedRow ? decodeStoredFields(cachedRow.fields) : undefined,
            },
            snapshot: {
              asOf: snapshotAsOf,
              commit: snapshot.commit,
              fields: Object.hasOwn(snapshot.models, litellmKey)
                ? snapshot.models[litellmKey]
                : undefined,
            },
          };
        },
        catch: (cause) =>
          new PriceStoreError({
            message: `Reading the price of ${model} from the price database failed: ${message(cause)}`,
            cause,
          }),
      }).pipe(Effect.flatMap(resolvePrice));
    },

    async setOverride(model, input) {
      const fields = decodeOverrideFields(input);
      const problem = pricingProblem(model, fields);
      if (problem !== undefined) throw new Error(`Override for ${model}: ${problem}`);
      const setAt = now();
      await client.execute({
        sql: "INSERT OR REPLACE INTO price_overrides (model, fields, set_at) VALUES (?, ?, ?)",
        args: [model, JSON.stringify(fields), setAt.getTime()],
      });
      return { fields, setAt };
    },

    async clearOverride(model) {
      const { rowsAffected } = await client.execute({
        sql: "DELETE FROM price_overrides WHERE model = ?",
        args: [model],
      });
      return rowsAffected > 0;
    },

    close() {
      client.close();
    },
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
