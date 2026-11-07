/**
 * Read a vendor API key from the first of `variables` set in `env`, trimmed.
 * Returns the key, or why it can't be used; the reason never contains the key.
 * Keys are read per use and never stored.
 *
 * A header value can't hold control or non-ASCII characters; a runtime
 * rejecting one would quote the value in its error. Real keys are far longer
 * than 20 characters, and a very short one would make redaction garble every
 * reason.
 */
export function apiKeyFromEnv(
  env: Record<string, string | undefined>,
  variables: readonly [string, ...string[]],
  model: string,
): { readonly key: string } | { readonly problem: string } {
  for (const name of variables) {
    const key = env[name]?.trim();
    if (!key) continue;
    return /^[\x21-\x7e]{20,}$/.test(key)
      ? { key }
      : {
          problem: `${name} is shorter than 20 characters or contains spaces, control or non-ASCII characters; check how it was set`,
        };
  }
  return {
    problem: `${variables.join(" or ")} is not set; ${model} needs an API key in the environment`,
  };
}

/** Removes an API key from error text, e.g. from a runtime rejecting the header value. */
export const redactKey = (apiKey: string) => (text: string) =>
  apiKey ? text.replaceAll(apiKey, "[redacted]") : text;

/**
 * Where every vendor reason is cut (vendor text, runtime errors and our own
 * prefix alike). The stored reason can run slightly longer: `… (truncated)`
 * is appended, and `[redacted]` can be longer than the mask it replaces.
 */
const MAX_REASON_LENGTH = 2000;

/**
 * A vendor reason fit to store and print: without the key (`redactKey`), cut
 * to about `MAX_REASON_LENGTH` characters, and without a masked echo of any
 * key (e.g. `sk-proj-****abcd`): a whitespace-delimited word with three or
 * more asterisks after at least three characters (trailing punctuation
 * kept). The key goes before truncating, so a cut can't leave part of it;
 * the lookbehind starts a match only at a word's start, so the scan stays
 * cheap.
 */
export const redactReason = (apiKey: string) => {
  const withoutKey = redactKey(apiKey);
  return (text: string) => {
    const keyless = withoutKey(text);
    const masked = keyless
      .slice(0, MAX_REASON_LENGTH)
      .replace(/(?<!\S)\S{3,}\*{3,}\S*?(?=[.,;:!?)"']*(?:\s|$))/g, "[redacted]");
    return keyless.length > MAX_REASON_LENGTH ? `${masked}… (truncated)` : masked;
  };
};
