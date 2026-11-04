import { stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type BudgetExhausted,
  type CallEstimate,
  CandidateOutcome,
  checkBudget,
  Judgement,
  IdentityCeiling,
  type KeptReason,
  LANE_STOPS_WITH_DETAIL,
  LaneStopReason,
  type LedgerEntry,
  PriceQuote,
  RunRequest,
  type SettledCall,
  SettledCallKind,
  toMicros,
} from "@iconograph/domain";
import { type Client, createClient, type InValue, type Row } from "@libsql/client";
import { Context, Data, Effect, Layer, Schema, Semaphore } from "effect";
import { codeOf, errorMessage } from "./errors";
import { ReferencePhotoReport } from "./reference-photos";
import { localDatabaseUrl } from "./storage";

/** How long one statement waits, synchronously, on a lock held elsewhere. */
const BUSY_WAIT_MS = 50;
/** A locked database is retried this often, yielding in between, for this long. */
const LOCK_RETRY_EVERY_MS = 20;
const LOCK_RETRY_FOR_MS = 5_000;

/** Reading or writing the Run tables failed. */
export class RunStoreError extends Data.TaggedError("RunStoreError")<{
  message: string;
  cause?: unknown;
  /** The Run or Iteration looked up doesn't exist (as opposed to a read that failed). */
  notFound?: true;
}> {}

/** Literal strings as a SQL list for `IN (…)`; only for our own constants, never input. */
const sqlList = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");

/**
 * Our own tables, in the same LibSQL file as Mastra's storage. Every row is
 * keyed by Run, Lane, Iteration and Candidate index (and purpose and attempt
 * for calls; an Optimizer call has no Candidate and is keyed by the Iteration
 * it optimizes, whose successor's Prompt it writes). Re-executed steps find
 * what already exists (Candidates, judgements, the next Iteration) instead of
 * calling again. USD amounts are integer micro-dollars; `budget_micros` is
 * derived from the stored request when the Run is saved, so the reservation
 * SQL can read it.
 */
const schema = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  request TEXT NOT NULL,
  budget_micros INTEGER NOT NULL CHECK (budget_micros > 0),
  photo_report TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lanes (
  run_id TEXT NOT NULL REFERENCES runs (id),
  lane INTEGER NOT NULL,
  model TEXT NOT NULL,
  price TEXT NOT NULL,
  character_references TEXT NOT NULL,
  stop_reason TEXT CHECK (stop_reason IN (${sqlList(LaneStopReason.literals)})),
  stop_detail TEXT CHECK (stop_detail IS NULL OR length(stop_detail) > 0),
  PRIMARY KEY (run_id, lane),
  CHECK ((stop_detail IS NOT NULL) = (stop_reason IS NOT NULL AND stop_reason IN (${sqlList(LANE_STOPS_WITH_DETAIL)})))
);
CREATE TABLE IF NOT EXISTS iterations (
  run_id TEXT NOT NULL,
  lane INTEGER NOT NULL,
  iteration INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('initial', 'optimizer', 'kept')),
  reason TEXT,
  PRIMARY KEY (run_id, lane, iteration),
  FOREIGN KEY (run_id, lane) REFERENCES lanes (run_id, lane),
  CHECK ((source = 'kept') = (reason IS NOT NULL)),
  CHECK (reason IS NULL OR length(reason) > 0),
  CHECK ((iteration = 1) = (source = 'initial'))
);
CREATE TABLE IF NOT EXISTS candidates (
  run_id TEXT NOT NULL,
  lane INTEGER NOT NULL,
  iteration INTEGER NOT NULL,
  candidate INTEGER NOT NULL,
  outcome TEXT,
  image_sha256 TEXT,
  image_type TEXT,
  PRIMARY KEY (run_id, lane, iteration, candidate),
  FOREIGN KEY (run_id, lane, iteration) REFERENCES iterations (run_id, lane, iteration),
  CHECK (outcome IS NOT NULL OR image_sha256 IS NOT NULL),
  CHECK ((image_sha256 IS NULL) = (image_type IS NULL))
);
CREATE TABLE IF NOT EXISTS cost_records (
  run_id TEXT NOT NULL,
  lane INTEGER NOT NULL,
  iteration INTEGER NOT NULL,
  candidate INTEGER,
  purpose TEXT NOT NULL CHECK (purpose IN ('generate', 'judge', 'optimize')),
  attempt INTEGER NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  estimated_micros INTEGER NOT NULL CHECK (estimated_micros >= 0),
  estimated_usage TEXT NOT NULL,
  settled INTEGER NOT NULL DEFAULT 0,
  actual_micros INTEGER CHECK (actual_micros >= 0),
  usage TEXT,
  result TEXT,
  reason TEXT,
  FOREIGN KEY (run_id) REFERENCES runs (id),
  CHECK ((purpose = 'optimize') = (candidate IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS cost_records_key
  ON cost_records (run_id, lane, iteration, IFNULL(candidate, -1), purpose, attempt);
CREATE TABLE IF NOT EXISTS optimizers (
  run_id TEXT PRIMARY KEY REFERENCES runs (id),
  price TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS judges (
  run_id TEXT PRIMARY KEY REFERENCES runs (id),
  price TEXT NOT NULL,
  rubric_version TEXT NOT NULL,
  reference_photos TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS judgements (
  run_id TEXT NOT NULL,
  lane INTEGER NOT NULL,
  iteration INTEGER NOT NULL,
  candidate INTEGER NOT NULL,
  judgement TEXT NOT NULL,
  PRIMARY KEY (run_id, lane, iteration, candidate),
  FOREIGN KEY (run_id, lane, iteration, candidate)
    REFERENCES candidates (run_id, lane, iteration, candidate)
);
`;

/**
 * What a call commits against the Budget, in SQL: its actual cost once settled
 * and known, else its estimate. Mirrors the domain's `checkBudget`, which tests
 * hold it to.
 */
const committedSql = `COALESCE(SUM(CASE WHEN settled = 1 AND actual_micros IS NOT NULL
  THEN actual_micros ELSE estimated_micros END), 0)`;

export interface IterationKey {
  runId: string;
  lane: number;
  iteration: number;
}

export interface CandidateKey extends IterationKey {
  candidate: number;
}

/** What a billable call was for: generating or judging a Candidate, or writing a Prompt. */
const CallPurpose = Schema.Literals(["generate", "judge", "optimize"]);
export type CallPurpose = typeof CallPurpose.Type;

/**
 * Whose calls these are: a Candidate's (generating or judging it), or the
 * Optimizer's, keyed by the Iteration it optimizes (whose result is the next Iteration's Prompt).
 */
export type CallSubject =
  | (CandidateKey & { purpose: "generate" | "judge" })
  | (IterationKey & { candidate: null; purpose: "optimize" });

/** One attempt of a subject's call. */
export type CallKey = CallSubject & { attempt: number };

/** A Candidate's call: generating or judging it. */
export type CandidateCallKey = Extract<CallKey, { purpose: "generate" | "judge" }>;

/** The Run's identity reference, frozen at Run start. */
export interface RunIdentity {
  faceModel: string;
  gate: number;
  anchor: readonly number[];
  ceiling: IdentityCeiling;
}

/** A photo report with an Identity Anchor: a Run starts only with accepted photos. */
export type RunPhotoReport = ReferencePhotoReport & {
  readonly identity: NonNullable<ReferencePhotoReport["identity"]>;
};

export interface NewRun {
  id: string;
  request: RunRequest;
  photoReport: RunPhotoReport;
}

export interface StoredRun extends NewRun {
  createdAt: Date;
  /** The Budget in micro-USD, from `request.budgetUsd`. */
  budgetMicros: number;
  /** From the stored photo report, the only copy. */
  identity: RunIdentity;
}

export interface NewLane {
  lane: number;
  model: string;
  price: PriceQuote;
  /** Photo numbers sent to this Lane's Image Model as character references, in order. */
  characterReferences: readonly number[];
}

export interface LaneRecord extends NewLane {
  stopReason: LaneStopReason | null;
  /** The vendor's reason a role was turned away for good, for `LANE_STOPS_WITH_DETAIL`; else null. */
  stopDetail: string | null;
}

/** The Run's Judge as frozen at Run start; its model, effort and weights are in the request. */
export interface JudgeRecord {
  price: PriceQuote;
  rubricVersion: string;
  /** Photo numbers of the Reference Photos the Judge sees, in the order it sees them. */
  referencePhotos: readonly number[];
}

/** Where an Iteration's Prompt came from. */
const PromptSourceKind = Schema.Literals(["initial", "optimizer", "kept"]);
export type PromptSource =
  /** The Lane's own initial Prompt, or the one built from the Target Look. */
  | { source: "initial" }
  /** Written by the Optimizer from the Lane's earlier Iterations. */
  | { source: "optimizer" }
  /** The previous Iteration's Prompt, kept because optimizing failed; `reason` says why. */
  | { source: "kept"; reason: KeptReason };

export type IterationRecord = IterationKey & PromptSource & { prompt: string };

const decodePurpose = Schema.decodeUnknownSync(CallPurpose);
const UsageJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Finite));

/** One billable call: its key, its Budget ledger entry and what it returned. */
export type CallRecord<K extends CallKey = CallKey> = K &
  LedgerEntry & {
    result: typeof SettledCallKind.Type | null;
    reason: string | null;
    usage: Record<string, number> | null;
  };

/** A generated image in the content-addressed store. */
export interface StoredCandidateImage {
  sha256: string;
  type: string;
}

/** A finished Candidate as first saved: a final outcome, or an image still to score. */
export type NewCandidate =
  | { outcome: CandidateOutcome; image: null }
  | { outcome: null; image: StoredCandidateImage };

export interface CandidateRecord extends CandidateKey {
  /** Null between generating and scoring. */
  outcome: CandidateOutcome | null;
  image: StoredCandidateImage | null;
  /** Null until the Judge's work on a Scored Candidate ends; always null otherwise. */
  judgement: Judgement | null;
  /** Its billable calls, generating and judging, by purpose and attempt. */
  calls: CallRecord<CandidateCallKey>[];
}

const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(RunRequest));
const decodePhotoReport = Schema.decodeUnknownSync(Schema.fromJsonString(ReferencePhotoReport));
const decodePrice = Schema.decodeUnknownSync(Schema.fromJsonString(PriceQuote));
const decodeReferences = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.Int)));
const decodeStopReason = Schema.decodeUnknownSync(Schema.NullOr(LaneStopReason));
const decodePromptSource = Schema.decodeUnknownSync(PromptSourceKind);
const decodeOutcome = Schema.decodeUnknownSync(Schema.fromJsonString(CandidateOutcome));
const decodeResult = Schema.decodeUnknownSync(Schema.NullOr(SettledCallKind));
const decodeUsage = Schema.decodeUnknownSync(Schema.NullOr(UsageJson));
const decodeJudgement = Schema.decodeUnknownSync(Schema.fromJsonString(Judgement));
const encodeJudgement = Schema.encodeSync(Schema.fromJsonString(Judgement));

/** The Iteration a row is about. */
const iterationKeyRow = (row: Row): IterationKey => ({
  runId: String(row.run_id),
  lane: Number(row.lane),
  iteration: Number(row.iteration),
});

/** The Candidate a row of `candidates` or `judgements` is about. */
const candidateKeyRow = (row: Row): CandidateKey => ({
  ...iterationKeyRow(row),
  candidate: Number(row.candidate),
});

/** A `cost_records` row's key: a Candidate's call, or an Optimizer call without a Candidate. */
const callKeyRow = (row: Row): CallKey => {
  const purpose = decodePurpose(row.purpose);
  const attempt = Number(row.attempt);
  return purpose === "optimize"
    ? { ...iterationKeyRow(row), candidate: null, purpose, attempt }
    : { ...candidateKeyRow(row), purpose, attempt };
};

/** A `cost_records` row. */
const callRecord = (row: Row): CallRecord => ({
  ...callKeyRow(row),
  estimateMicros: Number(row.estimated_micros),
  settled: Number(row.settled) === 1,
  actualMicros: row.actual_micros === null ? null : Number(row.actual_micros),
  result: decodeResult(row.result),
  reason: row.reason === null ? null : String(row.reason),
  usage: decodeUsage(row.usage),
});

/** A call's subject in messages: its Candidate, or the Iteration it optimizes. */
const callLabel = (key: CallKey) =>
  key.candidate === null ? `Iteration ${key.iteration}` : `Candidate ${key.candidate}`;

/** One string per Iteration of a Run, e.g. to match Optimizer calls to Iterations. */
export const iterationKeyOf = ({ lane, iteration }: Pick<IterationKey, "lane" | "iteration">) =>
  `${lane}/${iteration}`;

/** One string per Candidate of a Run, e.g. to match calls to Candidates. */
export const candidateKeyOf = (key: CandidateKey) => `${iterationKeyOf(key)}/${key.candidate}`;

export class RunStore extends Context.Service<
  RunStore,
  {
    readonly createRun: (run: NewRun) => Effect.Effect<void, RunStoreError>;
    /** Fails with `notFound` when the Run doesn't exist. */
    readonly loadRun: (runId: string) => Effect.Effect<StoredRun, RunStoreError>;
    readonly createLane: (runId: string, lane: NewLane) => Effect.Effect<void, RunStoreError>;
    readonly loadLanes: (runId: string) => Effect.Effect<LaneRecord[], RunStoreError>;
    /**
     * Stop a Lane with `reason`, unless it already stopped (the first reason
     * stands). `detail` is required with, and only with, `LANE_STOPS_WITH_DETAIL`.
     */
    readonly stopLane: (
      runId: string,
      lane: number,
      reason: LaneStopReason,
      detail?: string,
    ) => Effect.Effect<void, RunStoreError>;
    /** Stop every Lane of the Run that hasn't stopped yet with `cancelled`. */
    readonly cancelLanes: (runId: string) => Effect.Effect<void, RunStoreError>;
    readonly createIteration: (
      key: IterationKey,
      prompt: string,
      source: PromptSource,
    ) => Effect.Effect<void, RunStoreError>;
    /** Fails with `notFound` when the Iteration doesn't exist. */
    readonly loadPrompt: (key: IterationKey) => Effect.Effect<string, RunStoreError>;
    /** The Run's Iterations (or one Lane's), by Lane and Iteration: each one's Prompt and its source. */
    readonly loadIterations: (
      runId: string,
      lane?: number,
    ) => Effect.Effect<IterationRecord[], RunStoreError>;
    readonly createJudge: (runId: string, judge: JudgeRecord) => Effect.Effect<void, RunStoreError>;
    /** Null when the Run was never given a Judge (it failed while starting). */
    readonly loadJudge: (runId: string) => Effect.Effect<JudgeRecord | null, RunStoreError>;
    /** Record the Optimizer's price at Run start; its model and effort are in the request. */
    readonly createOptimizer: (
      runId: string,
      price: PriceQuote,
    ) => Effect.Effect<void, RunStoreError>;
    /** The Optimizer's recorded price; null when the Run failed before recording it. */
    readonly loadOptimizer: (runId: string) => Effect.Effect<PriceQuote | null, RunStoreError>;
    /**
     * Reserve a call's estimate against the Run's Budget and record it in one
     * atomic statement, or fail with `BudgetExhausted` without recording
     * anything. Reservations are also serialised in-process.
     */
    readonly reserveCall: (
      key: CallKey,
      model: string,
      estimate: CallEstimate,
    ) => Effect.Effect<void, BudgetExhausted | RunStoreError>;
    /** Record a reserved call's result and actual cost. */
    readonly settleCall: (key: CallKey, result: SettledCall) => Effect.Effect<void, RunStoreError>;
    /** Record a Candidate once its calls are done: an image to score, or a final outcome. */
    readonly saveCandidate: (
      key: CandidateKey,
      candidate: NewCandidate,
    ) => Effect.Effect<void, RunStoreError>;
    /** Record a generated Candidate's outcome once it is scored. */
    readonly setCandidateOutcome: (
      key: CandidateKey,
      outcome: CandidateOutcome,
    ) => Effect.Effect<void, RunStoreError>;
    /** Record how the Judge's work on a Candidate ended; once per Candidate. */
    readonly saveJudgement: (
      key: CandidateKey,
      judgement: Judgement,
    ) => Effect.Effect<void, RunStoreError>;
    readonly loadCandidates: (
      runId: string,
      lane?: number,
    ) => Effect.Effect<CandidateRecord[], RunStoreError>;
    /**
     * The Run's (or one Lane's) Candidates and every one of its billable calls
     * (the Budget's ledger, including Optimizer calls and calls without a
     * Candidate row), read as one snapshot.
     */
    readonly loadRecords: (
      runId: string,
      lane?: number,
    ) => Effect.Effect<{ candidates: CandidateRecord[]; calls: CallRecord[] }, RunStoreError>;
  }
>()("@iconograph/adapters/RunStore") {}

const json = (value: unknown) => JSON.stringify(value);

/**
 * Run tables from before the Judge keyed calls without a purpose, and tables
 * from before the Optimizer can't hold its calls (every call had a Candidate)
 * or a Prompt's source; such a database is refused rather than migrated.
 */
async function rejectOutdatedTables(client: Client) {
  const { rows } = await client.execute("PRAGMA table_info(cost_records)");
  if (rows.length === 0) return;
  if (!rows.some((row) => row.name === "purpose")) {
    throw new Error(
      "its Run tables predate the Judge (cost records without a purpose); use a new database file",
    );
  }
  const candidate = rows.find((row) => row.name === "candidate");
  if (Number(candidate?.notnull) === 1) {
    throw new Error(
      "its Run tables predate the Optimizer (cost records without Optimizer calls); use a new database file",
    );
  }
}

export interface LibsqlRunStoreOptions {
  /** Read a database that must already exist, without creating tables. */
  readOnly?: boolean;
  /** Wraps the store's client; a seam for tests that time actions against the lock. */
  wrapClient?: (client: Client) => Client;
}

/**
 * Run a database action on `client`, retrying while the database is locked.
 * Mastra writes snapshots to the same file, often in interactive transactions
 * that hold the write lock across awaits. The local client waits on a lock
 * synchronously, blocking the event loop, so a long wait could never see
 * Mastra (in this process) release its lock: each attempt waits only briefly
 * (`BUSY_WAIT_MS`), and a locked database is retried after yielding, for up
 * to `LOCK_RETRY_FOR_MS`. With @libsql/client 0.18's native binding, a
 * statement that failed with SQLITE_BUSY leaves its connection inside a
 * transaction it never ends:
 * every later write on that connection reports success but is never
 * committed. So the client reconnects at once, and the store runs one action
 * at a time, so no other action can use the connection before that. An
 * aborted `signal` stops further attempts; the one in flight runs to its end.
 */
async function retryWhileLocked<A>(
  client: Client,
  run: () => Promise<A>,
  signal?: AbortSignal,
): Promise<A> {
  const giveUpAt = Date.now() + LOCK_RETRY_FOR_MS;
  for (;;) {
    try {
      return await run();
    } catch (error) {
      if (client.closed || codeOf(error) !== "SQLITE_BUSY") throw error;
      await client.reconnect();
      if (Date.now() >= giveUpAt) {
        throw new Error(
          `the database stayed locked for ${LOCK_RETRY_FOR_MS / 1000} s of retries: ${errorMessage(error)}`,
          { cause: error },
        );
      }
      signal?.throwIfAborted();
      await sleep(LOCK_RETRY_EVERY_MS, undefined, signal && { signal });
    }
  }
}

/** The Run tables in the LibSQL file at `databasePath` (the same file Mastra uses). */
export const LibsqlRunStore = (databasePath: string, options: LibsqlRunStoreOptions = {}) =>
  Layer.effect(RunStore)(
    Effect.gen(function* () {
      const client = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            if (options.readOnly) {
              const info = await stat(databasePath).catch((error: unknown) => {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                  throw new Error("no such database file");
                }
                throw error;
              });
              if (!info.isFile()) throw new Error("not a database file");
            }
            const created = createClient({
              url: localDatabaseUrl(databasePath),
              timeout: BUSY_WAIT_MS,
            });
            const client = options.wrapClient?.(created) ?? created;
            try {
              await retryWhileLocked(client, () => rejectOutdatedTables(client));
              if (!options.readOnly) {
                await retryWhileLocked(client, () => client.executeMultiple(schema));
              }
            } catch (error) {
              client.close();
              throw error;
            }
            return client;
          },
          catch: (error) =>
            new RunStoreError({
              message: `Opening the Run tables in ${databasePath} failed: ${errorMessage(error)}`,
              cause: error,
            }),
        }),
        (client) => Effect.sync(() => client.close()),
      );
      /**
       * One action at a time: a connection left in an open transaction by a
       * lock is reset before any other action can take it.
       */
      const actions = yield* Semaphore.make(1);

      /**
       * One database action (`retryWhileLocked`). An interrupt stops further
       * attempts, but the action keeps its turn until the attempt in flight has
       * ended (one statement or batch, plus at most one reconnect), so the next action
       * never meets a connection still being reset.
       */
      const query = <A>(action: string, run: (client: Client) => Promise<A>) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.suspend(() => {
            const stop = new AbortController();
            const attempts = retryWhileLocked(client, () => run(client), stop.signal);
            return restore(
              Effect.tryPromise({
                try: () => attempts,
                catch: (error) =>
                  new RunStoreError({
                    message: `${action} failed: ${errorMessage(error)}`,
                    cause: error,
                  }),
              }),
            ).pipe(
              Effect.onInterrupt(() =>
                Effect.promise(() => {
                  stop.abort();
                  return attempts.then(
                    () => undefined,
                    () => undefined,
                  );
                }),
              ),
            );
          }),
        ).pipe(actions.withPermits(1));
      const execute = (action: string, sql: string, args: InValue[]) =>
        query(action, (db) => db.execute({ sql, args })).pipe(Effect.asVoid);
      /** An UPDATE that must change exactly the keyed row; `missing` explains a miss. */
      const update = (action: string, sql: string, args: InValue[], missing = "no such row") =>
        query(action, async (db) => {
          const { rowsAffected } = await db.execute({ sql, args });
          if (rowsAffected === 0) throw new Error(missing);
        });
      /** Rows of one Run, or of one of its Lanes. */
      const scope = (runId: string, lane?: number) =>
        lane === undefined
          ? { where: "run_id = ?", args: [runId] }
          : { where: "run_id = ? AND lane = ?", args: [runId, lane] };
      /** Candidates with their calls, plus every call, from one read transaction. */
      const loadRecords = (runId: string, lane?: number) =>
        query(`Loading the Candidates of Run ${runId}`, async (db) => {
          const { where, args } = scope(runId, lane);
          const [candidateRows, callRows, judgementRows] = await db.batch(
            [
              {
                sql: `SELECT * FROM candidates WHERE ${where} ORDER BY lane, iteration, candidate`,
                args,
              },
              {
                sql: `SELECT * FROM cost_records WHERE ${where}
                      ORDER BY lane, iteration, candidate, purpose, attempt`,
                args,
              },
              { sql: `SELECT * FROM judgements WHERE ${where}`, args },
            ],
            "read",
          );
          const judgements = new Map(
            (judgementRows?.rows ?? []).map((row) => {
              const key = candidateKeyRow(row);
              try {
                return [candidateKeyOf(key), decodeJudgement(row.judgement)] as const;
              } catch (error) {
                throw new Error(
                  `the judgement of Lane ${key.lane}, Iteration ${key.iteration}, Candidate ${key.candidate} can't be read: ${errorMessage(error)}`,
                  { cause: error },
                );
              }
            }),
          );
          const calls = (callRows?.rows ?? []).map(callRecord);
          const callsByCandidate = new Map<string, CallRecord<CandidateCallKey>[]>();
          for (const call of calls) {
            if (call.candidate === null) continue;
            const key = candidateKeyOf(call);
            const group = callsByCandidate.get(key);
            if (group) group.push(call);
            else callsByCandidate.set(key, [call]);
          }
          const candidates = (candidateRows?.rows ?? []).map((row): CandidateRecord => {
            const key = candidateKeyRow(row);
            return {
              ...key,
              outcome: row.outcome === null ? null : decodeOutcome(row.outcome),
              image:
                row.image_sha256 === null
                  ? null
                  : { sha256: String(row.image_sha256), type: String(row.image_type) },
              judgement: judgements.get(candidateKeyOf(key)) ?? null,
              calls: callsByCandidate.get(candidateKeyOf(key)) ?? [],
            };
          });
          return { candidates, calls };
        });

      return {
        createRun: (run) =>
          execute(
            `Saving Run ${run.id}`,
            `INSERT INTO runs (id, created_at, request, budget_micros, photo_report)
             VALUES (?, ?, ?, ?, ?)`,
            [
              run.id,
              Date.now(),
              json(run.request),
              toMicros(run.request.budgetUsd),
              json(run.photoReport),
            ],
          ),

        loadRun: (runId) =>
          query(`Loading Run ${runId}`, async (db): Promise<StoredRun | undefined> => {
            const { rows } = await db.execute({
              sql: "SELECT * FROM runs WHERE id = ?",
              args: [runId],
            });
            const row = rows[0];
            if (!row) return undefined;
            const request = decodeRequest(row.request);
            const decoded = decodePhotoReport(row.photo_report);
            const { identity } = decoded;
            if (!identity) throw new Error("its photo report has no Identity Anchor");
            return {
              id: String(row.id),
              createdAt: new Date(Number(row.created_at)),
              request,
              budgetMicros: toMicros(request.budgetUsd),
              photoReport: { ...decoded, identity },
              identity: {
                faceModel: decoded.model,
                gate: decoded.identityGate,
                anchor: identity.anchor,
                ceiling: identity.ceiling,
              },
            };
          }).pipe(
            Effect.flatMap((run) =>
              run
                ? Effect.succeed(run)
                : Effect.fail(
                    new RunStoreError({ message: `Run not found: ${runId}`, notFound: true }),
                  ),
            ),
          ),

        createLane: (runId, { lane, model, price, characterReferences }) =>
          execute(
            `Saving Lane ${lane} of Run ${runId}`,
            "INSERT INTO lanes (run_id, lane, model, price, character_references) VALUES (?, ?, ?, ?, ?)",
            [runId, lane, model, json(price), json(characterReferences)],
          ),

        loadLanes: (runId) =>
          query(`Loading the Lanes of Run ${runId}`, async (db) => {
            const { rows } = await db.execute({
              sql: "SELECT * FROM lanes WHERE run_id = ? ORDER BY lane",
              args: [runId],
            });
            return rows.map((row): LaneRecord => ({
              lane: Number(row.lane),
              model: String(row.model),
              price: decodePrice(row.price),
              characterReferences: decodeReferences(row.character_references),
              stopReason: decodeStopReason(row.stop_reason),
              stopDetail: row.stop_detail === null ? null : String(row.stop_detail),
            }));
          }),

        // The first stop recorded stands: a later one (e.g. a step finishing after the Run was
        // cancelled) never overwrites it, nor its detail. Every right-hand side reads the old row.
        stopLane: (runId, lane, reason, detail) =>
          update(
            `Stopping Lane ${lane} of Run ${runId}`,
            `UPDATE lanes SET stop_reason = COALESCE(stop_reason, ?),
              stop_detail = CASE WHEN stop_reason IS NULL THEN ? ELSE stop_detail END
              WHERE run_id = ? AND lane = ?`,
            [reason, detail ?? null, runId, lane],
          ),

        cancelLanes: (runId) =>
          execute(
            `Cancelling the Lanes of Run ${runId}`,
            "UPDATE lanes SET stop_reason = 'cancelled' WHERE run_id = ? AND stop_reason IS NULL",
            [runId],
          ),

        createIteration: ({ runId, lane, iteration }, prompt, promptSource) =>
          execute(
            `Saving Iteration ${iteration} of Lane ${lane}`,
            "INSERT INTO iterations (run_id, lane, iteration, prompt, source, reason) VALUES (?, ?, ?, ?, ?, ?)",
            [
              runId,
              lane,
              iteration,
              prompt,
              promptSource.source,
              promptSource.source === "kept" ? promptSource.reason : null,
            ],
          ),

        loadPrompt: ({ runId, lane, iteration }) =>
          query(`Loading the Prompt of Iteration ${iteration}`, async (db) => {
            const { rows } = await db.execute({
              sql: "SELECT prompt FROM iterations WHERE run_id = ? AND lane = ? AND iteration = ?",
              args: [runId, lane, iteration],
            });
            return rows[0] ? String(rows[0].prompt) : undefined;
          }).pipe(
            Effect.flatMap((prompt) =>
              prompt === undefined
                ? Effect.fail(
                    new RunStoreError({
                      message: `Loading the Prompt of Iteration ${iteration} failed: Iteration ${iteration} of Lane ${lane} not found`,
                      notFound: true,
                    }),
                  )
                : Effect.succeed(prompt),
            ),
          ),

        loadIterations: (runId, lane) =>
          query(`Loading the Iterations of Run ${runId}`, async (db) => {
            const { where, args } = scope(runId, lane);
            const { rows } = await db.execute({
              sql: `SELECT * FROM iterations WHERE ${where} ORDER BY lane, iteration`,
              args,
            });
            return rows.map((row): IterationRecord => {
              const key = { ...iterationKeyRow(row), prompt: String(row.prompt) };
              const source = decodePromptSource(row.source);
              // The table's CHECK keeps a kept reason non-empty.
              return source === "kept"
                ? { ...key, source, reason: String(row.reason) as KeptReason }
                : { ...key, source };
            });
          }),

        createJudge: (runId, { price, rubricVersion, referencePhotos }) =>
          execute(
            `Saving the Judge of Run ${runId}`,
            "INSERT INTO judges (run_id, price, rubric_version, reference_photos) VALUES (?, ?, ?, ?)",
            [runId, json(price), rubricVersion, json(referencePhotos)],
          ),

        loadJudge: (runId) =>
          query(`Loading the Judge of Run ${runId}`, async (db) => {
            const { rows } = await db.execute({
              sql: "SELECT * FROM judges WHERE run_id = ?",
              args: [runId],
            });
            const row = rows[0];
            if (!row) return null;
            return {
              price: decodePrice(row.price),
              rubricVersion: String(row.rubric_version),
              referencePhotos: decodeReferences(row.reference_photos),
            } satisfies JudgeRecord;
          }),

        createOptimizer: (runId, price) =>
          execute(
            `Saving the Optimizer of Run ${runId}`,
            "INSERT INTO optimizers (run_id, price) VALUES (?, ?)",
            [runId, json(price)],
          ),

        loadOptimizer: (runId) =>
          query(`Loading the Optimizer of Run ${runId}`, async (db) => {
            const { rows } = await db.execute({
              sql: "SELECT price FROM optimizers WHERE run_id = ?",
              args: [runId],
            });
            return rows[0] ? decodePrice(rows[0].price) : null;
          }),

        // The insert and the reads that explain a rejection run in one write batch: one
        // transaction, one snapshot, executed without yielding in between. So the domain's
        // check sees exactly what the SQL saw, and a disagreement is a real bug. The batch
        // reads the Budget and the whole ledger on every reservation: O(ledger), accepted at
        // M0 sizes (a few dozen calls per Run).
        reserveCall: (key, model, estimate) =>
          query(`Reserving ${key.purpose} call ${key.attempt} of ${callLabel(key)}`, async (db) => {
            const [inserted, budget, ledger] = await db.batch(
              [
                {
                  sql: `INSERT INTO cost_records
                          (run_id, lane, iteration, candidate, purpose, attempt, model, created_at, estimated_micros, estimated_usage)
                        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                        WHERE MAX(0, (SELECT budget_micros FROM runs WHERE id = ?)
                          - (SELECT ${committedSql} FROM cost_records WHERE run_id = ?)) >= ?`,
                  args: [
                    key.runId,
                    key.lane,
                    key.iteration,
                    key.candidate,
                    key.purpose,
                    key.attempt,
                    model,
                    Date.now(),
                    estimate.micros,
                    json(estimate.usage),
                    key.runId,
                    key.runId,
                    estimate.micros,
                  ],
                },
                { sql: "SELECT budget_micros FROM runs WHERE id = ?", args: [key.runId] },
                { sql: "SELECT * FROM cost_records WHERE run_id = ?", args: [key.runId] },
              ],
              "write",
            );
            if (inserted?.rowsAffected === 1) return undefined;
            const runRow = budget?.rows[0];
            if (!runRow) throw new Error(`Run not found: ${key.runId}`);
            const decision = checkBudget(
              Number(runRow.budget_micros),
              (ledger?.rows ?? []).map(callRecord),
              estimate.micros,
            );
            if (decision.fits) {
              throw new Error("the Budget check in SQL and in the domain disagree");
            }
            return decision.error;
          }).pipe(
            Effect.flatMap((exhausted) => (exhausted ? Effect.fail(exhausted) : Effect.void)),
          ),

        // A recorded result is final: settling twice (e.g. an interrupt racing a settle)
        // fails instead of overwriting the actual cost.
        settleCall: (key, result) =>
          update(
            `Recording ${key.purpose} call ${key.attempt} of ${callLabel(key)}`,
            `UPDATE cost_records SET settled = 1, actual_micros = ?, usage = ?, result = ?, reason = ?
             WHERE run_id = ? AND lane = ? AND iteration = ? AND candidate IS ? AND purpose = ?
               AND attempt = ? AND settled = 0`,
            [
              result.costMicros,
              result.usage ? json(result.usage) : null,
              result.kind,
              result.reason ?? null,
              key.runId,
              key.lane,
              key.iteration,
              key.candidate,
              key.purpose,
              key.attempt,
            ],
            "no such row, or it was already settled",
          ),

        saveCandidate: (key, { outcome, image }) =>
          execute(
            `Saving Candidate ${key.candidate}`,
            `INSERT INTO candidates (run_id, lane, iteration, candidate, outcome, image_sha256, image_type)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              key.runId,
              key.lane,
              key.iteration,
              key.candidate,
              outcome ? json(outcome) : null,
              image?.sha256 ?? null,
              image?.type ?? null,
            ],
          ),

        setCandidateOutcome: (key, outcome) =>
          update(
            `Saving the outcome of Candidate ${key.candidate}`,
            `UPDATE candidates SET outcome = ?
             WHERE run_id = ? AND lane = ? AND iteration = ? AND candidate = ?`,
            [json(outcome), key.runId, key.lane, key.iteration, key.candidate],
          ),

        // Encoded through the schema, so a judgement that would not decode is never stored.
        saveJudgement: (key, judgement) =>
          Effect.try({
            try: () => encodeJudgement(judgement),
            catch: (error) =>
              new RunStoreError({
                message: `Saving the judgement of Candidate ${key.candidate} failed: ${errorMessage(error)}`,
                cause: error,
              }),
          }).pipe(
            Effect.flatMap((encoded) =>
              execute(
                `Saving the judgement of Candidate ${key.candidate}`,
                `INSERT INTO judgements (run_id, lane, iteration, candidate, judgement)
                 VALUES (?, ?, ?, ?, ?)`,
                [key.runId, key.lane, key.iteration, key.candidate, encoded],
              ),
            ),
          ),

        loadCandidates: (runId, lane) =>
          loadRecords(runId, lane).pipe(Effect.map(({ candidates }) => candidates)),

        loadRecords,
      };
    }),
  );
