import {
  errorMessage,
  NativeImageModels,
  openPriceSource,
  type PriceSource,
} from "@iconograph/adapters";
import type { ImageModels, Judges, Optimizers } from "@iconograph/domain";
import { Effect, type Layer } from "effect";
import { MastraJudges } from "./judge";
import { MastraOptimizers } from "./optimizer";

/** The Image Models, Judges and Optimizers a Run uses, and how to release what they hold. */
export interface VendorsResource {
  imageModels: Layer.Layer<ImageModels>;
  judges: Layer.Layer<Judges>;
  optimizers: Layer.Layer<Optimizers>;
  /**
   * Brings the price data up to date (`PriceSource.ensureFresh`). Calling it
   * before the first lookup makes the caller own refreshing: lookups then wait
   * for that call instead of refreshing by themselves, and its failure is the
   * caller's to report. Absent when the vendors hold no price source.
   */
  ensurePricesFresh?: PriceSource["ensureFresh"];
  close(): void;
}

/** Opens the vendors of a data volume; `warn` receives non-fatal problems (e.g. a failed price refresh). */
export type OpenVendors = (
  dataDirectory: string,
  warn: (message: string) => void,
) => Promise<VendorsResource>;

/**
 * A price lookup that refreshes the LiteLLM data once, on the first lookup.
 * Image Models look up a price only after the API key check, so a missing key
 * fails without any network request. A failed refresh keeps the cached or
 * bundled prices (the report names the source) and is reported through `warn`.
 * An `ensureFresh` through the result before the first lookup takes that
 * refresh's place: lookups wait for it and never refresh themselves, so no two
 * fetches overlap.
 */
export function refreshOnFirstLookup(
  prices: Pick<PriceSource, "ensureFresh" | "lookup">,
  warn: (message: string) => void,
): Pick<PriceSource, "ensureFresh" | "lookup"> {
  let refreshed: Promise<void> | undefined;
  const refreshOnce = () =>
    (refreshed ??= prices.ensureFresh().then(
      () => undefined,
      (error: unknown) => warn(`Price refresh failed: ${errorMessage(error)}`),
    ));
  return {
    ensureFresh: (options) => {
      const refresh = prices.ensureFresh(options);
      refreshed ??= refresh.then(
        () => undefined,
        () => undefined,
      );
      return refresh;
    },
    lookup: (model) => Effect.promise(refreshOnce).pipe(Effect.flatMap(() => prices.lookup(model))),
  };
}

/** The native Image Models and the Mastra Judges and Optimizers, priced by `source`. */
export function vendorsPricedBy(
  source: PriceSource,
  warn: (message: string) => void,
): VendorsResource {
  const prices = refreshOnFirstLookup(source, warn);
  return {
    imageModels: NativeImageModels({ prices }),
    judges: MastraJudges({ prices }),
    optimizers: MastraOptimizers({ prices }),
    ensurePricesFresh: prices.ensureFresh,
    close: () => source.close(),
  };
}

/** `vendorsPricedBy` the price source in the data volume. */
export const nativeVendors: OpenVendors = async (dataDirectory, warn) =>
  vendorsPricedBy(await openPriceSource({ dataDirectory }), warn);
