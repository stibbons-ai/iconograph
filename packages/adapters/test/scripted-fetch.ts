import {
  type CallGate,
  generateCandidate,
  type ImageModel,
  type ImageRequest,
  type SettledCall,
} from "@iconograph/domain";
import { Effect } from "effect";

export interface Sent {
  url: string;
  init: RequestInit;
}

/** A fetch that answers each call from the next scripted response and records what was sent. */
export function scriptedFetch(responses: readonly (() => Promise<Response>)[]) {
  const sent: Sent[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    const next = responses[sent.length - 1];
    if (!next) throw new Error(`Unexpected call ${sent.length}`);
    return next();
  };
  return { fetch, sent };
}

/** A fetch whose request never answers, recording whether it was aborted. */
export function hangingFetch() {
  const state = { aborted: false };
  const fetch = (_: string, init: RequestInit) => {
    const { promise, reject } = Promise.withResolvers<Response>();
    init.signal?.addEventListener("abort", () => {
      state.aborted = true;
      reject(new Error("aborted"));
    });
    return promise;
  };
  return { fetch, state };
}

/** Scripted JSON replies with a status and a recorded body, read by `recorded`. */
export const recordedReplies =
  (recorded: (name: string) => Promise<string>) => (status: number, name: string) => async () =>
    new Response(await recorded(name), { status, headers: { "content-type": "application/json" } });

/** Generate one Candidate with retries (no backoff); every attempt is let through and recorded. */
export async function generateRecorded(model: ImageModel, request: ImageRequest) {
  const settled: SettledCall[] = [];
  const gate: CallGate = {
    reserve: () => Effect.void,
    settle: (_, result) => Effect.sync(() => void settled.push(result)),
  };
  const generation = await Effect.runPromise(
    generateCandidate({ model, request, gate, policy: { maxRetries: 2, baseDelayMs: 0 } }),
  );
  return { generation, settled };
}
