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
 * prefix alike). A cut reason is at most this long plus the `… (truncated)`
 * suffix.
 */
const MAX_REASON_LENGTH = 2000;

/**
 * How far past the cut masked echoes are scrubbed. An echo whose asterisks
 * begin before the cut must have three of them inside the scanned slice to
 * match; the lookahead accepts the slice's end, so the rest of the echo may
 * lie beyond it. Text past the slice is dropped, so a key's unmasked tail
 * there never reaches the reason. Earlier replacements shorten the text, so an
 * echo cut by the slice's end after only one or two asterisks can then show
 * them before the cut; never its unmasked tail.
 */
const SCRUB_MARGIN = 64;

/**
 * A vendor reason fit to store and print. The key is removed (`redactKey`).
 * A masked echo of any key (e.g. `sk-proj-****abcd`) is replaced: a
 * whitespace-delimited word with three or more asterisks after at least three
 * characters, trailing punctuation kept. Then the reason is cut to about
 * `MAX_REASON_LENGTH` characters. Both replacements go before the cut, so it
 * can't leave a key, or the unmasked tail of an echo. Echoes are scrubbed only a
 * little past the cut (`SCRUB_MARGIN`), and the lookbehind starts a match only
 * at a word's start, so the scan stays cheap on huge untrusted text.
 */
export const redactReason = (apiKey: string) => {
  const withoutKey = redactKey(apiKey);
  return (text: string) => {
    const keyless = withoutKey(text);
    const scanned = keyless.slice(0, MAX_REASON_LENGTH + SCRUB_MARGIN);
    const masked = scanned.replace(
      /(?<!\S)\S{3,}\*{3,}\S*?(?=[.,;:!?)"']*(?:\s|$))/g,
      "[redacted]",
    );
    return keyless.length > scanned.length || masked.length > MAX_REASON_LENGTH
      ? `${masked.slice(0, MAX_REASON_LENGTH)}… (truncated)`
      : masked;
  };
};
