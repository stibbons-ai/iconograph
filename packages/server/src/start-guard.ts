import type { WorkflowRunStatus } from "@mastra/core/workflows";
import type { MiddlewareHandler } from "hono";

/** The mounted routes that start a Run under a `runId` from `create-run`. */
const START_ROUTE = /^\/api\/workflows\/([^/]+)\/(?:start-async|stream)$/;

/**
 * Lets each Run start once. Mastra runs a known `runId` again on every start,
 * concurrently, and overwrites its status: a double submit would mark a good
 * Run failed. A start of a `runId` already started here, or one whose stored
 * status is past `pending`, answers 409; a start without a `runId` is a fresh
 * Run. A start that ran nothing (refused input: `start-async` answers 400,
 * `stream` answers 200 and reports the failure inside its stream, both leaving
 * the Run `pending`) may be retried once its request is over.
 */
export function startGuard(
  status: (workflow: string, runId: string) => Promise<WorkflowRunStatus | undefined>,
): MiddlewareHandler {
  /** Runs started through this process: a second start is refused before any lookup. */
  const started = new Set<string>();
  return async (context, next) => {
    const workflow = START_ROUTE.exec(context.req.path)?.[1];
    const runId = context.req.query("runId");
    if (context.req.method !== "POST" || workflow === undefined || !runId) return next();
    const key = `${workflow}/${runId}`;
    if (started.has(key)) {
      return context.json({ error: `Run ${runId} was already started` }, 409);
    }
    // Claimed before the lookup, so two requests at once can't both pass it.
    started.add(key);
    try {
      const stored = await status(workflow, runId);
      if (stored !== undefined && stored !== "pending") {
        return context.json({ error: `Run ${runId} was already started (${stored})` }, 409);
      }
      await next();
    } catch (error) {
      started.delete(key);
      throw error;
    }
    const releaseIfNothingRan = async () => {
      const failed = context.res.status >= 400;
      // A failed lookup keeps the claim: refusing a retry is the safe side.
      if (failed || (await status(workflow, runId).catch(() => undefined)) === "pending") {
        started.delete(key);
      }
    };
    const body = context.res.body;
    if (!body) return releaseIfNothingRan();
    // A stream's Run reports its end in the body; check once the body is done.
    context.res = new Response(
      body.pipeThrough(new TransformStream({ flush: releaseIfNothingRan })),
      context.res,
    );
  };
}
