import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { toMastraSchema } from "../src";

describe("Effect to Mastra schema bridge", () => {
  test("exposes both standards and wraps each schema only once", async () => {
    const schema = Schema.Struct({ message: Schema.String });
    const standard = toMastraSchema(schema);
    const properties = standard["~standard"];
    expect(toMastraSchema(schema)).toBe(standard);
    expect(standard["~standard"]).toBe(properties);
    // Effect 4.1.1 clones adapters rather than mutating the domain schema.
    expect(Object.hasOwn(schema, "~standard")).toBe(false);
    expect(properties.vendor).toBe("effect");
    expect(await properties.validate({ message: "hello" })).toEqual({
      value: { message: "hello" },
    });
    expect(properties.jsonSchema.input({ target: "draft-2020-12" })).toMatchObject({
      type: "object",
      properties: { message: { type: "string" } },
    });
  });

  test("keeps Effect's issue path and validation message", async () => {
    const schema = Schema.Struct({ message: Schema.String });
    const validation = await toMastraSchema(schema)["~standard"].validate({ message: 42 });
    expect(validation.issues).toHaveLength(1);
    expect(validation.issues?.[0]?.path).toEqual(["message"]);
  });
});
