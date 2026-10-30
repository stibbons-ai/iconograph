import { expect, test } from "bun:test";
import { Schema } from "effect";
import { RunInput, RunOutput } from "../src";

test("Run schemas accept only the tracer contract and finite output", () => {
  expect(Schema.decodeUnknownSync(RunInput)({ message: "hello" })).toEqual({ message: "hello" });
  expect(() => Schema.decodeUnknownSync(RunInput)({ message: 42 })).toThrow();
  expect(Schema.decodeUnknownSync(RunOutput)({ message: "hello", length: 5 })).toEqual({
    message: "hello",
    length: 5,
  });
  for (const length of [NaN, Infinity, -Infinity, "5"]) {
    expect(() => Schema.decodeUnknownSync(RunOutput)({ message: "hello", length })).toThrow();
  }
});
