import { expect, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createHeicDecoderLoader, decodeHeic, loadHeicDecoder } from "../src/heic";
import { MAX_PHOTO_PIXELS } from "../src/reference-photos";
import { fixture } from "./face-models";

test("a failed decoder load is retried, a successful one is shared", async () => {
  let calls = 0;
  const load = createHeicDecoderLoader(async () => {
    calls += 1;
    if (calls === 1) throw new Error("transient read error");
    return { loaded: calls };
  });
  await expect(load()).rejects.toThrow("transient read error");
  const [first, second] = await Promise.all([load(), load()]);
  expect(second).toBe(first);
  expect(await load()).toBe(first);
  expect(calls).toBe(2);
});

test("the real decoder is loaded again after the module aborts", async () => {
  // Emscripten calls the `onAbort` it was given; the loader must have passed one.
  const first = await loadHeicDecoder();
  const { onAbort } = first as unknown as { onAbort?: () => void };
  expect(onAbort).toBeFunction();
  expect(await loadHeicDecoder()).toBe(first);
  onAbort!();
  const second = await loadHeicDecoder();
  expect(second).not.toBe(first);
  expect(await loadHeicDecoder()).toBe(second);
});

/** Run `body` with the console spied on, and assert it wrote nothing to stdout or stderr. */
function expectConsoleUntouched(body: () => void): void {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    body();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

test("the decoder's Emscripten output never reaches the console", async () => {
  const { print, printErr } = (await loadHeicDecoder()) as unknown as {
    print?: (text: string) => void;
    printErr?: (text: string) => void;
  };
  // Emscripten keeps the hooks it was given; without them it writes to console.log/error.
  expect(print).toBeFunction();
  expect(printErr).toBeFunction();
  expectConsoleUntouched(() => {
    print!("probe stdout");
    printErr!("probe stderr");
  });
});

test("a decode failure carries the decoder's own diagnostic, printed nowhere", async () => {
  // One bit flipped in the hvcC box (round 4, R4-2): libheif's error is generic,
  // and libde265 says what is wrong only on its stderr.
  const original = await readFile(fixture("biden-2021.heic"));
  const bytes = new Uint8Array(original);
  bytes[1013]! ^= 0x02;
  const lib = await loadHeicDecoder();
  expectConsoleUntouched(() =>
    expect(() => decodeHeic(lib, bytes, MAX_PHOTO_PIXELS)).toThrow(
      "Decoding the input data did not give a decompressed image. (decoder: SPS error: CB alignment)",
    ),
  );
  // The next decode starts with an empty buffer: a clean photo decodes without leftovers.
  const [, options] = decodeHeic(lib, new Uint8Array(original), MAX_PHOTO_PIXELS);
  expect(options).toMatchObject({ raw: { width: 500, height: 625, channels: 4 } });
});
