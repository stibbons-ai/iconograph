import { parseArgs } from "node:util";
import { Unpriced } from "@iconograph/domain";
import { Effect } from "effect";
import { resolveDataDirectory } from "./data-directory";
import { openPriceSource, PriceFetchError, type PriceSourceOptions } from "./prices";

const help = `Print a model's price, its source and its age

Usage:
  bun run prices MODEL [--refresh] [--data-dir PATH]
  bun run prices MODEL --set-override JSON [--data-dir PATH]
  bun run prices MODEL --clear-override [--data-dir PATH]

Options:
  --data-dir PATH       Data volume (default: ICONOGRAPH_DATA_DIR, else ./.data).
                        Prices are cached in PATH/prices.db.
  --refresh             Fetch LiteLLM's price data now, even if the cache is
                        fresh; a failed fetch is an error.
  --set-override JSON   Set this model's manual price, in LiteLLM's field names
                        (USD), e.g. '{"input_cost_per_token":0.000002,
                        "output_cost_per_token":0.00001}'.
  --clear-override      Remove this model's manual price.
  --url URL             LiteLLM price data URL (default: LiteLLM's main branch).
  --help, -h            Show this help.

Lookup order: manual override, then cached LiteLLM data (refreshed when 24 h
old or dated in the future), then the bundled snapshot, used only before the
first successful fetch. Lookup prints JSON with model, pricing, source
(override, litellm or snapshot, with asOf and ageSeconds) and refresh. An
implicit refresh that fails to fetch or validate keeps the old cache and is
reported in refresh.error; an explicit --refresh failure is an error. A model
without a price is an Unpriced error, reported with the refresh before it.
Errors print JSON to stderr and exit nonzero.
`;

/** Test seam: tests inject a fetch, clock and snapshot. */
export type PricesCliDependencies = Partial<
  Pick<PriceSourceOptions, "fetch" | "now" | "snapshot">
> & {
  stdout?: (text: string) => void;
};

export async function main(args: string[], dependencies: PricesCliDependencies = {}) {
  const { stdout = (text) => process.stdout.write(text), ...sourceOptions } = dependencies;
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      "data-dir": { type: "string" },
      refresh: { type: "boolean" },
      "set-override": { type: "string" },
      "clear-override": { type: "boolean" },
      url: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    stdout(help);
    return;
  }
  const [model, ...extra] = positionals;
  if (model === undefined || extra.length > 0) {
    throw new Error("Expected exactly one MODEL; use --help for usage");
  }
  const overrideJson = values["set-override"];
  const actions = [values.refresh, overrideJson !== undefined, values["clear-override"]];
  if (actions.filter(Boolean).length > 1) {
    throw new Error("Use at most one of --refresh, --set-override and --clear-override");
  }
  let override: unknown;
  if (overrideJson !== undefined) {
    try {
      override = JSON.parse(overrideJson);
    } catch (error) {
      throw new Error(`--set-override is not valid JSON: ${(error as Error).message}`);
    }
  }
  const source = await openPriceSource({
    ...sourceOptions,
    dataDirectory: resolveDataDirectory(values["data-dir"]),
    ...(values.url === undefined ? {} : { url: values.url }),
  });
  const print = (value: unknown) => stdout(`${JSON.stringify(value)}\n`);
  try {
    if (overrideJson !== undefined) {
      const { fields, setAt } = await source.setOverride(model, override);
      print({ model, override: fields, setAt: setAt.toISOString() });
      return;
    }
    if (values["clear-override"]) {
      print({ model, cleared: await source.clearOverride(model) });
      return;
    }
    // An explicit --refresh must succeed. An implicit refresh that can't reach or
    // read LiteLLM is reported, not fatal: the old cache or the snapshot still answers.
    const refresh = values.refresh
      ? await source.refresh()
      : await source.ensureFresh().catch((error: unknown) => {
          if (!(error instanceof PriceFetchError)) throw error;
          return { refreshed: false, error: error.message };
        });
    const quote = await Effect.runPromise(source.lookup(model)).catch((failure: unknown) => {
      throw new LookupFailed(failure, refresh);
    });
    print({ ...quote, refresh });
  } finally {
    source.close();
  }
}

/** A failed lookup with the refresh before it, so a fetch error isn't mistaken for a bad model id. */
class LookupFailed extends Error {
  constructor(
    failure: unknown,
    readonly refresh: unknown,
  ) {
    super(failure instanceof Error ? failure.message : String(failure), { cause: failure });
  }
}

function errorReport(error: unknown): Record<string, unknown> {
  if (error instanceof LookupFailed) return { ...errorReport(error.cause), refresh: error.refresh };
  if (error instanceof Unpriced)
    return { error: error.message, _tag: error._tag, model: error.model };
  return { error: error instanceof Error ? error.message : String(error) };
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${JSON.stringify(errorReport(error))}\n`);
    process.exitCode = 1;
  }
}
