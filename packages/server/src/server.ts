import { mkdir } from "node:fs/promises";
import { setTimeout as sleepFor } from "node:timers/promises";
import {
  attachCleanupError,
  downloadableModelIds,
  ensureModels,
  errorChain,
  errorLine,
  type Fetch,
  modelsDirectory,
  OnnxFaceEmbedder,
  readModelLock,
  resolveDataDirectory,
  runsDatabase,
  withCleanup,
  workflowsStore,
} from "@iconograph/adapters";
import { priceRefreshIntervalMs } from "@iconograph/domain";
import type { WorkflowRunStatus } from "@mastra/core/workflows";
import { type HonoBindings, type HonoVariables, MastraServer } from "@mastra/hono";
import { Hono } from "hono";
import type { RunCliDependencies } from "./cli";
import { nativeVendors } from "./vendors";
import { createRunApplication, RUN_WORKFLOW_ID } from "./index";
import { listenAddress, urlHost, WILDCARD_HOSTS } from "./listen-address";
import { JsonLineLogger } from "./mastra-logger";
import { startGuard } from "./start-guard";
import { jsonLine } from "./warnings";

/** Host names that always reach a loopback listener. */
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** The first retry of a failed face-model download or verification, doubling up to 5 minutes. */
const MODELS_RETRY_MS = 5_000;
const MODELS_RETRY_MAX_MS = 300_000;

/**
 * The Mastra routes a Run needs (method and path as Mastra declares them):
 * reading workflows and Runs, creating, starting (`start-async`, which checks
 * the input before answering, or `stream`), observing and cancelling. Everything
 * else stays unmounted: the fire-and-forget `start` (it answers before checking
 * the input), resuming (the Run workflow never suspends), deleting Runs, time
 * travel, restarts (the server restarts active Runs itself), Mastra's internal
 * `steps/execute` and `events`, and the legacy streams.
 */
export const MOUNTED_ROUTES = [
  ["GET", "/workflows"],
  ["GET", "/workflows/:workflowId"],
  ["GET", "/workflows/:workflowId/runs"],
  ["GET", "/workflows/:workflowId/runs/:runId"],
  ["POST", "/workflows/:workflowId/create-run"],
  ["POST", "/workflows/:workflowId/start-async"],
  ["POST", "/workflows/:workflowId/stream"],
  ["POST", "/workflows/:workflowId/observe"],
  ["POST", "/workflows/:workflowId/runs/:runId/cancel"],
] as const satisfies readonly (readonly [string, string])[];

/** What Mastra logs (as an error) for each active Run its restart sweep couldn't restart. */
const RESTART_FAILED = "Failed to restart workflow run";

export interface ServerConfig {
  /** Interface to listen on; loopback unless set explicitly (ADR-0005, ADR-0012). */
  hostname: string;
  port: number;
  /** The data volume: Runs database, images, face-model weights, price cache. */
  dataDirectory: string;
}

/**
 * The server's settings from the environment: `ICONOGRAPH_HOST`,
 * `ICONOGRAPH_PORT` (see `listenAddress`) and `ICONOGRAPH_DATA_DIR` (default ./.data).
 */
export function serverConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  return { ...listenAddress(env), dataDirectory: resolveDataDirectory(undefined, env) };
}

/** Whether binding `hostname` keeps the server on this machine (no boot warning). */
export function isLoopbackHost(hostname: string): boolean {
  return (
    LOOPBACK_HOSTS.includes(hostname) || hostname === "::1" || /^127(\.\d{1,3}){3}$/.test(hostname)
  );
}

/**
 * The host names (as `URL.hostname` spells them) a request may be addressed
 * to: the loopback names, plus the configured host unless it binds every
 * interface. Anything else is refused, so a web page can't reach the server by
 * rebinding its own DNS name to this machine.
 */
export function allowedHostnames(hostname: string): Set<string> {
  const allowed = new Set(LOOPBACK_HOSTS);
  if (!WILDCARD_HOSTS.has(hostname)) allowed.add(new URL(`http://${urlHost(hostname)}`).hostname);
  return allowed;
}

/** The delay after a failed face-model attempt that waited `delayMs`: doubled, capped at 5 minutes. */
export function nextModelsRetryMs(delayMs: number): number {
  return Math.min(delayMs * 2, MODELS_RETRY_MAX_MS);
}

/** Test seams, as the Run CLI's; production uses the native vendors and the locked ONNX face models. */
export interface ServerDependencies extends Pick<
  RunCliDependencies,
  "vendors" | "faceEmbedder" | "retryPolicy"
> {
  /** Downloads missing face-model weights; defaults to the network. */
  fetchModels?: Fetch;
  /** The first delay before retrying failed face models (default 5 s), doubling up to 5 minutes. */
  modelsRetryMs?: number;
  /**
   * Test seam: waits between face-model attempts and between daily price
   * refreshes (`priceRefreshIntervalMs`); must end when `signal` aborts.
   */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Test seam: wraps `/health`'s database query, e.g. to make it fail. */
  databaseProbe?: (query: () => Promise<void>) => Promise<void>;
  /** Test seam: wraps the boot's listing of active Runs, e.g. to hold it. */
  listActiveRuns?: (list: () => Promise<string[]>) => Promise<string[]>;
  /** Test seam: wraps the start guard's lookup of a Run's stored status, e.g. to hold it. */
  lookupRun?: (
    lookup: () => Promise<WorkflowRunStatus | undefined>,
  ) => Promise<WorkflowRunStatus | undefined>;
  /** Receives one object per log event; default: a JSON line on stderr. */
  log?: (value: Record<string, unknown>) => void;
}

/** Each readiness check: `ok`, `pending` while booting, or the failure's message. */
type Check = { status: "ok" } | { status: "pending" } | { status: "failed"; error: string };

export interface RunningServer {
  url: URL;
  /**
   * Settles once boot work is done: the face models are verified, then the
   * restart of the Runs active at boot has been attempted, waiting for the
   * restarted Runs to end. A Run whose crashed owner's lease hasn't lapsed (15 s)
   * is left to Mastra's own timer, which restarts it later, possibly after
   * `booted` settles. While the face models keep failing it doesn't settle;
   * `stop()` ends the retries.
   */
  booted: Promise<void>;
  /**
   * Stop retrying the face models and abort a download in progress (an injected
   * `fetchModels` that ignores its signal only until its response arrives),
   * abort a price refresh in progress and wait for it, start no more restarts,
   * stop listening, then close Mastra, the Run database and the Image Models.
   * Cancelled Runs still unwinding get up to 5 s to record their Lanes
   * `cancelled` first. Runs already running, or restarted by Mastra's lease
   * timer, are not cancelled: closing storage under them fails them, and
   * Mastra may log that.
   */
  stop(): Promise<void>;
}

/** Mastra's HTTP API restricted to `MOUNTED_ROUTES`. */
class RunRoutesServer extends MastraServer {
  readonly #mounted = new Set(MOUNTED_ROUTES.map(([method, path]) => `${method} ${path}`));
  override async registerRoute(...args: Parameters<MastraServer["registerRoute"]>) {
    const [, route] = args;
    if (this.#mounted.has(`${route.method} ${route.path}`)) await super.registerRoute(...args);
  }
}

/**
 * Methods that change state. Cross-site forms send POST; the others need a
 * preflight that we never answer, but they must not change state without JSON either.
 */
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Our Bun entrypoint (ADR-0007): Mastra's Run routes (`MOUNTED_ROUTES`) under
 * `/api` through its Hono adapter, plus `GET /health`. It listens at once;
 * `/health` and every `/api` route answer 503 until the face models in the data
 * volume are downloaded and verified (retried with backoff). Then the Runs that
 * were active when the server last stopped are restarted.
 */
export async function startServer(
  config: ServerConfig,
  dependencies: ServerDependencies = {},
): Promise<RunningServer> {
  const { hostname, port, dataDirectory } = config;
  const {
    vendors = nativeVendors,
    fetchModels,
    faceEmbedder = (directory: string) =>
      OnnxFaceEmbedder({ dataDirectory: directory, ...(fetchModels && { fetch: fetchModels }) }),
    modelsRetryMs = MODELS_RETRY_MS,
    sleep = (ms, signal) => sleepFor(ms, undefined, { signal }).catch(() => undefined),
    databaseProbe = (query) => query(),
    listActiveRuns = (list) => list(),
    lookupRun = (lookup) => lookup(),
    log = (value) => process.stderr.write(jsonLine(value)),
  } = dependencies;

  if (!isLoopbackHost(hostname)) {
    log({
      warning: `Listening on ${hostname}, beyond loopback, without authentication: anyone who can reach port ${port} can start paid Runs and read Reference Photos. Expose it only through a loopback-bound port (e.g. a container published on 127.0.0.1).`,
    });
  }
  const allowedHosts = allowedHostnames(hostname);

  await mkdir(dataDirectory, { recursive: true });
  const models = await vendors(dataDirectory, (warning) => log({ warning }));
  const application = await createRunApplication({
    databasePath: runsDatabase(dataDirectory),
    dataDirectory,
    imageModels: models.imageModels,
    judges: models.judges,
    optimizers: models.optimizers,
    faceEmbedder: faceEmbedder(dataDirectory),
    ...(dependencies.retryPolicy && { retryPolicy: dependencies.retryPolicy }),
    warn: log,
  }).catch((error: unknown) => {
    try {
      models.close();
    } catch (cleanupError) {
      attachCleanupError(error, cleanupError);
    }
    throw error;
  });
  const { mastra } = application;
  let faceModels: Check = { status: "pending" };
  let restarts: Check = { status: "pending" };
  // The Run application silences Mastra (the CLI's stderr is ours); the server forwards its
  // warnings and errors. Mastra's restart sweep only logs the Runs it fails to restart, so
  // `/health` learns of them here.
  mastra.setLogger({
    logger: new JsonLineLogger((line) => {
      if (line.mastra === RESTART_FAILED) {
        restarts = { status: "failed", error: `Run ${String(line.runId)}: ${String(line.error)}` };
      }
      log(line);
    }),
  });
  const close = () =>
    withCleanup(
      () => application.close(),
      () => models.close(),
    );

  async function databaseCheck(): Promise<Check> {
    try {
      await databaseProbe(async () => {
        // A real query, without loading the newest Run's whole snapshot.
        await (
          await workflowsStore(mastra.getStorage())
        ).listWorkflowRuns({
          workflowName: RUN_WORKFLOW_ID,
          perPage: 1,
          page: 0,
          summary: true,
        });
      });
      return { status: "ok" };
    } catch (error) {
      return { status: "failed", error: errorChain(error) };
    }
  }

  /** A Run's status (stored, or in memory while it runs here); undefined when it has none. */
  const runStatus = (workflow: string, runId: string) =>
    lookupRun(async () =>
      workflow === RUN_WORKFLOW_ID
        ? (await mastra.getWorkflow(RUN_WORKFLOW_ID).getWorkflowRunById(runId))?.status
        : undefined,
    );

  const app = new Hono<{ Bindings: HonoBindings; Variables: HonoVariables }>();
  // An unexpected failure answers JSON and is logged as one line, not a bare 500 and a stack.
  app.onError((error, context) => {
    log({ error: `${context.req.method} ${context.req.path} failed: ${errorChain(error)}` });
    return context.json({ error: errorChain(error) }, 500);
  });
  app.use("*", async (context, next) => {
    // DNS rebinding: only requests addressed to an allowed host name.
    const hostHeader = context.req.header("host");
    const host = URL.parse(`http://${hostHeader}`)?.hostname;
    if (!hostHeader || !host) {
      return context.json({ error: "A valid Host header is required" }, 400);
    }
    if (!allowedHosts.has(host)) return context.json({ error: `Host ${host} is not allowed` }, 403);
    // Cross-site requests (CSRF): a page on another site can submit forms here without asking.
    // Browsers name the requesting page's origin; it must be this server as addressed.
    const origin = context.req.header("origin");
    if (origin !== undefined && origin !== `http://${hostHeader}`) {
      return context.json({ error: `Origin ${origin} is not allowed` }, 403);
    }
    const fetchSite = context.req.header("sec-fetch-site");
    if (fetchSite === "cross-site" || fetchSite === "same-site") {
      return context.json({ error: "Cross-site requests are not allowed" }, 403);
    }
    // Forms can't send JSON, so this also stops browsers that send neither header.
    if (
      WRITE_METHODS.has(context.req.method) &&
      context.req.path.startsWith("/api/") &&
      context.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
        "application/json"
    ) {
      return context.json({ error: "Requests that change state must be application/json" }, 415);
    }
    // Mastra also reads `runId[k]=v` as a runId (`{"k":"v"}`), past the start guard's view.
    if ([...new URL(context.req.url).searchParams.keys()].some((key) => key.startsWith("runId["))) {
      return context.json({ error: "runId must be a single value" }, 400);
    }
    return next();
  });
  app.get("/health", async (context) => {
    const database = await databaseCheck();
    const ready = database.status === "ok" && faceModels.status === "ok";
    // A failed restart sweep leaves new Runs working: visible, but still healthy (200).
    const status = !ready ? "unavailable" : restarts.status === "failed" ? "degraded" : "ok";
    return context.json({ status, checks: { database, faceModels, restarts } }, ready ? 200 : 503);
  });
  app.use("/api/*", async (context, next) => {
    if (faceModels.status === "ok") return next();
    const reason =
      faceModels.status === "failed"
        ? `the face models failed (retrying): ${faceModels.error}`
        : "the face models aren't verified yet";
    return context.json({ error: `Not ready: ${reason}; see /health` }, 503);
  });
  app.use("/api/workflows/*", startGuard(runStatus));
  const listen = async () => {
    await new RunRoutesServer({ app, mastra }).init();
    return Bun.serve({
      hostname,
      port,
      fetch: app.fetch,
      // A Run started with `start-async` answers only when it ends, minutes later.
      idleTimeout: 0,
    });
  };
  const server = await listen().catch(async (error: unknown) => {
    await close().catch((cleanupError: unknown) => attachCleanupError(error, cleanupError));
    throw error;
  });

  const stopping = new AbortController();
  /**
   * Brings the prices up to date now and every `priceRefreshIntervalMs` until the
   * server stops; one refresh at a time, never blocking boot. A failed refresh
   * is logged and the existing cache (or the bundled snapshot) keeps serving.
   */
  const pricesRefreshed = (async () => {
    const { ensurePricesFresh } = models;
    if (!ensurePricesFresh) return;
    while (!stopping.signal.aborted) {
      try {
        const { refreshed, fetchedAt } = await ensurePricesFresh({ signal: stopping.signal });
        log({ event: "prices-fresh", refreshed, fetchedAt: fetchedAt.toISOString() });
      } catch (error) {
        if (stopping.signal.aborted) break;
        log({ warning: `Price refresh failed, keeping the current prices: ${errorChain(error)}` });
      }
      await sleep(priceRefreshIntervalMs, stopping.signal);
    }
  })();
  /** Downloads that stopping the server or a stall aborts, so no temp file is left open. */
  const download: Fetch = async (url, init) => {
    const signal = init?.signal ? AbortSignal.any([stopping.signal, init.signal]) : stopping.signal;
    signal.throwIfAborted();
    // Settles on either abort, even when an injected `fetchModels` ignores the signal, so
    // no stalled attempt keeps a listener on the server-lifetime stop signal.
    const { promise: aborted, reject } = Promise.withResolvers<never>();
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    const fetching = Promise.try(() => (fetchModels ?? fetch)(url, { signal }));
    try {
      return await Promise.race([fetching, aborted]);
    } catch (error) {
      // Nobody else sees a response that arrives after the abort: free its connection.
      fetching.then(
        (late) => late.body?.cancel().catch(() => undefined),
        () => undefined,
      );
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  };
  /**
   * Retries until the face models verify (true) or the server stops (false).
   * Failures that won't heal by themselves (a present file with the wrong hash,
   * an unwritable volume) retry too, at the capped interval: the operator fixes
   * the volume and the server picks it up without a restart.
   */
  const modelsReady = (async () => {
    for (let delay = Math.max(modelsRetryMs, 1); !stopping.signal.aborted;) {
      try {
        // FaceNet is built locally for the eval harness only (ADR-0011).
        const lock = readModelLock();
        const ensured = await ensureModels({
          lock,
          directory: modelsDirectory(dataDirectory),
          ids: downloadableModelIds(lock),
          fetch: download,
        });
        faceModels = { status: "ok" };
        log({
          event: "face-models-verified",
          models: ensured.map(({ id, downloaded }) => ({ id, downloaded })),
        });
        return true;
      } catch (error) {
        if (stopping.signal.aborted) break;
        faceModels = { status: "failed", error: errorChain(error) };
        log({
          error: `Face models unavailable: ${errorChain(error)}`,
          retryInSeconds: delay / 1000,
          note: "No Run starts or restarts until they are verified",
        });
        await sleep(delay, stopping.signal);
        delay = nextModelsRetryMs(delay);
      }
    }
    return false;
  })();
  const booted = (async () => {
    if (!(await modelsReady)) return;
    const runIds = await listActiveRuns(async () =>
      (await mastra.listActiveWorkflowRuns()).runs.map(({ runId }) => runId),
    );
    if (stopping.signal.aborted) return;
    restarts = { status: "ok" };
    if (runIds.length === 0) return;
    log({ event: "restarting-active-runs", runIds });
    // Mastra logs (through JsonLineLogger) each Run that fails to restart.
    await mastra.restartAllActiveWorkflowRuns();
  })().catch((error: unknown) => {
    // Closing storage under a restart in progress fails it; that is the stop, not a fault.
    if (stopping.signal.aborted) return;
    restarts = { status: "failed", error: errorChain(error) };
    log({ error: `Restarting the active Runs failed: ${errorChain(error)}` });
  });

  log({ event: "listening", url: server.url.href });
  return {
    url: server.url,
    booted,
    stop: async () => {
      stopping.abort();
      await server.stop(true);
      await modelsReady;
      await pricesRefreshed;
      await close();
    },
  };
}

if (import.meta.main) {
  try {
    const server = await startServer(serverConfig());
    let stopping = false;
    const shutdown = async (signal: string) => {
      if (stopping) return;
      stopping = true;
      process.stderr.write(jsonLine({ event: "stopping", signal }));
      try {
        await server.stop();
      } catch (error) {
        process.stderr.write(errorLine(error));
        process.exitCode = 1;
      }
      process.exit();
    };
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
  } catch (error) {
    process.stderr.write(errorLine(error));
    process.exitCode = 1;
  }
}
