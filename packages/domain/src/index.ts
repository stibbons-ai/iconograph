import { Schema } from "effect";

/** The local tracer accepts a message, without calling an image or language model. */
export const RunInput = Schema.Struct({
  message: Schema.String,
});

/** `length` counts JavaScript UTF-16 code units, including whitespace. */
export const RunOutput = Schema.Struct({
  message: Schema.String,
  length: Schema.Finite,
});

export type RunInput = typeof RunInput.Type;
export type RunOutput = typeof RunOutput.Type;

export * from "./face";
export * from "./identity";
export * from "./prices";
