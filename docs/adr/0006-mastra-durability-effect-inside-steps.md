---
title: "Mastra owns durability; Effect runs inside steps; Effect Schema is the single schema source"
status: accepted
date: 2026-10-30
---

# Mastra owns durability; Effect runs inside steps; Effect Schema is the single schema source

Mastra workflows own durability (snapshots, suspend/resume, streaming). Everything inside a step (Image Model adapters, face backend, Judge/Optimizer calls, retries, rate limits, Budget checks, config and secrets) is an Effect program run through a shared `ManagedRuntime`; we do not use `effect/workflow`, so there is exactly one durable engine. All schemas are Effect Schemas; we don't use Zod. Mastra's `PublicSchema` accepts `StandardSchemaV1 & StandardJSONSchemaV1`, which we produce with `Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema))`, constrained to schemas whose `DecodingServices` is `never`.

## Consequences

- Both wrappers are required: an Effect schema passed directly, or wrapped by only one of them, is rejected (`Unsupported schema type: function`). Both wrappers mutate and return the original schema object, so wrap exactly once in a single helper.
- Mastra validates step input, state, suspend and resume data, but not step output: steps decode their own output before returning.
- Use `Schema.Finite`, not `Schema.Number`, in schemas sent to an LLM; `Schema.Number` emits `"Infinity"`/`"NaN"` alternatives into the JSON Schema.
