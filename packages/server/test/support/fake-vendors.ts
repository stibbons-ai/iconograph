/**
 * Fake language-model vendors (Judge, Optimizer): answers shaped as each
 * pinned AI SDK provider parses them (the Anthropic Messages API, the OpenAI
 * Responses API, the Gemini API's generateContent), built from the providers'
 * response schemas, never recorded from a live call; and a local server
 * answering as a vendor API.
 */
import type { LlmVendor } from "@iconograph/domain";
import { type LlmFetch, LLM_BASE_URLS } from "../../src/llm";

/**
 * A successful answer whose text is `text`, with 9,000 input and 300 output
 * tokens; with `cutOff`, stopped at the output-token cap instead.
 */
export function vendorAnswer(vendor: LlmVendor, text: string, cutOff = false): Response {
  const bodies: { readonly [V in LlmVendor]: object } = {
    anthropic: {
      id: "msg_fake",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5-5",
      content: [{ type: "text", text }],
      stop_reason: cutOff ? "max_tokens" : "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 9_000, output_tokens: 300 },
    },
    openai: {
      id: "resp_fake",
      object: "response",
      created_at: 1_793_700_000,
      model: "gpt-5.5",
      status: cutOff ? "incomplete" : "completed",
      incomplete_details: cutOff ? { reason: "max_output_tokens" } : null,
      output: [
        {
          type: "message",
          id: "msg_fake",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ],
      usage: {
        input_tokens: 9_000,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 300,
        output_tokens_details: { reasoning_tokens: 0 },
      },
    },
    google: {
      candidates: [
        {
          content: { role: "model", parts: [{ text }] },
          finishReason: cutOff ? "MAX_TOKENS" : "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 9_000, candidatesTokenCount: 300, totalTokenCount: 9_300 },
    },
  };
  return Response.json(bodies[vendor]);
}

/** An Anthropic API error answer: `status`, with the error's `type` and `message`. */
export const vendorError = (status: number, type: string, message: string): Response =>
  Response.json({ type: "error", error: { type, message } }, { status });

/**
 * A Google API error body (`google.rpc.Status`, https://google.aip.dev/193):
 * HTTP `status` with its canonical status name (e.g. `INVALID_ARGUMENT`),
 * `message` and `details`, as the Gemini API's `generateContent` answers.
 */
export const googleErrorBody = (
  status: number,
  canonicalStatus: string,
  message: string,
  details: readonly object[],
) => ({ error: { code: status, message, status: canonicalStatus, details } });

/** A Google API error answer: HTTP `status` with its `googleErrorBody`. */
export const googleError = (
  status: number,
  canonicalStatus: string,
  message: string,
  details: readonly object[],
): Response =>
  Response.json(googleErrorBody(status, canonicalStatus, message, details), { status });

/**
 * Google's error body for a bad key, shaped as it answers: 400
 * `INVALID_ARGUMENT` whose details are an `ErrorInfo` with reason
 * `API_KEY_INVALID`, then a `LocalizedMessage`, which has no reason.
 */
export const googleBadKeyBody = (message: string) =>
  googleErrorBody(400, "INVALID_ARGUMENT", message, [
    {
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason: "API_KEY_INVALID",
      domain: "googleapis.com",
      metadata: { service: "generativelanguage.googleapis.com" },
    },
    { "@type": "type.googleapis.com/google.rpc.LocalizedMessage", locale: "en-US", message },
  ]);

/**
 * The network of a real role (Judge, Optimizer) on a fake `vendor` API at
 * `origin`: its calls to that vendor's API go there; a request to a loopback
 * address goes there unchanged, so a local trap sees a misrouted call; any
 * other request is refused before it leaves, so no test reaches a live vendor.
 */
export function fakeVendorFetch(origin: string, role: string, vendor: LlmVendor): LlmFetch {
  const vendorOrigin = new URL(LLM_BASE_URLS[vendor]).origin;
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === vendorOrigin) return fetch(`${origin}${url.pathname}${url.search}`, init);
    if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return fetch(url, init);
    // ERR_INVALID_URL: classified as failed at $0 and not retried, like a local refusal.
    throw Object.assign(
      new TypeError(`The fake ${vendor} ${role} refused a request to ${url.origin}`),
      { code: "ERR_INVALID_URL" },
    );
  };
}

/**
 * A local server answering every request with `answer` (given the request and
 * its body, already read), recording each; `stop` it when done.
 */
export function fakeVendorServer(
  answer: (request: Request, body: string) => Response | Promise<Response>,
) {
  const requests: { readonly path: string; readonly headers: Headers; readonly body: string }[] =
    [];
  const server = Bun.serve({
    port: 0,
    // A slow answer must not be cut off by the server's own idle timeout.
    idleTimeout: 0,
    fetch: async (request) => {
      const body = await request.text();
      requests.push({ path: new URL(request.url).pathname, headers: request.headers, body });
      return answer(request, body);
    },
  });
  return { origin: server.url.origin, requests, stop: () => server.stop(true) };
}
