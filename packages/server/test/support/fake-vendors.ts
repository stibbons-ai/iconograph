/**
 * Fake language-model vendors (Judge, Optimizer): answers shaped as each
 * pinned AI SDK provider parses them (the Anthropic Messages API, the OpenAI
 * Responses API, the Gemini API's generateContent), built from the providers'
 * response schemas, never recorded from a live call; and a local server
 * answering as a vendor API.
 */
import type { LlmVendor } from "@iconograph/domain";

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
