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
 */
export function refreshOnFirstLookup(
  prices: Pick<PriceSource, "ensureFresh" | "lookup">,
  warn: (message: string) => void,
): Pick<PriceSource, "lookup"> {
  let refreshed: Promise<void> | undefined;
  const refreshOnce = () =>
    (refreshed ??= prices.ensureFresh().then(
      () => undefined,
      (error: unknown) => warn(`Price refresh failed: ${errorMessage(error)}`),
    ));
  return {
    lookup: (model) => Effect.promise(refreshOnce).pipe(Effect.flatMap(() => prices.lookup(model))),
  };
}

/**
 * The native Image Model adapters and the Mastra Judges and Optimizers, priced
 * by the price source in the data volume.
 */
export const nativeVendors: OpenVendors = async (dataDirectory, warn) => {
  const source = await openPriceSource({ dataDirectory });
  const prices = refreshOnFirstLookup(source, warn);
  return {
    imageModels: NativeImageModels({ prices }),
    judges: MastraJudges({ prices }),
    optimizers: MastraOptimizers({ prices }),
    close: () => source.close(),
  };
};
