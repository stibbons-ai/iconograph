/**
 * Regenerate the bundled offline price snapshot from LiteLLM's latest commit of
 * its price file, trimmed to the models Iconograph uses and the fields it reads.
 */
import { writeFile } from "node:fs/promises";
import { decodeLiteLLMPrices, type PriceSnapshot } from "../packages/adapters/src/prices";
import { pricingProblem, pricingSpecs, type PriceFields } from "../packages/domain/src/prices";

const path = "model_prices_and_context_window.json";
const timeout = () => ({ signal: AbortSignal.timeout(30_000) });
const commits = await fetch(
  `https://api.github.com/repos/BerriAI/litellm/commits?path=${path}&per_page=1`,
  timeout(),
);
if (!commits.ok) throw new Error(`GitHub commit lookup failed: HTTP ${commits.status}`);
const [latest] = (await commits.json()) as Array<{ sha: string }>;
if (!latest) throw new Error(`No commit found for ${path}`);

// Fetch the file at that commit, so the recorded commit is exactly what was read.
const source = `https://raw.githubusercontent.com/BerriAI/litellm/${latest.sha}/${path}`;
const response = await fetch(source, timeout());
if (!response.ok) throw new Error(`Fetching ${source} failed: HTTP ${response.status}`);
const { prices, rejected } = decodeLiteLLMPrices(await response.json());

const models: Record<string, PriceFields> = {};
for (const [model, { litellmKey }] of Object.entries(pricingSpecs)) {
  if (rejected.includes(litellmKey)) {
    throw new Error(`LiteLLM's entry for ${litellmKey} has malformed price fields`);
  }
  const fields = prices.get(litellmKey);
  if (!fields) throw new Error(`LiteLLM has no prices for ${litellmKey}`);
  const problem = pricingProblem(model, fields);
  if (problem !== undefined)
    throw new Error(`LiteLLM's ${litellmKey} can't price ${model}: ${problem}`);
  models[litellmKey] = fields;
}
const snapshot: PriceSnapshot = {
  source,
  commit: latest.sha,
  fetchedAt: new Date().toISOString(),
  models,
};
const target = new URL("../packages/adapters/litellm-prices.snapshot.json", import.meta.url);
await writeFile(target, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`Wrote ${Object.keys(models).length} models from ${latest.sha} to ${target.pathname}`);
