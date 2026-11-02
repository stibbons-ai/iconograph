import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  DEFAULT_TARGET_LOOK,
  HAIRSTYLE_AS_IN_REFERENCE_PHOTOS,
  initialPrompt,
  TargetLook,
  TargetLookInput,
} from "../src";

const decodeInput = Schema.decodeUnknownSync(TargetLookInput);

describe("Target Look", () => {
  test("an empty look takes every default; hairstyle keeps the Subject's own", () => {
    const look = decodeInput({});
    expect(look).toEqual(DEFAULT_TARGET_LOOK);
    expect(look.hairstyle).toBe(HAIRSTYLE_AS_IN_REFERENCE_PHOTOS);
    // The decoded input is a complete, valid Target Look.
    expect(Schema.decodeUnknownSync(TargetLook)(look)).toEqual(look);
  });

  test("a written facet replaces only its default", () => {
    const look = decodeInput({ background: "dark navy backdrop" });
    expect(look).toEqual({ ...DEFAULT_TARGET_LOOK, background: "dark navy backdrop" });
  });

  test("empty, padded or overlong facets are rejected", () => {
    for (const background of ["", "  ", " navy", "x".repeat(501), 42]) {
      expect(() => decodeInput({ background })).toThrow();
    }
    expect(decodeInput({ background: "x".repeat(500) }).background).toHaveLength(500);
  });

  test("a frozen Target Look needs every facet", () => {
    const { framing: _, ...partial } = DEFAULT_TARGET_LOOK;
    expect(() => Schema.decodeUnknownSync(TargetLook)(partial)).toThrow();
  });
});

describe("initial Prompt", () => {
  test("states every facet of the look", () => {
    const look = decodeInput({
      pose: "arms crossed, smiling",
      background: "sunlit office with plants",
      lighting: "warm golden-hour light",
      hairstyle: "short and slicked back",
      clothing: "navy turtleneck",
      framing: "waist-up, off-centre to the left",
    });
    const prompt = initialPrompt(look);
    for (const facet of Object.values(look)) expect(prompt).toContain(facet);
  });

  test("the default hairstyle asks for the Reference Photos' hair, not the placeholder text", () => {
    const prompt = initialPrompt(decodeInput({}));
    expect(prompt).not.toContain(HAIRSTYLE_AS_IN_REFERENCE_PHOTOS);
    expect(prompt).toMatch(/same hairstyle.*reference photos/i);
    for (const [facet, text] of Object.entries(DEFAULT_TARGET_LOOK)) {
      if (facet !== "hairstyle") expect(prompt).toContain(text);
    }
  });

  test("is a pure function of the look", () => {
    const look = decodeInput({ clothing: "grey suit" });
    expect(initialPrompt(look)).toBe(initialPrompt({ ...look }));
    expect(initialPrompt(look)).not.toBe(initialPrompt({ ...look, clothing: "black suit" }));
  });
});
