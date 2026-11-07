# Effect 4.1.2 — Services, Layer, ManagedRuntime

Source of truth: `vendor/effect/packages/effect/src/{Context,Layer,ManagedRuntime}.ts`.
Docs: `vendor/effect/LLMS.md` ("Writing Effect services"), `vendor/effect/ai-docs/src/01_effect/03_services/`,
`vendor/effect/migration/{services,layer-memoization,runtime}.md`.
Type order: `Layer.Layer<ROut, E = never, RIn = never>` (provides, build error, requires).

## Define a service — `Context.Service`
```ts
import { Context, Effect, Layer } from "effect"

// Class form (preferred). Type params first, then the string key.
export class FaceEmbedder extends Context.Service<FaceEmbedder, {
  readonly model: string
  readonly detect: (image: RgbImage) => Effect.Effect<readonly DetectedFace[], FaceModelError>
}>()("@iconograph/domain/FaceEmbedder") {}

type FaceEmbedderShape = FaceEmbedder["Service"] // the shape type

// Function form (no class):
const Probe = Context.Service<string>("Probe")
```
- Key string is the runtime identity — two services with the same key collide. App convention: `"@iconograph/<pkg>/<Name>"`.
- Static members on the key: `FaceEmbedder.of(impl)` (typed identity helper), `.use(f)`, `.useSync(f)`, `.context(impl)`, `.key`.
- Access: `const fe = yield* FaceEmbedder` (preferred; dependency visible) or `FaceEmbedder.use((fe) => fe.detect(img))` one-liner (used in `packages/server/src/run-steps.ts`).
- Optional `make` stores a constructor on the class; it does NOT create a layer:
  ```ts
  class Logger extends Context.Service<Logger>()("Logger", { make: Effect.gen(function*() { ... }) }) {
    static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(Config.layer))
  }
  ```
  (`vendor/effect/migration/services.md`)
- Services with a default (no layer required): `Context.Reference<boolean>("myapp/FeatureFlag", { defaultValue: () => false })`
  (`ai-docs/src/01_effect/03_services/10_reference.ts`). Override with `Effect.provideService(FeatureFlag, true)`.

## Constructors
| API | Use |
|---|---|
| `Layer.succeed(Tag)(impl)` / `Layer.succeed(Tag, impl)` | ready value |
| `Layer.sync(Tag)(() => impl)` | lazy value |
| `Layer.effect(Tag)(effect)` / `Layer.effect(Tag, effect)` | effectful + **scoped** construction (replaces v3 `Layer.scoped`) |
| `Layer.effectDiscard(effect)` | side effect / background fiber, provides nothing |
| `Layer.effectContext(eff)`, `Layer.succeedContext(ctx)` | several services at once |
| `Layer.unwrap(effectOfLayer)` | choose layer at build time (config-driven) |
| `Layer.empty`, `Layer.suspend(() => layer)` | identity / lazy |
| `Layer.mock(Tag, partialImpl)` | tests; missing Effect members die with `UnimplementedError` |

`Layer.effect`/`effectDiscard` strip `Scope` from requirements: `Effect.acquireRelease`, `Effect.addFinalizer`, `Effect.forkScoped` inside run in the layer's scope and release when the layer is torn down.
```ts
// packages/adapters/src/run-store.ts pattern
export const LibsqlRunStore = (path: string) =>
  Layer.effect(RunStore)(Effect.gen(function*() {
    const client = yield* Effect.acquireRelease(
      Effect.tryPromise({ try: () => open(path), catch: (cause) => new RunStoreError({ cause }) }),
      (c) => Effect.sync(() => c.close()),
    )
    return RunStore.of({ /* methods via Effect.fn("RunStore.x")(...) */ })
  }))
```
Background task layer: `ai-docs/src/01_effect/05_resources/20_layer-side-effects.ts`.
Config-driven: `ai-docs/src/01_effect/03_services/20_layer-unwrap.ts`.

## Composing
```ts
// dependency hidden: Layer<UserRepository, ConfigError | SqlError>
static readonly layer = this.layerNoDeps.pipe(Layer.provide(SqlClientLayer))
// dependency also exposed: Layer<UserRepository | SqlClient, ...>
static readonly layerWithSqlClient = this.layerNoDeps.pipe(Layer.provideMerge(SqlClientLayer))
```
(`ai-docs/src/01_effect/03_services/20_layer-composition.ts`)
- `Layer.merge(a, b)` / `Layer.mergeAll(a, b, c, ...)` — side-by-side, built concurrently, union of outputs/errors/requirements.
- `Layer.provide(dep)` / `Layer.provideMerge(dep)` also accept an array: `Layer.provide([dbLayer, loggerLayer])`.
- Naming convention (v4): `layer` = primary; `layerNoDeps`, `layerTest`, `layerConfig` for variants. Older app code uses factories like `OnnxFaceEmbedder(options)`.
- Other combinators: `Layer.updateService(Tag, f)`, `Layer.tap`, `Layer.tapError`, `Layer.tapCause`, `Layer.flatMap`.

## Error handling (build failures)
- Build error `E` is typed: `Layer.catch(() => fallback)`, `Layer.catchTag("Tag", () => fallback)`, `Layer.catchCause`, `Layer.orDie`
  (`vendor/effect/packages/effect/test/Layer.test.ts` "catch - uses an alternative layer").
- Test a startup failure without a runtime (app pattern, `packages/adapters/test/face-pipeline.test.ts`):
  `Effect.runPromise(Effect.flip(Effect.scoped(Layer.build(layer))))`.

## Providing to effects
```ts
program.pipe(Effect.provide(AppLayer))                  // one layer
program.pipe(Effect.provide([A.layer, B.layer]))        // array
program.pipe(Effect.provide(layer, { local: true }))    // fresh memo map (test isolation)
program.pipe(Effect.provideService(Tag, impl))          // single value, no layer
program.pipe(Effect.provideContext(Context.make(Tag, impl)))
```
Compose once, provide once at the edge. Inside a service, depend on other services via `yield*` in `Layer.effect`, not by calling `Effect.provide` per method.

## Memoization
- Layers are memoized **by object identity** within a build (`Layer.test.ts` "memoizes composed layers by identity"): the same `const` used twice in a graph builds once.
- Factory functions (`(opts) => Layer.effect(...)`) return a new layer per call → built again each call. Call the factory once and reuse the value.
- v4: nested `Effect.provide` reuses layers built by an enclosing provide/runtime; sibling provides still build separately (`migration/layer-memoization.md`).
- Opt out: `Layer.fresh(layer)` or `Effect.provide(layer, { local: true })`.
- Advanced: `Layer.makeMemoMapUnsafe()`, `Layer.buildWithMemoMap`, `Layer.CurrentMemoMap`.

## Entry points
**Long-running Effect program:** `Layer.launch(AppLayer)` → `Effect<never, E, RIn>`; run with platform `runMain`
(`ai-docs/src/01_effect/06_running/20_layer-launch.ts`).

**Non-Effect host (Mastra, Hono, CLI, tests):** `ManagedRuntime`.
```ts
const runtime = ManagedRuntime.make(
  Layer.mergeAll(faceEmbedder, imageModels, LibsqlRunStore(dbPath), Layer.succeed(RunConfig)(cfg))
    .pipe(Layer.provideMerge(Logger.layer([warningLogger(warn)]))),
) // packages/server/src/index.ts
await runtime.runPromise(RunStore.use((s) => s.loadRun(id)))
await runtime.dispose()                              // runs layer finalizers
```
- Members: `runPromise`, `runPromiseExit`, `runSync`, `runSyncExit`, `runFork`, `runCallback`, `dispose`, `disposeEffect`, `context()`, `contextEffect`, `memoMap`.
- Layer is built lazily on first run and memoized (`test/ManagedRuntime.test.ts` "memoizes the layer build"). Build failure → first `runPromise` rejects.
- `make` needs `RIn = never`: provide all deps first.
- Share builds between runtimes: `ManagedRuntime.make(layer, { memoMap: other.memoMap })` or one module-level `Layer.makeMemoMapUnsafe()`.
- Supports `await using runtime = ManagedRuntime.make(layer)` (`test/ManagedRuntime.test.ts` "supports await using").
- Type a runtime param: `ManagedRuntime.ManagedRuntime<RunServices, unknown>` (`packages/server/src/workflow.ts`).
- Always `dispose()` (tests: `afterAll(() => runtime.dispose())`, as in `packages/adapters/test/held-out.test.ts`).

## Testing
- App tests use `bun:test` + `ManagedRuntime` or `Effect.runPromise(program.pipe(Effect.provide(fakeLayer)))`.
- Fakes: `Layer.succeed(Tag)({ ...fake })`, or `Layer.mock(Tag, { onlyWhatTestNeeds })`.
- Wrap a real service: `Layer.effect(Tag)(Effect.gen(function*() { const real = yield* Tag; return { ...real, detect: faulty } })).pipe(Layer.provide(realLayer))` (`packages/eval-harness/test/eval.test.ts` `faultyHeldOut`).
- Add a finalizer-only layer: `Layer.merge(real, Layer.effectDiscard(Effect.addFinalizer(() => Effect.logWarning("..."))))`.
- Expose test state: `layerTest = layerNoDeps.pipe(Layer.provideMerge(TestRefService.layer))` (`ai-docs/src/09_testing/20_layer-tests.ts`).

## v3 → v4 pitfalls (names below are gone in 4.1.2 unless noted)
| v3 | v4 |
|---|---|
| `Context.Tag("Id")<Self, Shape>()` | `Context.Service<Self, Shape>()("Id")` |
| `Context.GenericTag<T>("Id")` | `Context.Service<T>("Id")` |
| `Effect.Tag` static accessors (`Svc.method()`) | `yield* Svc` or `Svc.use(...)` — no proxy accessors |
| `Effect.Service` + auto `.Default` + `dependencies` | `Context.Service(..., { make })` + explicit `static layer = Layer.effect(this, this.make).pipe(Layer.provide(...))` |
| `Context.Reference<Self>()(id, opts)` | `Context.Reference<T>(id, opts)` |
| `Layer.scoped` / `Layer.scopedDiscard` | `Layer.effect` / `Layer.effectDiscard` (already scoped) |
| `Layer.unwrapEffect` / `Layer.unwrapScoped` | `Layer.unwrap` |
| `Runtime.runFork(runtime)`, `Effect.runtime<R>()` | `Effect.context<R>()` + `Effect.runForkWith(ctx)` / `Effect.runPromiseWith(ctx)` |
| `.Default` / `.Live` naming | `.layer`, `.layerTest`, ... |
- `Layer.catchAll` doesn't exist; use `Layer.catch`.
- Don't pass `Scope` around manually; `Layer.effect` handles it. Use `Effect.scoped` only around `Layer.build` or ad-hoc resources.
- Same key string = same service; never reuse keys across packages.
