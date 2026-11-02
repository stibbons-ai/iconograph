import { expect, test } from "bun:test";
import { isStorableImageType } from "../src/image-store";

test("only JPEG and PNG are storable; vendor text naming an Object property is not", () => {
  expect(isStorableImageType("image/jpeg")).toBe(true);
  expect(isStorableImageType("image/png")).toBe(true);
  for (const type of ["image/heic", "image/webp", "constructor", "toString", "__proto__"]) {
    expect(isStorableImageType(type)).toBe(false);
  }
});
