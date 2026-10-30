import { Schema } from "effect";
import type { StandardJSONSchemaV1, StandardSchemaV1 } from "effect/StandardSchema";

type MastraSchema<S extends Schema.ConstraintDecoder<unknown>> = S &
  StandardSchemaV1<S["Encoded"], S["Type"]> &
  StandardJSONSchemaV1<S["Encoded"], S["Type"]>;

const converted = new WeakMap<object, object>();

/** Cache the combined Standard Schema and JSON Schema adapter per Effect schema. */
export function toMastraSchema<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
): MastraSchema<S> {
  const cached = converted.get(schema);
  if (cached) return cached as MastraSchema<S>;

  const standard = Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema));
  converted.set(schema, standard);
  return standard;
}
