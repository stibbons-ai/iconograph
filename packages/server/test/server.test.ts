import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { copyFile, mkdir, rm, symlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  modelsDirectory,
  NativeImageModels,
  readModelLock,
  runsDatabase,
} from "@iconograph/adapters";
import {
  DEFAULT_JUDGE,
  DEFAULT_OPTIMIZER,
  DEFAULT_STOP_RULES,
  DEFAULT_TARGET_LOOK,
  type ImageModels,
  type Judges,
  type Optimizers,
  type RunRequest,
} from "@iconograph/domain";
import { Effect, type Layer } from "effect";
import {
  corruptAllWeights,
  dataVolume,
  missingWeights,
  verifiedModelsDirectory,
} from "../../adapters/test/face-models";
import { temporaryDirectories } from "../../adapters/test/temporary-directory";
import { until } from "../../adapters/test/until";
import { readRunReport } from "../src";
import {
  allowedHostnames,
  isLoopbackHost,
  MOUNTED_ROUTES,
  nextModelsRetryMs,
  type RunningServer,
  type ServerDependencies,
  serverConfig,
  startServer,
} from "../src/server";
import { MastraJudges } from "../src/judge";
import { faceFixture, fakeImageModels, subjectPhotos } from "./support/fake-image-models";
import { FAKE_VERDICT, fakeJudges } from "./support/fake-judges";
import { fakeOptimizers } from "./support/fake-optimizers";
import { fakeVendorServer, vendorAnswer } from "./support/fake-vendors";

const temporaryDirectory = temporaryDirectories("server");
const SFACE_IDS = ["yunet", "sface"];

const running: RunningServer[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.stop()));
});

/** A data volume with the verified weights linked in and the Subject's photos under `photos/`. */
async function volumeWithPhotos() {
  const data = await dataVolume(temporaryDirectory, SFACE_IDS);
  await mkdir(join(data, "photos"));
  for (const photo of subjectPhotos) await copyFile(photo, join(data, "photos", basename(photo)));
  return data;
}

const photosInVolume = subjectPhotos.map((photo) => `photos/${basename(photo)}`);

/**
 * The server in-process on a free port (loopback unless `hostname`), with the
 * given Image Models, Judges (default: the fake Judge) and Optimizers
 * (default: the fake Optimizer).
 */
async function serve(
  dataDirectory: string,
  imageModels: Layer.Layer<ImageModels>,
  options: Pick<
    ServerDependencies,
    "modelsRetryMs" | "databaseProbe" | "sleep" | "listActiveRuns" | "lookupRun"
  > & {
    /** `null`: the production download (global `fetch`). */
    fetchModels?: ((url: string) => Promise<Response>) | null;
    hostname?: string;
    judges?: Layer.Layer<Judges>;
    optimizers?: Layer.Layer<Optimizers>;
  } = {},
) {
  const {
    fetchModels,
    hostname,
    judges = fakeJudges().layer,
    optimizers = fakeOptimizers().layer,
    ...seams
  } = options;
  const logs: Record<string, unknown>[] = [];
  const waiters: { matches: (line: Record<string, unknown>) => boolean; resolve: () => void }[] =
    [];
  /** Resolves once a log line matching `matches` has been written. */
  const logged = (matches: (line: Record<string, unknown>) => boolean) => {
    if (logs.some(matches)) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    waiters.push({ matches, resolve });
    return promise;
  };
  const server = await startServer(
    serverConfig({
      ICONOGRAPH_DATA_DIR: dataDirectory,
      ICONOGRAPH_PORT: "0",
      ...(hostname && { ICONOGRAPH_HOST: hostname }),
    }),
    {
      vendors: async () => ({ imageModels, judges, optimizers, close: () => {} }),
      retryPolicy: { maxRetries: 2, baseDelayMs: 0 },
      ...seams,
      // Weights are never downloaded in tests; a test that downloads passes its own fetch.
      ...(fetchModels !== null && { fetchModels: fetchModels ?? missingWeights }),
      log: (line) => {
        logs.push(line);
        for (const waiter of waiters) if (waiter.matches(line)) waiter.resolve();
      },
    },
  );
  running.push(server);
  return { server, logs, logged };
}

/** A request to the server as a browser or client would address it. */
const request = (server: RunningServer, path: string, init: RequestInit = {}) =>
  fetch(new URL(path, server.url), init);

/** How many Runs of the Run workflow are stored. */
async function storedRunCount(server: RunningServer) {
  const response = await request(server, "/api/workflows/run/runs");
  // Mastra's list response; only its `total` is read.
  const body = (await response.json()) as { total: number };
  return body.total;
}

/** A Run request; one Iteration per Lane unless `stopRules` says otherwise. */
const runInput = (overrides: Partial<RunRequest> = {}): RunRequest => ({
  photos: photosInVolume,
  faceChoices: [],
  pins: [],
  targetLook: DEFAULT_TARGET_LOOK,
  budgetUsd: 5,
  candidates: 2,
  lanes: [{ model: "gemini-nano-banana-2.1" }],
  judge: DEFAULT_JUDGE,
  optimizer: DEFAULT_OPTIMIZER,
  stopRules: { ...DEFAULT_STOP_RULES, maxIterations: 1 },
  ...overrides,
});

const post = (url: URL, path: string, body: unknown) =>
  fetch(new URL(path, url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** Start a Run through Mastra's mounted route and wait for its end. */
async function startRun(url: URL, inputData: RunRequest) {
  const response = await post(url, "/api/workflows/run/start-async", { inputData });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    status: string;
    result?: { runId: string };
    error?: { message: string };
  };
}

/** A new Run of the Run workflow, created but not started. */
async function createRun(server: RunningServer) {
  const response = await post(server.url, "/api/workflows/run/create-run", {});
  const body = (await response.json()) as { runId: string };
  return body.runId;
}

/** A Run's status as Mastra's run route reports it. */
async function runStatus(server: RunningServer, runId: string) {
  const response = await request(server, `/api/workflows/run/runs/${runId}`);
  const body = (await response.json()) as { status?: string };
  return body.status;
}

describe("serverConfig", () => {
  test("listens on loopback port 4111 by default; host and port come only from explicit settings", () => {
    expect(serverConfig({})).toMatchObject({ hostname: "127.0.0.1", port: 4111 });
    expect(serverConfig({ ICONOGRAPH_HOST: "", ICONOGRAPH_PORT: "" })).toMatchObject({
      hostname: "127.0.0.1",
      port: 4111,
    });
    // Generic HOST/PORT, set by shells and platforms, never widen the bind.
    expect(serverConfig({ HOST: "0.0.0.0", PORT: "80" })).toMatchObject({
      hostname: "127.0.0.1",
      port: 4111,
    });
    expect(serverConfig({ ICONOGRAPH_HOST: "0.0.0.0", ICONOGRAPH_PORT: "8080" })).toMatchObject({
      hostname: "0.0.0.0",
      port: 8080,
    });
    for (const port of ["-1", "65536", "80a", "1e3"]) {
      expect(() => serverConfig({ ICONOGRAPH_PORT: port })).toThrow("ICONOGRAPH_PORT");
    }
  });
});

describe("HTTP server with the fake Image Model", () => {
  test("binds 127.0.0.1, reports ready, and answers only requests addressed to a loopback name", async () => {
    const data = await volumeWithPhotos();
    const { server, logs } = await serve(data, fakeImageModels([]).layer);
    await server.booted;
    expect(server.url.hostname).toBe("127.0.0.1");
    const health = await fetch(new URL("/health", server.url));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      status: "ok",
      checks: {
        database: { status: "ok" },
        faceModels: { status: "ok" },
        restarts: { status: "ok" },
      },
    });
    expect(logs.some((line) => "warning" in line)).toBe(false);

    // A page on another site that rebinds its name to 127.0.0.1 is refused (DNS rebinding).
    const rebound = await fetch(new URL("/api/workflows", server.url), {
      headers: { host: `attacker.example:${server.url.port}` },
    });
    expect(rebound.status).toBe(403);
    const local = await fetch(new URL("/api/workflows", server.url), {
      headers: { host: `localhost:${server.url.port}` },
    });
    expect(local.status).toBe(200);
    expect(Object.keys(await local.json())).toContain("run");
  }, 30_000);

  test("is unavailable while face models download into the data volume, then ready", async () => {
    const data = await temporaryDirectory();
    const verified = await verifiedModelsDirectory(SFACE_IDS);
    const files = new Map(readModelLock().models.map(({ url, file }) => [url, file]));
    const { promise: release, resolve } = Promise.withResolvers<void>();
    const downloaded: string[] = [];
    const { server } = await serve(data, fakeImageModels([]).layer, {
      fetchModels: async (url) => {
        await release;
        downloaded.push(url);
        return new Response(Bun.file(join(verified, files.get(url)!)));
      },
    });

    const pending = await fetch(new URL("/health", server.url));
    expect(pending.status).toBe(503);
    expect(await pending.json()).toMatchObject({
      status: "unavailable",
      checks: { database: { status: "ok" }, faceModels: { status: "pending" } },
    });
    // No Run can start before the face models are verified.
    const early = await post(server.url, "/api/workflows/run/start-async", {
      inputData: runInput(),
    });
    expect(early.status).toBe(503);

    resolve();
    await server.booted;
    expect((await fetch(new URL("/health", server.url))).status).toBe(200);
    // Only the downloadable models; FaceNet is built locally for the eval harness (ADR-0011).
    expect(downloaded).toHaveLength(2);
    for (const { id, file, sha256 } of readModelLock().models) {
      const stored = Bun.file(join(modelsDirectory(data), file));
      if (id === "facenet") {
        expect(await stored.exists()).toBe(false);
        continue;
      }
      expect(Bun.CryptoHasher.hash("sha256", await stored.bytes(), "hex")).toBe(sha256);
    }
  }, 30_000);

  test("stays unavailable with the reason while the face models fail verification", async () => {
    const data = await temporaryDirectory();
    await corruptAllWeights(data);
    const { server, logged } = await serve(data, fakeImageModels([]).layer);
    await logged((line) => String(line.error).startsWith("Face models unavailable"));
    const health = await request(server, "/health");
    expect(health.status).toBe(503);
    const body = (await health.json()) as { checks: { faceModels: { error: string } } };
    expect(body.checks.faceModels.error).toContain("failed SHA-256 verification");
    const api = await request(server, "/api/workflows");
    expect(api.status).toBe(503);
    expect(await api.text()).toContain("failed SHA-256 verification");
  }, 30_000);

  /** Weights served from the verified folder; the first `failures` downloads fail. */
  async function flakyDownloads(failures: number) {
    const verified = await verifiedModelsDirectory(SFACE_IDS);
    const files = new Map(readModelLock().models.map(({ url, file }) => [url, file]));
    let calls = 0;
    return async (url: string) => {
      if (calls++ < failures) throw new Error("network down");
      return new Response(Bun.file(join(verified, files.get(url)!)));
    };
  }

  test("waits between face-model attempts, doubling the delay, until they verify", async () => {
    const data = await temporaryDirectory();
    const waits: number[] = [];
    const { server, logs } = await serve(data, fakeImageModels([]).layer, {
      modelsRetryMs: 10,
      sleep: async (ms) => {
        waits.push(ms);
      },
      fetchModels: await flakyDownloads(3),
    });
    await server.booted;
    expect((await request(server, "/health")).status).toBe(200);
    expect(waits).toEqual([10, 20, 40]);
    const failures = logs.filter((line) => "error" in line);
    expect(failures.map(({ retryInSeconds }) => retryInSeconds)).toEqual([0.01, 0.02, 0.04]);
    for (const { error } of failures) expect(String(error)).toContain("network down");
    expect(logs.at(-1)?.event).toBe("face-models-verified");
  }, 30_000);

  test("the retry delay starts at 1 ms at least and stops growing at 5 minutes", async () => {
    for (const [first, expected] of [
      [0, [1, 2, 4]],
      [200_000, [200_000, 300_000, 300_000]],
    ] as const) {
      const waits: number[] = [];
      const { server } = await serve(await temporaryDirectory(), fakeImageModels([]).layer, {
        modelsRetryMs: first,
        sleep: async (ms) => {
          waits.push(ms);
        },
        fetchModels: await flakyDownloads(3),
      });
      await server.booted;
      expect(waits).toEqual([...expected]);
    }
    expect(nextModelsRetryMs(5_000)).toBe(10_000);
    expect(nextModelsRetryMs(300_000)).toBe(300_000);
  }, 30_000);

  test("stopping while waiting to retry ends at once", async () => {
    const data = await temporaryDirectory();
    const { server, logged } = await serve(data, fakeImageModels([]).layer, {
      modelsRetryMs: 60_000,
      fetchModels: async () => {
        throw new Error("network down");
      },
    });
    running.splice(running.indexOf(server), 1);
    await logged((line) => String(line.error).startsWith("Face models unavailable"));
    const started = performance.now();
    await server.stop();
    expect(performance.now() - started).toBeLessThan(1_000);
  }, 30_000);

  test("stopping during a stalled download ends at once, without a boot failure", async () => {
    const data = await temporaryDirectory();
    const { promise: called, resolve } = Promise.withResolvers<void>();
    const { server, logs } = await serve(data, fakeImageModels([]).layer, {
      fetchModels: () => {
        resolve();
        return new Promise<Response>(() => {});
      },
    });
    running.splice(running.indexOf(server), 1);
    await called;
    await server.stop();
    expect(logs.filter((line) => "error" in line)).toEqual([]);
  }, 30_000);

  test("the production download carries the stop signal", async () => {
    const data = await temporaryDirectory();
    const signals: (AbortSignal | null | undefined)[] = [];
    const realFetch = globalThis.fetch;
    // A network that never answers; only the signal ends the request.
    globalThis.fetch = Object.assign(
      (_: unknown, init?: RequestInit) => {
        signals.push(init?.signal);
        const { promise, reject } = Promise.withResolvers<Response>();
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        return promise;
      },
      { preconnect: realFetch.preconnect },
    );
    try {
      const { server } = await serve(data, fakeImageModels([]).layer, { fetchModels: null });
      running.splice(running.indexOf(server), 1);
      await until(async () => signals.length > 0);
      await server.stop();
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(signals[0]?.aborted).toBe(true);
  }, 30_000);

  test("reports the database as failed when the Run database can't be read", async () => {
    const data = await volumeWithPhotos();
    const { server } = await serve(data, fakeImageModels([]).layer);
    await server.booted;
    expect((await request(server, "/health")).status).toBe(200);
    // Another connection drops the table the health query reads: the real query now fails.
    const database = new Database(runsDatabase(data));
    database.run("DROP TABLE mastra_workflow_snapshot");
    database.close();
    const health = await request(server, "/health");
    expect(health.status).toBe(503);
    expect(await health.json()).toEqual({
      status: "unavailable",
      checks: {
        database: {
          status: "failed",
          error: "SQLITE_ERROR: no such table: mastra_workflow_snapshot",
        },
        faceModels: { status: "ok" },
        restarts: { status: "ok" },
      },
    });
  }, 30_000);

  test("a failed restart sweep shows in /health without making the server unhealthy", async () => {
    const data = await volumeWithPhotos();
    const { server, logs } = await serve(data, fakeImageModels([]).layer, {
      listActiveRuns: async () => {
        throw new Error("listing failed", { cause: new Error("disk I/O error") });
      },
    });
    await server.booted;
    const health = await request(server, "/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      status: "degraded",
      checks: {
        database: { status: "ok" },
        faceModels: { status: "ok" },
        restarts: { status: "failed", error: "listing failed: disk I/O error" },
      },
    });
    expect(logs.at(-1)).toEqual({
      error: "Restarting the active Runs failed: listing failed: disk I/O error",
    });
  }, 30_000);

  test("a Run Mastra fails to restart shows in /health", async () => {
    const data = await volumeWithPhotos();
    const { server } = await serve(data, fakeImageModels([]).layer);
    await server.booted;
    const runId = await createRun(server);
    await server.stop();
    running.splice(running.indexOf(server), 1);
    // An "active" Run whose stored state can't be restarted: Mastra only logs that.
    const database = new Database(runsDatabase(data));
    database.run(
      "UPDATE mastra_workflow_snapshot SET snapshot = jsonb_patch(snapshot, ?) WHERE run_id = ?",
      [JSON.stringify({ status: "running", context: null }), runId],
    );
    database.close();
    const { server: next } = await serve(data, fakeImageModels([]).layer);
    await next.booted;
    const health = await request(next, "/health");
    expect(health.status).toBe(200);
    const body = (await health.json()) as { status: string; checks: { restarts: unknown } };
    expect(body.status).toBe("degraded");
    expect(body.checks.restarts).toEqual({
      status: "failed",
      error: expect.stringContaining(`Run ${runId}: `),
    });
  }, 30_000);

  test("no Run restarts once the server is stopping", async () => {
    const data = await volumeWithPhotos();
    const { promise: listing, resolve: listed } = Promise.withResolvers<void>();
    const { promise: hold, resolve: release } = Promise.withResolvers<void>();
    const { server, logs } = await serve(data, fakeImageModels([]).layer, {
      listActiveRuns: async () => {
        listed();
        await hold;
        return ["an-active-run"];
      },
    });
    running.splice(running.indexOf(server), 1);
    await listing;
    const stopped = server.stop();
    release();
    await stopped;
    await server.booted;
    expect(logs.some((line) => line.event === "restarting-active-runs")).toBe(false);
  }, 30_000);

  test("a listing that fails because the server stopped is no boot failure", async () => {
    const data = await volumeWithPhotos();
    const { promise: listing, resolve: listed } = Promise.withResolvers<void>();
    const { promise: hold, reject: fail } = Promise.withResolvers<never>();
    const { server, logs } = await serve(data, fakeImageModels([]).layer, {
      listActiveRuns: async () => {
        listed();
        return hold;
      },
    });
    running.splice(running.indexOf(server), 1);
    await listing;
    const stopped = server.stop();
    fail(new Error("storage closed"));
    await stopped;
    await server.booted;
    expect(logs.filter((line) => "error" in line)).toEqual([]);
  }, 30_000);

  test("the production wait between face-model attempts really waits", async () => {
    const data = await temporaryDirectory();
    const download = await flakyDownloads(2);
    const attempts: number[] = [];
    const { server } = await serve(data, fakeImageModels([]).layer, {
      modelsRetryMs: 20,
      fetchModels: (url) => {
        attempts.push(performance.now());
        return download(url);
      },
    });
    await server.booted;
    // Each failed attempt fails on its first file, so the gaps between attempts are the waits:
    // 20 ms, then 40 ms (a timer can fire a little early, never much).
    const [first, second, third] = attempts as [number, number, number];
    expect(second - first).toBeGreaterThanOrEqual(18);
    expect(third - second).toBeGreaterThanOrEqual(38);
  }, 30_000);

  test("mounts exactly the Run routes of Mastra's API", async () => {
    expect(MOUNTED_ROUTES.map(([method, path]) => `${method} ${path}`)).toEqual([
      "GET /workflows",
      "GET /workflows/:workflowId",
      "GET /workflows/:workflowId/runs",
      "GET /workflows/:workflowId/runs/:runId",
      "POST /workflows/:workflowId/create-run",
      "POST /workflows/:workflowId/start-async",
      "POST /workflows/:workflowId/stream",
      "POST /workflows/:workflowId/observe",
      "POST /workflows/:workflowId/runs/:runId/cancel",
    ]);
    const data = await volumeWithPhotos();
    const { server } = await serve(data, fakeImageModels([]).layer);
    await server.booted;
    const json = (method: string, path: string) =>
      request(server, path, {
        method,
        headers: { "content-type": "application/json" },
        ...(method !== "GET" && { body: "{}" }),
      });
    const runId = await createRun(server);
    for (const [method, path] of [
      ["POST", `/api/workflows/run/start?runId=${runId}`],
      ["POST", `/api/workflows/run/runs/${runId}/steps/execute`],
      ["POST", "/api/workflows/events"],
      ["POST", "/api/workflows/run/restart-all-active-workflow-runs"],
      ["POST", "/api/workflows/run/restart"],
      ["POST", "/api/workflows/run/restart-async"],
      ["POST", "/api/workflows/run/time-travel"],
      ["POST", "/api/workflows/run/stream-legacy"],
      ["POST", "/api/workflows/run/resume"],
      ["POST", "/api/workflows/run/resume-async"],
      ["POST", "/api/workflows/run/resume-stream"],
      ["DELETE", `/api/workflows/run/runs/${runId}`],
      ["GET", "/api/agents"],
      ["POST", "/api/stored/agents"],
    ] as const) {
      const response = await json(method, path);
      // Hono's own 404, not a mounted Mastra handler answering "not found".
      expect({ path, status: response.status, body: await response.text() }).toEqual({
        path,
        status: 404,
        body: "404 Not Found",
      });
    }
    // The Run the DELETE named is still there.
    expect((await json("GET", `/api/workflows/run/runs/${runId}`)).status).toBe(200);
    // Mastra would read `runId[x]=y` as the runId `{"x":"y"}`, past the start guard.
    const shaped = await post(server.url, "/api/workflows/run/start-async?runId[x]=y", {});
    expect(shaped.status).toBe(400);
    expect(await shaped.json()).toEqual({ error: "runId must be a single value" });
  }, 30_000);

  test("a Run is streamed, observed and cancelled mid-loop through the mounted routes; its Lane says cancelled", async () => {
    const data = await volumeWithPhotos();
    const { promise: hold, resolve: release } = Promise.withResolvers<void>();
    // The second Iteration's image call answers only when aborted, or when the test ends.
    const fake = fakeImageModels(["same", "same"], {
      beforeAnswer: async (call) => {
        if (call === 1) await hold;
      },
    });
    const { server } = await serve(data, fake.layer);
    await server.booted;
    const runId = await createRun(server);
    const streamed = await post(server.url, `/api/workflows/run/stream?runId=${runId}`, {
      inputData: runInput({ candidates: 1, stopRules: DEFAULT_STOP_RULES }),
    });
    expect(streamed.status).toBe(200);
    await until(async () => fake.requests.length === 2, { timeoutMs: 20_000 });
    const observed = await post(server.url, `/api/workflows/run/observe?runId=${runId}`, {});
    expect(observed.status).toBe(200);
    const cancelled = await post(server.url, `/api/workflows/run/runs/${runId}/cancel`, {});
    expect(cancelled.status).toBe(200);
    await until(async () => (await runStatus(server, runId)) === "canceled", { timeoutMs: 10_000 });
    // The stored state: the Lane stopped as cancelled in its second Iteration, whose aborted call
    // was settled as sent, at unknown cost.
    const stored = () => readRunReport(runsDatabase(data), data, runId);
    // The Lane's row, not the report (which also shows a Run Mastra cancelled as cancelled).
    const storedStopReason = () => {
      const db = new Database(runsDatabase(data), { readonly: true });
      try {
        return db
          .query<{ stop_reason: string | null }, [string]>(
            "SELECT stop_reason FROM lanes WHERE run_id = ?",
          )
          .get(runId)?.stop_reason;
      } finally {
        db.close();
      }
    };
    await until(
      async () =>
        storedStopReason() === "cancelled" &&
        (await stored()).unattributedCalls[0]?.settled === true,
      { timeoutMs: 10_000 },
    );
    const report = await stored();
    expect(report.lanes[0]!.prompts.map(({ source }) => source)).toEqual(["initial", "optimizer"]);
    expect(report.unattributedCalls).toEqual([
      expect.objectContaining({
        iteration: 2,
        settled: true,
        result: "transient",
        actualUsd: null,
      }),
    ]);
    release();
    await Promise.all([streamed.body?.cancel(), observed.body?.cancel()]);
  }, 60_000);

  test("a refused start, by status or inside the stream, can be retried", async () => {
    const data = await volumeWithPhotos();
    const { server } = await serve(data, fakeImageModels(["same"]).layer);
    await server.booted;
    const runId = await createRun(server);
    const start = (route: string, inputData: unknown) =>
      post(server.url, `/api/workflows/run/${route}?runId=${runId}`, { inputData });
    // start-async checks the input before answering.
    expect((await start("start-async", { photos: [] })).status).toBe(400);
    // stream answers 200 and reports the refused input inside the stream.
    const refused = await start("stream", { photos: [] });
    expect(refused.status).toBe(200);
    expect(await refused.text()).toContain("Invalid input data");
    expect(await runStatus(server, runId)).toBe("pending");
    // Mastra streams a Run object once, so the retry starts it with start-async.
    const valid = await start("start-async", runInput({ candidates: 1 }));
    expect(valid.status).toBe(200);
    expect(((await valid.json()) as { status: string }).status).toBe("success");
  }, 60_000);

  test("a lookup that fails answers JSON, is logged, and leaves the Run startable", async () => {
    const data = await volumeWithPhotos();
    let failNext = true;
    const { server, logs } = await serve(data, fakeImageModels(["same"]).layer, {
      lookupRun: async (lookup) => {
        if (failNext) {
          failNext = false;
          throw new Error("lookup failed", { cause: new Error("SQLITE_BUSY") });
        }
        return lookup();
      },
    });
    await server.booted;
    const runId = await createRun(server);
    const start = () =>
      post(server.url, `/api/workflows/run/start-async?runId=${runId}`, {
        inputData: runInput({ candidates: 1 }),
      });
    const failed = await start();
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "lookup failed: SQLITE_BUSY" });
    expect(logs.at(-1)).toEqual({
      error: "POST /api/workflows/run/start-async failed: lookup failed: SQLITE_BUSY",
    });
    const retried = await start();
    expect(retried.status).toBe(200);
    expect(((await retried.json()) as { status: string }).status).toBe("success");
  }, 60_000);

  test("a started Run can't be started again, even by two requests at once", async () => {
    const data = await volumeWithPhotos();
    const { promise: hold, resolve: release } = Promise.withResolvers<void>();
    let prepares = 0;
    const fake = fakeImageModels(["same"], {
      beforeAnswer: () => hold,
      // `prepare` asks for the model without a price; `generate` with the recorded one.
      beforeGet: (price) => {
        if (price === undefined) prepares++;
      },
    });
    // The first start's lookup answers only once the second request has looked up too (or
    // been answered without a lookup): both see the Run `pending` unless the claim stops one.
    let lookups = 0;
    const { promise: firstLooking, resolve: firstLooks } = Promise.withResolvers<void>();
    const { promise: secondDone, resolve: secondFinishes } = Promise.withResolvers<void>();
    const { server } = await serve(data, fake.layer, {
      lookupRun: async (lookup) => {
        const call = ++lookups;
        const result = await lookup();
        if (call === 1) {
          firstLooks();
          await secondDone;
        }
        if (call === 2) secondFinishes();
        return result;
      },
    });
    await server.booted;
    const runId = await createRun(server);
    const start = (route: string, url: URL = server.url) =>
      post(url, `/api/workflows/run/${route}?runId=${runId}`, {
        inputData: runInput({ candidates: 1 }),
      });
    const first = start("stream");
    await firstLooking;
    const second = await start("stream");
    secondFinishes();
    const statuses = [(await first).status, second.status];
    expect(statuses).toEqual([200, 409]);
    await until(async () => fake.requests.length === 1, { timeoutMs: 20_000 });
    for (const route of ["start-async", "stream"]) {
      expect({ route, status: (await start(route)).status }).toEqual({ route, status: 409 });
    }
    expect(await runStatus(server, runId)).toBe("running");
    release();
    await until(async () => (await runStatus(server, runId)) === "success", { timeoutMs: 20_000 });
    expect(prepares).toBe(1);

    // A later server process knows the Run only from storage, and refuses it too.
    await server.stop();
    running.splice(running.indexOf(server), 1);
    const { server: next } = await serve(data, fakeImageModels([]).layer);
    await next.booted;
    const again = await start("start-async", next.url);
    expect(again.status).toBe(409);
    expect(await again.text()).toContain("already started (success)");
    expect(await runStatus(next, runId)).toBe("success");
  }, 60_000);

  test("refuses cross-site requests and non-JSON writes; same-origin and plain clients pass", async () => {
    const data = await volumeWithPhotos();
    const { server } = await serve(data, fakeImageModels([]).layer);
    await server.booted;
    // A form another site's page submits: multipart, so no CORS preflight.
    const form = new FormData();
    form.set("inputData", JSON.stringify(runInput()));
    for (const headers of [
      { origin: "https://evil.example" },
      { origin: "null" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      {},
    ]) {
      const response = await request(server, "/api/workflows/run/create-run", {
        method: "POST",
        headers,
        body: form,
      });
      expect(response.status).toBe("origin" in headers || "sec-fetch-site" in headers ? 403 : 415);
    }
    const plain = await request(server, "/api/workflows/run/create-run", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    expect(plain.status).toBe(415);
    // Writes by any method need JSON, a DELETE without a body included.
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const write = await request(server, "/api/workflows/run/create-run", { method });
      expect({ method, status: write.status }).toEqual({ method, status: 415 });
    }
    expect(await storedRunCount(server)).toBe(0);
    // Reads from another site are refused too (defence in depth: no CORS header is sent).
    const crossRead = await request(server, "/api/workflows/run/runs", {
      headers: { origin: "https://evil.example" },
    });
    expect(crossRead.status).toBe(403);

    // The server's own pages (same origin, as addressed) and clients without Origin.
    const sameOrigin = await request(server, "/api/workflows/run/create-run", {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        origin: `http://localhost:${server.url.port}`,
        host: `localhost:${server.url.port}`,
        "sec-fetch-site": "same-origin",
      },
      body: "{}",
    });
    expect(sameOrigin.status).toBe(200);
    const client = await post(server.url, "/api/workflows/run/create-run", {});
    expect(client.status).toBe(200);
    // Media types are case-insensitive.
    const upper = await request(server, "/api/workflows/run/create-run", {
      method: "POST",
      headers: { "content-type": "Application/JSON" },
      body: "{}",
    });
    expect(upper.status).toBe(200);
    expect(await storedRunCount(server)).toBe(3);
  }, 30_000);

  test("a request without a Host header is a client error", async () => {
    const data = await volumeWithPhotos();
    const { server } = await serve(data, fakeImageModels([]).layer);
    const { promise: reply, resolve } = Promise.withResolvers<string>();
    let text = "";
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port: Number(server.url.port),
      socket: {
        data: (_, chunk) => {
          text += chunk.toString();
        },
        close: () => resolve(text),
      },
    });
    socket.write("GET /health HTTP/1.0\r\n\r\n");
    expect((await reply).split("\r\n", 1)[0]).toBe("HTTP/1.1 400 Bad Request");
  }, 30_000);
});

describe("network exposure", () => {
  test("the allowed Host names: loopback, plus the configured host as URLs spell it", () => {
    const loopback = ["localhost", "127.0.0.1", "[::1]"];
    expect([...allowedHostnames("127.0.0.1")].sort()).toEqual([...loopback].sort());
    // A wildcard bind never widens the list: requests must still name loopback.
    for (const wildcard of ["0.0.0.0", "::", "[::]"]) {
      expect([...allowedHostnames(wildcard)].sort()).toEqual([...loopback].sort());
    }
    expect(allowedHostnames("MyBox.lan").has("mybox.lan")).toBe(true);
    expect(allowedHostnames("fd00:0::1").has("[fd00::1]")).toBe(true);
    expect(allowedHostnames("192.168.1.5").has("192.168.1.5")).toBe(true);
  });

  test("a wildcard bind warns at boot and still answers only loopback names", async () => {
    const data = await volumeWithPhotos();
    const { server, logs } = await serve(data, fakeImageModels([]).layer, { hostname: "0.0.0.0" });
    await server.booted;
    expect(String(logs.find((line) => "warning" in line)?.warning)).toContain(
      "Listening on 0.0.0.0, beyond loopback, without authentication",
    );
    const port = new URL(server.url).port;
    const at = (host: string) =>
      fetch(`http://127.0.0.1:${port}/health`, { headers: { host } }).then(({ status }) => status);
    expect(await at(`192.168.1.5:${port}`)).toBe(403);
    expect(await at(`attacker.example:${port}`)).toBe(403);
    expect(await at(`[::1]:${port}`)).toBe(200);
    expect(await at(`LOCALHOST:${port}`)).toBe(200);
  }, 30_000);

  test("binding a loopback address, IPv4 or IPv6, isn't warned about; anything else is", () => {
    for (const host of ["127.0.0.1", "127.0.0.2", "localhost", "::1", "[::1]"]) {
      expect({ host, loopback: isLoopbackHost(host) }).toEqual({ host, loopback: true });
    }
    for (const host of ["0.0.0.0", "::", "192.168.1.5", "127.0.0.1.nip.io", "mybox.lan"]) {
      expect({ host, loopback: isLoopbackHost(host) }).toEqual({ host, loopback: false });
    }
  });
});

describe("container health check", () => {
  const healthcheck = fileURLToPath(new URL("../src/healthcheck.ts", import.meta.url));

  /** Run the health check against `port` on loopback; its exit code and stderr. */
  async function check(port: number) {
    const child = Bun.spawn([process.execPath, healthcheck], {
      env: { ...Bun.env, ICONOGRAPH_HOST: "127.0.0.1", ICONOGRAPH_PORT: String(port) },
      stdout: "ignore",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    return { exitCode, stderr };
  }

  test("passes on 200, fails with the URL and reason on 503 or a closed port", async () => {
    let status = 200;
    const stub = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(status === 200 ? "ok" : "models pending", { status }),
    });
    const port = stub.port!;
    const url = `http://127.0.0.1:${port}/health`;
    try {
      expect(await check(port)).toEqual({ exitCode: 0, stderr: "" });
      status = 503;
      expect(await check(port)).toEqual({
        exitCode: 1,
        stderr: `${url} answered 503: models pending\n`,
      });
    } finally {
      await stub.stop(true);
    }
    const closed = await check(port);
    expect(closed.exitCode).toBe(1);
    expect(closed.stderr).toStartWith(`${url}: `);
  }, 30_000);

  test("gives up on a server that never answers after 5 s", async () => {
    const stub = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Promise<Response>(() => {}),
    });
    try {
      const started = performance.now();
      const { exitCode, stderr } = await check(stub.port!);
      expect(exitCode).toBe(1);
      expect(stderr).toStartWith(`http://127.0.0.1:${stub.port}/health: `);
      expect(performance.now() - started).toBeLessThan(8_000);
    } finally {
      await stub.stop(true);
    }
  }, 15_000);
});

describe("HTTP server Runs", () => {
  test("starts a Run through Mastra's workflow route and stores its Candidates", async () => {
    const data = await volumeWithPhotos();
    const fake = fakeImageModels(["same", "different"]);
    const { server } = await serve(data, fake.layer);
    await server.booted;
    const result = await startRun(server.url, runInput());
    expect(result.status).toBe("success");
    const report = await readRunReport(runsDatabase(data), data, result.result!.runId);
    expect(report.lanes[0]!.candidates.map(({ outcome }) => outcome)).toEqual(["Scored", "Gated"]);
    expect(fake.requests).toHaveLength(2);
  }, 60_000);

  test("starts a Run with several Lanes, per-Lane photos and Prompt, and the Judge configured in the body", async () => {
    const data = await volumeWithPhotos();
    const fake = fakeImageModels({
      "gemini-nano-banana-2.1": ["same"],
      "gpt-image-2.5-sunburst": ["same"],
    });
    const judges = fakeJudges();
    const { server } = await serve(data, fake.layer, { judges: judges.layer });
    await server.booted;
    const judge = { ...DEFAULT_JUDGE, model: "openai/gpt-5.5", effort: "medium" as const };
    const result = await startRun(
      server.url,
      runInput({
        candidates: 1,
        lanes: [
          { model: "gemini-nano-banana-2.1", photos: [1] },
          {
            model: "gpt-image-2.5-sunburst",
            photos: [2],
            prompt: "A portrait in soft window light",
          },
        ],
        judge,
      }),
    );
    expect(result.status).toBe("success");
    const report = await readRunReport(runsDatabase(data), data, result.result!.runId);
    expect(report.lanes.map(({ model }) => model)).toEqual([
      "gemini-nano-banana-2.1",
      "gpt-image-2.5-sunburst",
    ]);
    for (const lane of report.lanes) {
      expect(lane.candidates.map(({ outcome }) => outcome)).toEqual(["Scored"]);
    }
    expect(fake.requests.find(({ model }) => model === "gpt-image-2.5-sunburst")!.prompt).toBe(
      "A portrait in soft window light",
    );
    // Every Judge the engine got was the body's.
    expect(judges.gets.length).toBeGreaterThan(0);
    for (const { judge: got } of judges.gets) {
      expect({ model: got.model, effort: got.effort }).toEqual({
        model: judge.model,
        effort: judge.effort,
      });
    }
    expect(judges.requests).toHaveLength(2);
    // A Lane's photo numbers must exist among the Run's (confined) photos.
    const outside = await post(server.url, "/api/workflows/run/start-async", {
      inputData: runInput({ lanes: [{ model: "gemini-nano-banana-2.1", photos: [3] }] }),
    });
    expect(outside.status).toBe(400);
  }, 60_000);

  test("an API request without retouching gets none, and a Target Look key that is no facet is refused", async () => {
    const data = await volumeWithPhotos();
    const fake = fakeImageModels({ "gemini-nano-banana-2.1": ["same"] });
    const { server } = await serve(data, fake.layer);
    await server.booted;
    const { retouching: _, ...sixFacets } = DEFAULT_TARGET_LOOK;
    // A misspelled `retouching` must not pass as a missing one.
    const misspelled = await post(server.url, "/api/workflows/run/start-async", {
      inputData: { ...runInput(), targetLook: { ...sixFacets, retoucing: "none" } },
    });
    expect(misspelled.status).toBe(400);
    expect(await misspelled.text()).toContain("Unknown Target Look facet");
    expect(fake.requests).toHaveLength(0);
    const result = await startRun(
      server.url,
      runInput({ candidates: 1, targetLook: sixFacets as RunRequest["targetLook"] }),
    );
    expect(result.status).toBe("success");
    const report = await readRunReport(runsDatabase(data), data, result.result!.runId);
    expect(report.targetLook.retouching).toBe("none");
  }, 60_000);

  test("rejects Reference Photos outside the data volume before the Judge or any Image Model is asked", async () => {
    const data = await volumeWithPhotos();
    const outside = await temporaryDirectory();
    const secret = join(outside, "secret.jpg");
    await copyFile(faceFixture("biden-2013.jpg"), secret);
    // A symlink inside the volume whose target is outside it.
    await symlink(secret, join(data, "photos", "link.jpg"));
    let gets = 0;
    const fake = fakeImageModels([], { beforeGet: () => gets++ });
    const judges = fakeJudges();
    const { server } = await serve(data, fake.layer, { judges: judges.layer });
    await server.booted;
    for (const photo of [secret, "../secret.jpg", "photos/../../secret.jpg", "photos/link.jpg"]) {
      const result = await startRun(server.url, runInput({ photos: [photo] }));
      expect(result.status).toBe("failed");
      expect(result.error!.message).toBe(`${photo} is not a file inside the data volume`);
    }
    const missing = await startRun(server.url, runInput({ photos: ["photos/absent.jpg"] }));
    expect(missing.error!.message).toBe("photos/absent.jpg is not a file inside the data volume");
    expect(judges.gets).toHaveLength(0);
    expect(gets).toBe(0);
    expect(fake.requests).toHaveLength(0);
    // Absolute paths inside the volume are accepted.
    const inside = await startRun(
      server.url,
      runInput({ photos: [join(data, photosInVolume[0]!)], candidates: 1 }),
    );
    expect(inside.status).toBe("failed");
    expect(inside.error!.message).toContain("beyond its script");
  }, 60_000);
});

test("a Run without a vendor key fails cleanly before any billable call or price lookup", async () => {
  const data = await volumeWithPhotos();
  let calls = 0;
  const noPriceLookup = { lookup: () => Effect.die(new Error("no price lookup without a key")) };
  const count = async () => {
    calls++;
    return new Response("{}", { status: 500 });
  };
  const layer = NativeImageModels({
    prices: noPriceLookup,
    env: {},
    geminiFetch: count,
    openaiFetch: count,
  });
  // The Judge's key is checked first.
  const native = await serve(await volumeWithPhotos(), layer, {
    judges: MastraJudges({ prices: noPriceLookup, env: {} }),
  });
  await native.server.booted;
  const withoutJudgeKey = await startRun(native.server.url, runInput());
  expect(withoutJudgeKey.status).toBe("failed");
  expect(withoutJudgeKey.error!.message).toContain("ANTHROPIC_API_KEY is not set");
  // Then every Lane's key, in Lane order.
  const { server } = await serve(data, layer);
  await server.booted;
  const lanes = [{ model: "gpt-image-2.5-sunburst" }, { model: "gemini-nano-banana-2.1" }];
  const result = await startRun(server.url, runInput({ lanes }));
  expect(result.status).toBe("failed");
  expect(result.error!.message).toContain("OPENAI_API_KEY is not set");
  expect(calls).toBe(0);
}, 30_000);

describe("server process", () => {
  const withFakes = fileURLToPath(new URL("./support/run-server-with-fakes.ts", import.meta.url));
  const entrypoint = fileURLToPath(new URL("../src/server.ts", import.meta.url));

  /** The server (by default with fakes) as its own process, so a test can signal or kill it. */
  function spawnServer(data: string, env: Record<string, string>, entry = withFakes) {
    const { GEMINI_API_KEY: _, ...base } = Bun.env;
    const child = Bun.spawn([process.execPath, entry], {
      env: {
        ...base,
        MASTRA_TELEMETRY_DISABLED: "1",
        DO_NOT_TRACK: "1",
        ICONOGRAPH_DATA_DIR: data,
        ICONOGRAPH_PORT: "0",
        // A crashed owner's lease on its Runs lapses after 1 s instead of 15 s.
        MASTRA_AGENT_THREAD_LEASE_TTL_MS: "1000",
        ...env,
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    let text = "";
    const reader = child.stderr.pipeThrough(new TextDecoderStream()).getReader();
    const parsed = () =>
      text
        .split("\n")
        .filter(Boolean)
        .map((value) => JSON.parse(value) as Record<string, unknown>);
    /** Resolves with the first stderr JSON line matching `predicate`. */
    const line = async (predicate: (value: Record<string, unknown>) => boolean) => {
      for (;;) {
        const found = parsed().find(predicate);
        if (found) return found;
        const { value, done } = await reader.read();
        if (done) throw new Error(`The server exited without the expected line:\n${text}`);
        text += value;
      }
    };
    /** The boot events read so far, in order; a model failure as `face-models-unavailable`. */
    const events = () =>
      parsed().flatMap((value) =>
        typeof value.event === "string"
          ? [value.event]
          : String(value.error).startsWith("Face models unavailable")
            ? ["face-models-unavailable"]
            : [],
      );
    return { child, line, events };
  }

  async function runState(url: URL, runId: string) {
    const response = await fetch(new URL(`/api/workflows/run/runs/${runId}`, url));
    return (await response.json()) as { status: string; steps: Record<string, { status: string }> };
  }

  /** Polls another process's state over HTTP: there is no event to await across processes. */
  const untilState = (condition: () => Promise<boolean>, timeoutMs: number) =>
    until(condition, { timeoutMs, intervalMs: 100 });

  test("a Run active in `prepare` at a crash restarts once the face models verify, after a failure", async () => {
    const data = await volumeWithPhotos();
    const crashed = spawnServer(data, { FAKE_HANG_GET: "1" });
    try {
      const { url } = await crashed.line((value) => value.event === "listening");
      const first = new URL(String(url));
      await crashed.line((value) => value.event === "face-models-verified");
      const created = await post(first, "/api/workflows/run/create-run", {});
      const { runId } = (await created.json()) as { runId: string };
      // The stream's response stays open while the Run hangs in `prepare`; the crash ends it.
      void post(first, `/api/workflows/run/stream?runId=${runId}`, {
        inputData: runInput(),
      }).catch(() => undefined);
      await untilState(
        async () => (await runState(first, runId)).steps.prepare?.status === "running",
        10_000,
      );
      crashed.child.kill("SIGKILL");
      await crashed.child.exited;

      // The next boot finds no weights; its first download fails, the retry succeeds.
      await rm(join(data, "models"));
      const restarted = spawnServer(data, {
        FAKE_IMAGE_SCRIPT: JSON.stringify(["same", "same"]),
        FAKE_MODELS_FROM: await verifiedModelsDirectory(SFACE_IDS),
        FAKE_MODELS_FAIL_ONCE: "1",
        FAKE_MODELS_RETRY_MS: "10",
      });
      try {
        const listening = await restarted.line((value) => value.event === "listening");
        const second = new URL(String(listening.url));
        const failed = await restarted.line((value) =>
          String(value.error).startsWith("Face models unavailable"),
        );
        expect(String(failed.error)).toContain("first download fails");
        await restarted.line((value) => value.event === "face-models-verified");
        expect(
          await restarted.line((value) => value.event === "restarting-active-runs"),
        ).toMatchObject({ runIds: [runId] });
        await untilState(async () => (await runState(second, runId)).status === "success", 30_000);
        // No Run restarted before the models verified.
        expect(restarted.events()).toEqual([
          "listening",
          "face-models-unavailable",
          "face-models-verified",
          "restarting-active-runs",
        ]);
      } finally {
        restarted.child.kill();
        await restarted.child.exited;
      }
      const report = await readRunReport(runsDatabase(data), data, runId);
      expect(report.lanes[0]!.candidates.map(({ outcome }) => outcome)).toEqual([
        "Scored",
        "Scored",
      ]);
      // The crash came before any Candidate existed, so the restarted Run made each call once.
      for (const { calls } of report.lanes[0]!.candidates) expect(calls).toHaveLength(1);
      // Two images at $0.08 and two Judge calls at $0.005.
      expect(report.totals.actualUsd).toBe(0.17);
    } finally {
      crashed.child.kill("SIGKILL");
    }
  }, 60_000);

  // End-to-end through the real Judge on a fake Anthropic API; nothing sets Bun's fetch idle
  // timeout.
  test("a Run's Judge sends its key to the Anthropic API, whatever ANTHROPIC_BASE_URL says", async () => {
    const key = "SENTINEL-JUDGE-KEY-0123456789";
    const vendor = fakeVendorServer(() => vendorAnswer("anthropic", JSON.stringify(FAKE_VERDICT)));
    const trap = fakeVendorServer(() => new Response("{}", { status: 500 }));
    const data = await volumeWithPhotos();
    const server = spawnServer(data, {
      FAKE_IMAGE_SCRIPT: JSON.stringify(["same"]),
      FAKE_ANTHROPIC_ORIGIN: vendor.origin,
      ANTHROPIC_API_KEY: key,
      ANTHROPIC_BASE_URL: trap.origin,
    });
    try {
      const { url } = await server.line((value) => value.event === "listening");
      await server.line((value) => value.event === "face-models-verified");
      const started = await startRun(new URL(String(url)), runInput({ candidates: 1 }));
      expect(started.status).toBe("success");
      const report = await readRunReport(runsDatabase(data), data, started.result!.runId);
      expect(report.lanes[0]!.candidates[0]!.judgement).toMatchObject({
        status: "judged",
        levels: FAKE_VERDICT.levels,
      });
      expect(trap.requests).toEqual([]);
      expect(vendor.requests).toHaveLength(1);
      const [sent] = vendor.requests;
      expect(sent!.path).toBe("/v1/messages");
      expect(sent!.headers.get("x-api-key")).toBe(key);
    } finally {
      server.child.kill("SIGKILL");
      await Promise.all([vendor.stop(), trap.stop()]);
    }
  }, 60_000);

  test("SIGTERM stops the server cleanly", async () => {
    const data = await volumeWithPhotos();
    const server = spawnServer(data, {}, entrypoint);
    try {
      await server.line((value) => value.event === "face-models-verified");
      server.child.kill("SIGTERM");
      expect(await server.line((value) => value.event === "stopping")).toEqual({
        event: "stopping",
        signal: "SIGTERM",
      });
      expect(await server.child.exited).toBe(0);
    } finally {
      server.child.kill("SIGKILL");
    }
  }, 30_000);
});
