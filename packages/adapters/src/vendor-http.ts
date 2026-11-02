import type { ImageRequest } from "@iconograph/domain";
import { Schema } from "effect";

/** A non-negative token count in a vendor's usage report. */
export const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** HTTP statuses worth retrying: request timeout, rate limit, server error. */
export const isTransientStatus = (status: number) =>
  status === 408 || status === 429 || status >= 500;

/** A response body as JSON, or undefined when it isn't JSON. */
export const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** Base64 of exactly the bytes of `bytes` (not its whole backing buffer), without copying them. */
export const base64Of = (bytes: Uint8Array) =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

/** Input tokens of a Prompt at about 3 characters per English token, rounded up: a high estimate. */
export const promptTokens = (prompt: string) => Math.ceil(prompt.length / 3);

/**
 * `encode` once per request: every Candidate of an Iteration sends the same
 * request, so its references are encoded once.
 */
export function encodeOncePerRequest(encode: (request: ImageRequest) => string) {
  const bodies = new WeakMap<ImageRequest, string>();
  return (request: ImageRequest) => {
    let body = bodies.get(request);
    if (body === undefined) {
      body = encode(request);
      bodies.set(request, body);
    }
    return body;
  };
}
