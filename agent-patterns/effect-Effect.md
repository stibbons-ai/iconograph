# Effect (core) — agent pattern note (effect@4.1.2)

Source of truth: `vendor/effect/packages/effect/src/Effect.ts`. Guides: `vendor/effect/LLMS.md`,
`vendor/effect/ai-docs/src/01_effect/`, `vendor/effect/migration/*.md`. Tests:
`vendor/effect/packages/effect/test/Effect.test.ts`. Training-data v3 names are often wrong — grep before use.

`Effect<A, E = never, R = never>`: success `A`, typed error `E`, required services `R`.
Type extractors: `Effect.Success`, `Effect.Error`, `Effect.Services` (v3 `Effect.Context` is gone).

## Constructors

| Need | API |
|---|---|
| value in hand | `Effect.succeed(x)`, `Effect.void` |
| typed failure | `Effect.fail(err)` |
| defect (bug, not recoverable by `catch`) | `Effect.die(x)` |
| sync side effect, never throws | `Effect.sync(() => ...)` |
| sync code that may throw | `Effect.try({ try, catch })`; bare thunk → `Cause.UnknownError` |
| Promise that never rejects | `Effect.promise((signal) => ...)` (rejection = defect) |
| Promise that may reject | `Effect.tryPromise({ try: (signal) => ..., catch })`; bare thunk → `Cause.UnknownError` |
| lazy construction | `Effect.suspend(() => effect)` |
| callback API | `Effect.callback<A>((resume) => { ...; return cleanupEffect })` (v3 `async`) |
| nullable | `Effect.fromNullishOr(v)` → `Cause.NoSuchElementError` |
| Option / Result | `Effect.fromOption(o, onNone?)`, `Effect.fromResult(r)` |

From `vendor/effect/ai-docs/src/01_effect/01_basics/10_creating-effects.ts`:

```ts
export const parsePayload = Effect.fn("parsePayload")((input: string) =>
  Effect.try({
    try: () => JSON.parse(input) as { readonly userId: number },
    catch: (cause) => new InvalidPayload({ input, cause })
  })
)
export const fromCallback = Effect.callback<number>((resume) => {
  const timeoutId = setTimeout(() => resume(Effect.succeed(200)), 10)
  return Effect.sync(() => clearTimeout(timeoutId)) // runs on interruption
})
```

`try`/`promise`/`tryPromise` pass an `AbortSignal` (aborted on interruption) only if the thunk
declares it as a plain parameter — `(...args)` or `(signal = x)` get `undefined` (Effect.ts `tryPromise` doc).

## Effect.gen / Effect.fn

- Inline code: `Effect.gen(function*() { const x = yield* eff; ... })`.
- Reusable function: `Effect.fn("name")(function*(arg) {...}, ...pipeables)` — adds a span + stack frame.
  `Effect.fnUntraced(function*...)` for hot paths/library code. Never write `(x) => Effect.gen(...)` wrappers.
- Annotate return: `function*(n: number): Effect.fn.Return<string, SomeError> { ... }`.
- Extra combinators go as extra args to `Effect.fn`, NOT `.pipe` on the result (LLMS.md).
- Fail inside gen: `return yield* new MyError({...})` or `return yield* Effect.fail(e)` — the `return` keeps narrowing.
- `this` binding: `Effect.gen({ self: this }, function*() {...})` (v3 `Effect.gen(this, ...)` removed; `migration/generators.md`).

```ts
// vendor/effect/LLMS.md
export const effectFunction = Effect.fn("effectFunction")(
  function*(n: number): Effect.fn.Return<string, SomeError> {
    yield* Effect.logInfo("Received number:", n)
    return yield* new SomeError({ message: "Failed to read the file" })
  },
  Effect.catch((error) => Effect.logError(`An error occurred: ${error}`)),
  Effect.annotateLogs({ method: "effectFunction" })
)
```

## Transform / sequence

- `Effect.map(f)`, `Effect.as(v)`, `Effect.asVoid`, `Effect.mapError(f)`, `Effect.mapBoth`.
- `Effect.flatMap(a => eff)`; `Effect.andThen(eff | a => eff)` — v4 `andThen`/`tap` accept only an Effect or a
  function returning an Effect (no plain values/Promises as in v3).
- `Effect.tap(a => eff)` keeps `a`; `Effect.tapError`, `Effect.tapCause` (v3 `tapErrorCause`), `Effect.tapDefect`.
- `Effect.zip`, `Effect.zipWith`, `Effect.flatten`, `Effect.filterOrFail`, `Effect.when`.
- `Effect.match({ onFailure, onSuccess })`, `Effect.matchEffect({...})`.

## Typed errors

Define with `Schema.TaggedError` (LLMS default) or `Data.TaggedError` (this repo's majority). Both are
yieldable: `yield* new E(...)` fails.

```ts
export class ParseError extends Schema.TaggedError<ParseError>()("ParseError", {
  input: Schema.String,
  message: Schema.String
}) {}
class TodoFetchError extends Data.TaggedError("TodoFetchError")<{ readonly cause: unknown }> {}
```

Recovery (`migration/error-handling.md`):

| v3 | v4 |
|---|---|
| `catchAll` | `Effect.catch` |
| `catchAllCause` | `Effect.catchCause` |
| `catchAllDefect` | `Effect.catchDefect` |
| `catchSome` | `Effect.catchFilter` (uses `Filter`) |
| `orElse` | `Effect.catch(() => that)` |
| `either` | `Effect.result` (→ `Result`) |
| `catchTag`, `catchTags`, `catchIf` | unchanged |

```ts
// vendor/effect/LLMS.md + ai-docs/src/01_effect/04_errors/10_catch-tags.ts
loadPort("80").pipe(Effect.catchTag(["ParseError", "ReservedPortError"], () => Effect.succeed(3000)))
fetchUser("123").pipe(Effect.catchTags({
  ValidationError: (e) => Effect.succeed(`Validation failed: ${e.message}`),
  NetworkError: (e) => Effect.succeed(`status ${e.statusCode}`)
}))
```

- `catchTag(tag, f, orElse?)` — optional third arg handles the remaining errors.
- Nested `reason` errors: `Effect.catchReason(errorTag, reasonTag, f)`, `Effect.catchReasons`, `Effect.unwrapReason`
  (`ai-docs/src/01_effect/04_errors/20_reason-errors.ts`).
- Escape hatches: `Effect.orDie`, `Effect.orElseSucceed(() => v)`, `Effect.ignore` /
  `Effect.ignore({ log: "Warn", message })` (v3 `ignoreLogged`), `Effect.option`, `Effect.exit` (→ `Exit`).
- Timeouts: `Effect.timeout(d)` adds `Cause.TimeoutError`; `Effect.timeoutOption(d)`;
  `Effect.timeoutOrElse({ duration, orElse })` (v3 `timeoutFail`/`timeoutTo`).
- Retry: `Effect.retry({ times })`, `Effect.retry({ schedule, while, until })`, `Effect.retry(Schedule.exponential(...))`.

## Concurrency

- `Effect.all(tuple | iterable | record, { concurrency?, discard?, mode? })`. Default sequential, short-circuits
  on first failure. `concurrency: number | "unbounded"`. `mode: "result"` → each slot a `Result`, never fails.
- `Effect.forEach(items, (a, i) => eff, { concurrency?, discard? })`.
- `Effect.partition(items, f)` → `[passes, fails]` (order reversed vs v3); `Effect.validate` (v3 `validateAll`).
- `Effect.race`, `Effect.raceAll`.
- Fibers: `Effect.forkChild` (v3 `fork`), `Effect.forkDetach` (v3 `forkDaemon`), `Effect.forkScoped`, `Effect.forkIn`;
  options `{ startImmediately?, uninterruptible? }`. Join with `Fiber.join(fiber)` / `Fiber.interrupt(fiber)` —
  `Fiber` is no longer an Effect (`migration/yieldable.md`).
- No ambient `Effect.withConcurrency` in v4: pass `concurrency` per call.
- Interruption: `Effect.uninterruptible`, `Effect.onInterrupt(() => eff)`.

```ts
// vendor/effect/packages/effect/test/Effect.test.ts ("all")
Effect.all({ a: Effect.sleep(20).pipe(Effect.as(1)), b: Effect.fail("boom") },
  { concurrency: "unbounded", mode: "result" })
// => { a: Result.succeed(1), b: Result.fail("boom") }
```

## Resources / Scope

- `Effect.acquireRelease(acquire, (a, exit) => release)` adds `Scope` to `R`; close it with `Effect.scoped`
  or inside a `Layer.effect` (layer lifetime). `Effect.acquireUseRelease(acquire, use, release)` needs no Scope.
- `Effect.addFinalizer(exit => eff)`, `Effect.ensuring(eff)`, `Effect.onExit(exit => eff)`, `Effect.scope`.
- `Scope.extend` → `Scope.provide` (`migration/scope.md`).

```ts
// vendor/effect/packages/effect/test/Effect.test.ts ("acquireRelease")
Effect.acquireRelease(Effect.delay(Effect.succeed("foo"), 100), () => Effect.sync(() => { release = true }))
  .pipe(Effect.scoped, Effect.forkChild({ startImmediately: true }))
```

## Services & running

- Access: `yield* MyService` (a `Context.Service` is an Effect). Provide: `Effect.provide(layer)`,
  `Effect.provideService(Tag, impl)`, `Effect.provideContext(ctx)`.
- Run (needs `R = never`): `Effect.runPromise`, `Effect.runPromiseExit`, `Effect.runFork` (→ `Fiber`),
  `Effect.runSync`/`Effect.runSyncExit` (sync only), `Effect.runCallback`. `RunOptions`: `{ signal?, ... }`.
- `runPromise` rejects on failure; prefer `runPromiseExit` + `Exit.match` / `Cause.pretty` when you need the cause.
- v3 `Runtime<R>` / `Effect.runtime` removed: use `Effect.context<R>()` + `Effect.runForkWith(ctx)` /
  `Effect.runPromiseWith(ctx)` (`migration/runtime.md`).
- App-wide runtime from a Layer: `ManagedRuntime.make(layer)` → `runtime.runPromise(eff)`, `runtime.dispose()`
  (`ai-docs/src/04_integration/10_managed-runtime.ts`). Process entrypoints: `ai-docs/src/01_effect/06_running/`.

## This repo's conventions

- CLIs: `Effect.runPromise(program.pipe(Effect.provide(embedders), Effect.scoped, Effect.provide(Logger.layer([...]))))`
  (`packages/adapters/src/photos-cli.ts`).
- Long-lived app: one `ManagedRuntime.make(Layer.mergeAll(...))`, disposed on shutdown (`packages/server/src/index.ts`).
- Vendor calls: `Effect.promise(async (signal) => ...)` that never fails — outcomes are result unions, not errors
  (`packages/adapters/src/openai.ts`, `gemini.ts`). Library wrappers: `Effect.tryPromise({ try, catch })` → tagged error.
- Interrupt-safe bookkeeping: `Effect.uninterruptible` + `Effect.onInterrupt` (`packages/domain/src/image-model.ts`).

## Pitfalls (v3 → v4)

- Removed/renamed: `catchAll`→`catch`, `catchAllCause`→`catchCause`, `either`→`result`, `fork`→`forkChild`,
  `forkDaemon`→`forkDetach`, `async`→`callback`, `zipRight`→`andThen`, `zipLeft`→`zip`+`map`, `tapErrorCause`→`tapCause`,
  `tryMap`→`flatMap`+`try`, `ensureSuccessType`→`satisfiesSuccessType`, `daemonChildren`→`awaitAllChildren`,
  `Effect.Tag`/`Effect.Service`→`Context.Service` (no auto `Default` layer). Gone: `forkAll`, `withConcurrency`, `Runtime<R>`.
- `Option`, `Result`, `Ref`, `Deferred`, `Fiber` are NOT Effects: use `Effect.fromOption`, `Ref.get`,
  `Deferred.await`, `Fiber.join`. `Config` and services still are.
- Typed recovery (`catch`, `catchTag`, `retry`, `result`, `ignore`, ...) skips causes that also contain a defect;
  use `catchCause`/`catchDefect` for those. `mapError` maps every typed error and preserves the cause.
- `Effect.promise` rejection is a defect, not `E`. `Effect.die` is uncatchable by `catch`.
- Forgetting `return` before `yield* fail` leaves TS thinking the code continues.
- Layers: nested `Effect.provide` reuses layers built by an enclosing provide/runtime, but sibling
  `Effect.provide` calls each build their own copy; `{ local: true }` forces fresh (`migration/layer-memoization.md`).
