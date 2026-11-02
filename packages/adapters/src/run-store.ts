import { stat } from "node:fs/promises";
import {
  type BudgetExhausted,
  type CallEstimate,
  type CallResult,
  CandidateOutcome,
  checkBudget,
  IdentityCeiling,
  LaneStopReason,
  type LedgerEntry,
  PriceQuote,
  RunRequest,
  toMicros,
} from "@iconograph/domain";
import { type Client, createClient, type InValue, type Row } from "@libsql/client";
import { Context, Data, Effect, Layer, Schema, Semaphore } from "effect";
import { errorMessage } from "./errors";
import { ReferencePhotoReport } from "./reference-photos";
import { localDatabaseUrl } from "./storage";

/** Reading or writing the Run tables failed. */
export class RunStoreError extends Data.TaggedError("RunStoreError")<{
  message: string;
  cause?: unknown;
  /** The Run looked up doesn't exist (as opposed to a read that failed). */
  notFound?: true;
}> {}

/**
 * Our own tables, in the same LibSQL file as Mastra's storage. Every row is
 * keyed by Run, Lane, Iteration and Candidate index (and attempt for calls), so
 * a later restart can find what already exists instead of billing again (not
 * implemented yet). USD amounts are integer micro-dollars; `budget_micros` is
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
  stop_reason TEXT,
  PRIMARY KEY (run_id, lane)
);
CREATE TABLE IF NOT EXISTS iterations (
  run_id TEXT NOT NULL,
  lane INTEGER NOT NULL,
  iteration INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  PRIMARY KEY (run_id, lane, iteration),
  FOREIGN KEY (run_id, lane) REFERENCES lanes (run_id, lane)
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
  candidate INTEGER NOT NULL,
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
  PRIMARY KEY (run_id, lane, iteration, candidate, attempt),
  FOREIGN KEY (run_id) REFERENCES runs (id)
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

export interface CallKey extends CandidateKey {
  attempt: number;
}

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
}

const CallResultKind = Schema.Literals(["image", "refused", "transient", "failed"]);
const UsageJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Finite));

/** One billable call: its key, its Budget ledger entry and what it returned. */
export interface CallRecord extends CallKey, LedgerEntry {
  result: CallResult["kind"] | null;
  reason: string | null;
  usage: Record<string, number> | null;
}

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
  calls: CallRecord[];
}

const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(RunRequest));
const decodePhotoReport = Schema.decodeUnknownSync(Schema.fromJsonString(ReferencePhotoReport));
const decodePrice = Schema.decodeUnknownSync(Schema.fromJsonString(PriceQuote));
const decodeReferences = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.Int)));
const decodeStopReason = Schema.decodeUnknownSync(Schema.NullOr(LaneStopReason));
const decodeOutcome = Schema.decodeUnknownSync(Schema.fromJsonString(CandidateOutcome));
const decodeResult = Schema.decodeUnknownSync(Schema.NullOr(CallResultKind));
const decodeUsage = Schema.decodeUnknownSync(Schema.NullOr(UsageJson));

/** A `cost_records` row. */
const callRecord = (row: Row): CallRecord => ({
  runId: String(row.run_id),
  lane: Number(row.lane),
  iteration: Number(row.iteration),
  candidate: Number(row.candidate),
  attempt: Number(row.attempt),
  estimateMicros: Number(row.estimated_micros),
  settled: Number(row.settled) === 1,
  actualMicros: row.actual_micros === null ? null : Number(row.actual_micros),
  result: decodeResult(row.result),
  reason: row.reason === null ? null : String(row.reason),
  usage: decodeUsage(row.usage),
});

/** One string per Candidate of a Run, e.g. to match calls to Candidates. */
export const candidateKeyOf = ({ lane, iteration, candidate }: CandidateKey) =>
  `${lane}/${iteration}/${candidate}`;

export class RunStore extends Context.Service<
  RunStore,
  {
    readonly createRun: (run: NewRun) => Effect.Effect<void, RunStoreError>;
    readonly loadRun: (runId: string) => Effect.Effect<StoredRun, RunStoreError>;
    readonly createLane: (runId: string, lane: NewLane) => Effect.Effect<void, RunStoreError>;
    readonly loadLanes: (runId: string) => Effect.Effect<LaneRecord[], RunStoreError>;
    readonly stopLane: (
      runId: string,
      lane: number,
      reason: LaneStopReason,
    ) => Effect.Effect<void, RunStoreError>;
    readonly createIteration: (
      key: IterationKey,
      prompt: string,
    ) => Effect.Effect<void, RunStoreError>;
    readonly loadPrompt: (key: IterationKey) => Effect.Effect<string, RunStoreError>;
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
    readonly settleCall: (key: CallKey, result: CallResult) => Effect.Effect<void, RunStoreError>;
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
    readonly loadCandidates: (
      runId: string,
      lane?: number,
    ) => Effect.Effect<CandidateRecord[], RunStoreError>;
    /**
     * The Run's Candidates and every one of its billable calls (the Budget's
     * ledger, including calls without a Candidate row), read as one snapshot.
     */
    readonly loadRecords: (
      runId: string,
    ) => Effect.Effect<{ candidates: CandidateRecord[]; calls: CallRecord[] }, RunStoreError>;
  }
>()("@iconograph/adapters/RunStore") {}

const json = (value: unknown) => JSON.stringify(value);

export interface LibsqlRunStoreOptions {
  /** Read a database that must already exist, without creating tables. */
  readOnly?: boolean;
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
            const client = createClient({
              url: localDatabaseUrl(databasePath),
              // Mastra writes snapshots to the same file; wait for its locks instead of failing.
              timeout: 5_000,
            });
            if (options.readOnly) return client;
            try {
              await client.executeMultiple(schema);
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
      const reservations = yield* Semaphore.make(1);

      const query = <A>(action: string, run: (client: Client) => Promise<A>) =>
        Effect.tryPromise({
          try: () => run(client),
          catch: (error) =>
            new RunStoreError({
              message: `${action} failed: ${errorMessage(error)}`,
              cause: error,
            }),
        });
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
          const [candidateRows, callRows] = await db.batch(
            [
              {
                sql: `SELECT * FROM candidates WHERE ${where} ORDER BY lane, iteration, candidate`,
                args,
              },
              {
                sql: `SELECT * FROM cost_records WHERE ${where} ORDER BY lane, iteration, candidate, attempt`,
                args,
              },
            ],
            "read",
          );
          const calls = (callRows?.rows ?? []).map(callRecord);
          const callsByCandidate = new Map<string, CallRecord[]>();
          for (const call of calls) {
            const key = candidateKeyOf(call);
            const group = callsByCandidate.get(key);
            if (group) group.push(call);
            else callsByCandidate.set(key, [call]);
          }
          const candidates = (candidateRows?.rows ?? []).map((row): CandidateRecord => {
            const key = {
              runId,
              lane: Number(row.lane),
              iteration: Number(row.iteration),
              candidate: Number(row.candidate),
            };
            return {
              ...key,
              outcome: row.outcome === null ? null : decodeOutcome(row.outcome),
              image:
                row.image_sha256 === null
                  ? null
                  : { sha256: String(row.image_sha256), type: String(row.image_type) },
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
            }));
          }),

        stopLane: (runId, lane, reason) =>
          update(
            `Stopping Lane ${lane} of Run ${runId}`,
            "UPDATE lanes SET stop_reason = ? WHERE run_id = ? AND lane = ?",
            [reason, runId, lane],
          ),

        createIteration: ({ runId, lane, iteration }, prompt) =>
          execute(
            `Saving Iteration ${iteration} of Lane ${lane}`,
            "INSERT INTO iterations (run_id, lane, iteration, prompt) VALUES (?, ?, ?, ?)",
            [runId, lane, iteration, prompt],
          ),

        loadPrompt: ({ runId, lane, iteration }) =>
          query(`Loading the Prompt of Iteration ${iteration}`, async (db) => {
            const { rows } = await db.execute({
              sql: "SELECT prompt FROM iterations WHERE run_id = ? AND lane = ? AND iteration = ?",
              args: [runId, lane, iteration],
            });
            if (!rows[0]) throw new Error(`Iteration ${iteration} of Lane ${lane} not found`);
            return String(rows[0].prompt);
          }),

        // The insert and the reads that explain a rejection run in one write batch: one
        // transaction, one snapshot, executed without yielding in between. So the domain's
        // check sees exactly what the SQL saw, and a disagreement is a real bug. The batch
        // reads the Budget and the whole ledger on every reservation: O(ledger), accepted at
        // M0 sizes (a few dozen calls per Run).
        reserveCall: (key, model, estimate) =>
          query(`Reserving call ${key.attempt} of Candidate ${key.candidate}`, async (db) => {
            const [inserted, budget, ledger] = await db.batch(
              [
                {
                  sql: `INSERT INTO cost_records
                          (run_id, lane, iteration, candidate, attempt, model, created_at, estimated_micros, estimated_usage)
                        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
                        WHERE MAX(0, (SELECT budget_micros FROM runs WHERE id = ?)
                          - (SELECT ${committedSql} FROM cost_records WHERE run_id = ?)) >= ?`,
                  args: [
                    key.runId,
                    key.lane,
                    key.iteration,
                    key.candidate,
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
            reservations.withPermits(1),
            Effect.flatMap((exhausted) => (exhausted ? Effect.fail(exhausted) : Effect.void)),
          ),

        // A recorded result is final: settling twice (e.g. an interrupt racing a settle)
        // fails instead of overwriting the actual cost.
        settleCall: (key, result) =>
          update(
            `Recording call ${key.attempt} of Candidate ${key.candidate}`,
            `UPDATE cost_records SET settled = 1, actual_micros = ?, usage = ?, result = ?, reason = ?
             WHERE run_id = ? AND lane = ? AND iteration = ? AND candidate = ? AND attempt = ?
               AND settled = 0`,
            [
              result.costMicros,
              "usage" in result && result.usage ? json(result.usage) : null,
              result.kind,
              "reason" in result ? result.reason : null,
              key.runId,
              key.lane,
              key.iteration,
              key.candidate,
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

        loadCandidates: (runId, lane) =>
          loadRecords(runId, lane).pipe(Effect.map(({ candidates }) => candidates)),

        loadRecords: (runId) => loadRecords(runId),
      };
    }),
  );
