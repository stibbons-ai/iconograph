import {
  attachCleanupError,
  createLocalStore,
  LibsqlRunStore,
  type LibsqlRunStoreOptions,
  RunStore,
  withCleanup,
  workflowsStore,
} from "@iconograph/adapters";
import type {
  FaceEmbedder,
  FaceModelError,
  ImageModels,
  Judges,
  Optimizers,
  RetryPolicy,
  RunRequest,
} from "@iconograph/domain";
import { Mastra } from "@mastra/core/mastra";
import type { MastraCompositeStore } from "@mastra/core/storage";
import { Effect, Layer, Logger, ManagedRuntime, Schema } from "effect";
import { runReport } from "./report";
import { defaultRunConfig, type PhotoPaths, RunConfig } from "./run-steps";
import { EstimateEvent, type RunResult } from "./schemas";
import { printWarning, type RunWarning, warningLogger } from "./warnings";
import { CancelRecordings, createRunWorkflow, RUN_WORKFLOW_ID } from "./workflow";

export type { EstimateEvent, RunResult } from "./schemas";
export { RUN_WORKFLOW_ID } from "./workflow";
export type { PhotoPaths } from "./run-steps";
export type { RunWarning } from "./warnings";
export { nativeVendors, type OpenVendors, type VendorsResource } from "./vendors";

/** How long closing waits for cancelled Runs to unwind and record their Lanes. */
const CANCEL_SETTLE_TIMEOUT_MS = 10_000;
const decodeEvent = Schema.decodeUnknownOption(EstimateEvent);

export interface RunApplicationOptions {
  /** The LibSQL file for Mastra's snapshots and the Run tables. Its directory must exist. */
  databasePath: string;
  /** The data volume: images and face-model weights. */
  dataDirectory: string;
  imageModels: Layer.Layer<ImageModels>;
  judges: Layer.Layer<Judges>;
  optimizers: Layer.Layer<Optimizers>;
  faceEmbedder: Layer.Layer<FaceEmbedder, FaceModelError>;
  retryPolicy?: RetryPolicy;
  /**
   * `confined` (default): Reference Photos must be files inside the data volume.
   * `operator`: any path, for the operator's own CLI.
   */
  photoPaths?: PhotoPaths;
  /**
   * Receives the engine's warnings (e.g. a settle that failed after an
   * interrupt) with their log annotations (`runId`, `lane`, `iteration`,
   * `candidate`). Default: one JSON line on stderr, never stdout.
   */
  warn?: (warning: RunWarning) => void;
  /** Wraps the Run tables' client; a test seam (`LibsqlRunStoreOptions.wrapClient`). */
  wrapRunStoreClient?: LibsqlRunStoreOptions["wrapClient"];
}

/**
 * The Mastra instance with the Run workflow on one shared Effect runtime that
 * provides the Image Models, the Judges, the Optimizers, face backend, Run
 * tables and config.
 */
export async function createRunApplication(options: RunApplicationOptions) {
  const { databasePath, dataDirectory } = options;
  const storage = createLocalStore(databasePath);
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      options.faceEmbedder,
      options.imageModels,
      options.judges,
      options.optimizers,
      LibsqlRunStore(
        databasePath,
        options.wrapRunStoreClient ? { wrapClient: options.wrapRunStoreClient } : {},
      ),
      Layer.succeed(RunConfig)({
        ...defaultRunConfig(dataDirectory),
        ...(options.retryPolicy && { retryPolicy: options.retryPolicy }),
        ...(options.photoPaths && { photoPaths: options.photoPaths }),
      }),
      // Provided to the layers too, so logs while building or releasing them are warnings.
    ).pipe(Layer.provideMerge(Logger.layer([warningLogger(options.warn ?? printWarning)]))),
  );
  const cancels = new CancelRecordings(options.warn ?? printWarning);
  /** Shut down in order; a later step still runs when an earlier one fails. */
  const closeAll = (shutdown?: () => Promise<void>) =>
    withCleanup(
      // Cancelled Runs finish (and record their Lanes) only while Mastra and its storage run.
      () => cancels.settled(CANCEL_SETTLE_TIMEOUT_MS),
      () =>
        withCleanup(
          async () => shutdown?.(),
          () =>
            withCleanup(
              () => runtime.dispose(),
              () => storage.close(),
            ),
        ),
    );
  try {
    await storage.init();
    const mastra = new Mastra({
      storage,
      workflows: { run: createRunWorkflow(runtime, cancels) },
      logger: false,
    });
    const workflows = await workflowsStore(storage);

    return {
      /** The Mastra instance, for mounting its HTTP routes. */
      mastra,
      /**
       * Run the workflow to the end. `onEvent` receives the estimate before any
       * Candidate is generated. A failed Run throws with the step's error.
       */
      async start(
        request: RunRequest,
        onEvent?: (event: EstimateEvent) => void,
      ): Promise<RunResult> {
        const run = await mastra.getWorkflow("run").createRun();
        const stream = run.stream({ inputData: request });
        for await (const chunk of stream.fullStream) {
          if (chunk.type !== "workflow-step-output") continue;
          const event = decodeEvent(chunk.payload.output);
          if (event._tag === "Some") onEvent?.(event.value);
        }
        const result = await stream.result;
        if (result.status === "success") return result.result;
        const message =
          result.status === "failed" ? result.error.message : `Run ended ${result.status}`;
        const cause = result.status === "failed" ? result.error : undefined;
        // Name the Run unless it is known not to be stored: `read --run-id` can then show it.
        const lookup = await runtime.runPromise(
          Effect.gen(function* () {
            return yield* (yield* RunStore).loadRun(run.runId);
          }).pipe(Effect.result),
        );
        if (lookup._tag === "Success") throw new RunFailedError(run.runId, message, cause);
        if (lookup.failure.notFound) throw new Error(message, { cause });
        throw new RunFailedError(
          run.runId,
          `${message} (whether Run ${run.runId} was stored is unverified: ${lookup.failure.message})`,
          cause,
        );
      },
      /** The stored Run: Candidates, Outcomes, costs and stop reasons. */
      report: async (runId: string) =>
        runtime.runPromise(runReport(runId, await workflowCancelled(storage, runId))),
      /** Mastra's persisted snapshot of a Run's workflow. */
      async snapshot(runId: string) {
        const snapshot = await workflows.loadWorkflowSnapshot({
          workflowName: RUN_WORKFLOW_ID,
          runId,
        });
        if (!snapshot) throw new Error(`Run not found: ${runId}`);
        return snapshot;
      },
      close: () => closeAll(() => mastra.shutdown()),
    };
  } catch (error) {
    await closeAll().catch((cleanupError: unknown) => attachCleanupError(error, cleanupError));
    throw error;
  }
}

/** A Run that started and then failed; `runId` finds what it stored and spent (`read`). */
export class RunFailedError extends Error {
  override name = "RunFailedError";
  constructor(
    readonly runId: string,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
  }
}

/**
 * Whether Mastra stored the Run as cancelled. Its report then shows every Lane
 * without a stop reason as `cancelled`: recording them may have been cut off
 * (the process stopped while the Run's steps unwound).
 */
async function workflowCancelled(storage: MastraCompositeStore, runId: string) {
  const workflows = await workflowsStore(storage);
  const snapshot = await workflows.loadWorkflowSnapshot({ workflowName: RUN_WORKFLOW_ID, runId });
  return snapshot?.status === "canceled";
}

/** Read a stored Run's report without starting Mastra, the face models or any Image Model. */
export async function readRunReport(databasePath: string, dataDirectory: string, runId: string) {
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      LibsqlRunStore(databasePath, { readOnly: true }),
      Layer.succeed(RunConfig)(defaultRunConfig(dataDirectory)),
    ),
  );
  return withCleanup(
    async () => {
      // The Run tables first: they refuse a missing or outdated database file.
      await runtime.runPromise(
        Effect.gen(function* () {
          yield* (yield* RunStore).loadRun(runId);
        }),
      );
      const storage = createLocalStore(databasePath);
      try {
        return await runtime.runPromise(runReport(runId, await workflowCancelled(storage, runId)));
      } finally {
        await storage.close();
      }
    },
    () => runtime.dispose(),
  );
}
