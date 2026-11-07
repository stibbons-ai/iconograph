# Effect 4 `Schema` — agent pattern note

Source of truth: `vendor/effect/packages/effect/src/Schema.ts` (+ `SchemaGetter.ts`, `SchemaTransformation.ts`, `SchemaIssue.ts`, `SchemaAST.ts`, `StandardSchema.ts`).
Docs: `vendor/effect/ai-docs/src/01_effect/02_schema/10_schema-basics.ts`, `vendor/effect/migration/schema.md`. Tests: `vendor/effect/packages/effect/test/schema/`.
Import: `import { Schema, SchemaGetter, SchemaIssue, SchemaTransformation, Struct } from "effect"`.

## Primitives & refinements
- `String Number Boolean BigInt Symbol Unknown Null Undefined Void Never Any`.
- `Number` accepts `NaN`/`±Infinity`; use `Finite` (app default) or `Int`. Ready-made: `NonEmptyString`, `Trimmed`, `Int`, `Finite`.
- Checks: `schema.check(filter, ...)` (also `Schema.check(...)` in `pipe`). Built-in filters use an `is` prefix:
  `isGreaterThan isGreaterThanOrEqualTo isLessThanOrEqualTo isBetween({ minimum, maximum }) isInt isMinLength isMaxLength isBetweenLength(min, max) isNonEmpty isPattern(re) isUUID() isTrimmed`.
- Custom: `Schema.makeFilter(pred)`. `pred` returns `true`/`undefined` (ok), `false`, a message `string`, a `SchemaIssue.Issue`, `{ path, issue }`, or an array of `Schema.FilterIssue`.
- Type-narrowing: `Schema.refine(refinement)`.

```ts
// packages/adapters/src/vendor-http.ts, packages/adapters/src/models.ts
export const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
const notInsightFace = Schema.makeFilter<string>((v) =>
  insightFace.test(v) ? "InsightFace weights are opt-in and never fetched automatically" : true)
// Cross-field check, failure attached to a path (migration/schema.md#filter)
Schema.Struct({ password: Schema.String, confirmPassword: Schema.String }).check(
  Schema.makeFilter((o) => o.password === o.confirmPassword ? undefined
    : { path: ["password"], issue: "password and confirmPassword must match" }))
```

## Struct, optional fields, defaults
- `Schema.Struct({...})`; reuse fields by spreading `Other.fields`.
- `Schema.optionalKey(S)` → `a?: T` exact (key may be absent; `undefined` is rejected). The app uses this most.
- `Schema.optional(S)` → `a?: T | undefined`.
- Change a struct's fields with `.mapFields(...)` and the `Struct` module helpers: `Struct.pick([...])`, `Struct.omit([...])`, `Struct.map(Schema.optional)` (partial), `Struct.map(Schema.requiredKey)`, and `Struct.assign(fields)`. The last one is the same as `Schema.fieldsAssign(fields)`.
- Defaults: `withDecodingDefaultKey(Effect.succeed(x))` fills in an absent key. `withDecodingDefault` also covers `undefined`. The `...Type`/`...TypeKey` variants take the default as a `Type` value. `withConstructorDefault` applies only to `make`/`new`.
- `StructWithRest`, `Record(key, value)`, `Tuple([...])`, `Array(S)`, `NonEmptyArray(S)`, `mutable(...)`.
- Excess keys are **stripped** by default. To reject them, pass the parse option `{ onExcessProperty: "error" }`, e.g. `Schema.decodeUnknownSync(PriceFields, { onExcessProperty: "error" })` (`packages/adapters/src/prices.ts`).
- `S.make(input)`, `S.makeOption(input)` and `S.makeEffect(input)` build a validated `Type` value and apply constructor defaults.

```ts
const schema = Schema.Struct({
  name: Schema.String.pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed("anonymous")))
}) // Schema.ts doc of withDecodingDefault
const partial = Schema.Struct({ a: Schema.String, b: Schema.Number }).mapFields(Struct.map(Schema.optionalKey))
```

## Literal, Union, tagged unions
- `Literal("a")` takes one value. `Literals(["a", "b"])` takes an **array** and has `.pick([...])` and `.transform([...])`.
- `Union([A, B])` takes an **array** and has `.mapMembers(...)`. Shorthands: `NullOr(S)`, `UndefinedOr(S)`, `NullishOr(S)`. `Null` replaces v3 `Literal(null)`.
- `TaggedStruct("A", fields)` is the same as `Struct({ _tag: tag("A"), ...fields })`. `make` fills the `_tag`, but decoding requires it. Use `tagDefaultOmit("A")` to drop the tag on encode.
- `TaggedUnion({ Circle: {...}, Rectangle: {...} })`, or `Union([...]).pipe(Schema.toTaggedUnion("_tag"))`, provides `.cases`, `.guards`, `.isAnyOf`, `.match` and `.matchOrElse`.
- `Enum(TsEnum)`, `TemplateLiteral([...])`.

## Brands, opaque types, classes, errors
- `Schema.String.pipe(Schema.brand("UserId"))` changes the type only and adds **no runtime check**. Put the checks before it, e.g. `Schema.Int.check(...).pipe(Schema.brand("Id"))`. The identifier must be a single string literal. `fromBrand(id, BrandCtor)` also applies the `Brand` constructor's checks.
- `class P extends Schema.Opaque<P>()(Schema.Struct({...})) {}` gives a nominal type with no class instances.
- `Schema.Class<Self>("Id")({ ...fields })`: `new X(...)` validates its input. To subclass, use `Base.extend<Child>("Child")({...})`; a plain `extends Base` is unsupported.
- `Schema.TaggedClass<Self>()("Tag", fields)`.
- `Schema.Error<Self>("Id")(fields)` and `Schema.TaggedError<Self>()("Tag", fields)` are yieldable errors: write `yield* new NotFound({ id })` in `Effect.gen`. v3's `TaggedError` signature stays the same. App: `BudgetExhausted` (`packages/domain/src/budget.ts`) and `Unpriced` (`packages/domain/src/prices.ts`).

```ts
// vendor/effect/ai-docs/src/01_effect/02_schema/10_schema-basics.ts
export class User extends Schema.Class<User>("path/to/module/User")({
  id: Schema.Int, name: Schema.NonEmptyString, role: Schema.Literals(["admin", "member"])
}) {}
export class InvalidUserPayload extends Schema.TaggedError<InvalidUserPayload>()("InvalidUserPayload", {
  message: Schema.String
}) {}
export const parseUserPayload = Effect.fn("parseUserPayload")((input: unknown) =>
  Schema.decodeUnknownEffect(User)(input).pipe(
    Effect.mapError((error) => new InvalidUserPayload({ message: error.message }))))
```

## Transformations / codecs
Each schema has a `Type` (decoded side) and an `Encoded` side: `typeof S["Type"]`, `typeof S["Encoded"]`. `toType(S)` and `toEncoded(S)` return just one side.
- `from.pipe(Schema.decodeTo(to, { decode: Getter, encode: Getter }))`. Without a transformation it composes the two schemas, which requires `From["Type"]` to match `To["Encoded"]`.
- `SchemaTransformation.transform({ decode, encode })` is the pure, total case.
- Getters in `SchemaGetter` are `transform`, `transformEffect`, `transformOptional`, `checkEffect`, `passthrough`, `withDefault`, `omit`, `String`, `Number` and `trim`.
- `Schema.decode({ decode, encode })` transforms a schema to its own type (`Type`→`Type`). `encodeTo` mirrors `decodeTo`.
- Built-in codecs:
  - numbers: `NumberFromString`, `FiniteFromString`
  - dates: `DateFromString`, `DateFromMillis`, `DateTimeUtcFromString`
  - JSON: `fromJsonString(S)`, `UnknownFromJsonString`
  - others: `OptionFromNullOr(S)`, `Trim`, `URL`, `RedactedFromValue`
- Use `toCodecJson(S)` to get a JSON-safe codec and `toJsonSchemaDocument(S)` to get a JSON Schema document.
- Renaming keys: `encodeKeys`. Recursive schemas: `suspend(() => S)`. Fallback on decode failure: `catchDecoding`.

```ts
// migration/schema.md#transform / #transformorfail
const BooleanFromString = Schema.Literals(["on", "off"]).pipe(Schema.decodeTo(Schema.Boolean,
  SchemaTransformation.transform({ decode: (l) => l === "on", encode: (b) => (b ? "on" : "off") })))
const NumberFromString = Schema.String.pipe(Schema.decodeTo(Schema.Number, {
  decode: SchemaGetter.transformEffect((s) => Option.match(Number.parse(s), {
    onNone: () => Effect.fail(new SchemaIssue.InvalidValue()), onSome: Effect.succeed })),
  encode: SchemaGetter.String()
}))
// app: JSON columns, packages/adapters/src/run-store.ts
const decodeJudgement = Schema.decodeUnknownSync(Schema.fromJsonString(Judgement))
const encodeJudgement = Schema.encodeSync(Schema.fromJsonString(Judgement))
```

## Decode / encode API matrix
All have the form `fn(schema, options?)(input, options?)`. Options given when the input is applied override those given at creation.
The `decodeUnknown*` variants take `unknown`. The `decode*` variants take an input typed as `Encoded`. `encode*` works the same way.

| Variant | Returns | Failure |
|---|---|---|
| `decodeUnknownSync` / `decodeSync` / `encodeSync` / `encodeUnknownSync` | value | throws `SchemaError` |
| `decodeUnknownEffect` / `decodeEffect` / `encodeEffect` / `encodeUnknownEffect` | `Effect` | `SchemaError` in the error channel; carries the `DecodingServices`/`EncodingServices` requirements |
| `decodeUnknownExit` / `decodeExit` / `encodeExit` / `encodeUnknownExit` | `Exit` | `Exit` failure holding `SchemaError` |
| `decodeUnknownResult` / `decodeResult` / `encodeResult` / `encodeUnknownResult` | `Result` | `result.failure` (a `SchemaError`) |
| `decodeUnknownOption` / `decodeOption` / `encodeOption` / `encodeUnknownOption` | `Option` | `None` (the app uses this for vendor bodies) |
| `decodeUnknownPromise` / `decodePromise` / `encodePromise` / `encodeUnknownPromise` | `Promise` | rejects |

- Guards: `Schema.is(S)(u)` is a type guard; `Schema.asserts(S, input)` is an assertion function (in v3 it was curried).
- Build each parser **once** at module scope and reuse it, as the app does.
- The parse options are `errors: "first" | "all"` (default `"first"`), `onExcessProperty`, `disableChecks`, `concurrency` and `reportInput`. All are defined in `SchemaAST.ts`.

## Errors and issues
- Parsing fails with `Schema.SchemaError`, whose `_tag` is `"SchemaError"`. `.issue` holds a `SchemaIssue.Issue` tree and `.message` is that tree run through the default formatter. Check for it with `Schema.isSchemaError(e)`.
- Issue nodes in `SchemaIssue` are `InvalidType`, `InvalidValue`, `MissingKey`, `UnexpectedKey`, `Pointer` (path), `Composite`, `AnyOf`, `OneOf`, `Filter`, `Encoding` and `Forbidden`. Check for one with `SchemaIssue.isIssue`.
- Formatting:
  - `SchemaIssue.defaultFormatter(issue)` returns a string.
  - `SchemaIssue.makeFormatterStandardSchemaV1()(issue).issues` returns `[{ path, message }]`. It replaces v3's `ArrayFormatter`.
- The `annotate({ message, identifier, description, expected })` annotations set custom messages. For checks, pass them as the filter's `annotations` argument.
- Caution: `migration/schema.md#parseresult-formatters` reads `error.cause`. That only works for the `SchemaParser.*Sync` adapters. `Schema.decodeUnknownSync` throws a `SchemaError`, so read `e.issue` instead.

## StandardSchema interop
- `Schema.toStandardSchemaV1(S, { leafHook?, checkHook?, parseOptions? })` returns `S & StandardSchemaV1<Encoded, Type>`, which validates synchronously.
- `Schema.toStandardJSONSchemaV1(S)` adds `~standard` JSON Schema output.
- Only types live in `effect/StandardSchema`: `StandardSchemaV1`, `StandardJSONSchemaV1`, `StandardTypedV1`.
- App pattern (`packages/adapters/src/schema.ts`), which caches the adapter per schema in a `WeakMap`:
  ```ts
  Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema))
  ```
  Constrain generic helpers with `Schema.ConstraintDecoder<unknown>`, or `Schema.Codec<T, E>` when the encoded side matters.

## v3 → v4 pitfalls (migration/schema.md)
- **Variadic arguments became arrays**: `Literals([...])`, `Union([...])`, `Tuple([...])`, `TemplateLiteral([...])`. `Record({ key, value })` became `Record(key, value)`.
- **Decode/encode renames**: `decodeUnknown`→`decodeUnknownEffect`, `decode`→`decodeEffect`, `*Either`→`*Exit` (or `*Result`). `validate*` is removed; decode against `toType(S)` instead.
- **Filters**: `filter`→`check(makeFilter(...))` or `refine`. `pattern`→`check(isPattern(...))`. `minLength`→`isMinLength`, `int`→`isInt`, and so on. `positive`, `nonNegative`, etc. are **removed**; use `isGreaterThan(0)` or `isGreaterThanOrEqualTo(0)`.
- **Other renames**:
  - `compose`→`decodeTo`, `annotations`→`annotate`, `parseJson`→`fromJsonString`
  - `typeSchema`→`toType`, `encodedSchema`→`toEncoded`, `asSchema`→`revealCodec`
  - `pretty`→`toFormatter`, `equivalence`→`toEquivalence`, `standardSchemaV1`→`toStandardSchemaV1`
- **`*FromSelf` lost its suffix**: `DateFromSelf`→`Date`, `OptionFromSelf`→`Option`, etc. **Trap:** v4 `Schema.Date` expects a `Date` as input. For ISO strings, use `DateFromString`. v3 `Redacted` is now `RedactedFromValue`.
- **Removed or replaced**:
  - `transform` / `transformOrFail` / `optionalWith` / `optionalToRequired` became `decodeTo` + `SchemaGetter`.
  - `pick` / `omit` / `partial` / `extend` became `mapFields(Struct.*)`.
  - `keyof`, `Data(schema)`, `withDefaults`, `NonEmptyArrayEnsure` were removed.
  - `UUID` / `ULID` became `String.check(isUUID())` / `String.check(isULID())`.
- **Errors**: `ParseError` / `ParseResult` are gone; use `SchemaError` with a `SchemaIssue` tree.
- **Arbitrary**: the fast-check bridge was replaced by `Arbitrary.schema` from `effect/Arbitrary` (`migration/schema.md`).
