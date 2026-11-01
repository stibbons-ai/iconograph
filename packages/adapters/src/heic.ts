import { createRequire } from "node:module";
import type { SharpInput, SharpOptions } from "sharp";
import { errorMessage } from "./errors";

interface HeifError {
  code: unknown;
  message: string;
}
interface HeifChannel {
  id: unknown;
  width: number;
  height: number;
  stride: number;
  data: Uint8Array;
}
/**
 * The loaded libheif module (obtain it with `loadHeicDecoder`): the part of
 * libheif-js's Emscripten module this decoder uses. Its bundled
 * typings omit the `heif_js_*` helpers, so this is declared here. Enum values
 * are Embind objects compared by identity, hence `unknown`.
 */
export interface HeicDecoder {
  heif_error_Ok: unknown;
  heif_colorspace_RGB: unknown;
  heif_chroma_interleaved_RGBA: unknown;
  heif_channel_interleaved: unknown;
  heif_context_alloc(): number;
  heif_context_free(context: number): void;
  heif_context_read_from_memory(context: number, bytes: Uint8Array): HeifError;
  heif_js_context_get_list_of_top_level_image_IDs(context: number): number[] | HeifError;
  heif_js_context_get_image_handle(context: number, id: number): number | HeifError;
  heif_image_handle_is_primary_image(handle: number): number;
  heif_image_handle_get_width(handle: number): number;
  heif_image_handle_get_height(handle: number): number;
  heif_image_handle_release(handle: number): void;
  heif_js_decode_image2(
    handle: number,
    colorspace: unknown,
    chroma: unknown,
  ): { image: number; channels: HeifChannel[] } | HeifError;
  heif_image_release(image: number): void;
}

const isError = (value: unknown): value is HeifError =>
  typeof value === "object" && value !== null && "code" in value;

/**
 * Share one in-flight or loaded module, but load again after a failed load or
 * after the module aborts (an Emscripten `abort()` leaves it unusable), so one
 * failure doesn't break every later HEIC in a long-lived process.
 */
export function createHeicDecoderLoader<T>(
  instantiate: (onAbort: () => void) => Promise<T>,
): () => Promise<T> {
  let cached: Promise<T> | undefined;
  const forget = () => {
    cached = undefined;
  };
  return () =>
    (cached ??= instantiate(forget).catch((error: unknown) => {
      forget();
      throw error;
    }));
}

/**
 * Lines the decoder printed to its stderr during the current `decodeHeic`
 * call. libde265 reports some failures (e.g. "SPS error: CB alignment") only
 * there, while libheif's own error stays generic. Decoding is synchronous, so
 * one shared buffer can't mix two decodes.
 */
const decoderDiagnostics: string[] = [];

/**
 * libheif + libde265 compiled to WebAssembly (LGPL-3.0), loaded unmodified from
 * the `libheif-js` package at runtime. The package's own `wasm.js` reads the
 * binary relative to the working directory, so the binary is passed in here.
 * Emscripten would print to `console.log` (stdout, where the command's report
 * goes) and `console.error`: stdout output is dropped, and stderr output is
 * collected and added to the error of the decode that produced it.
 */
export const loadHeicDecoder = createHeicDecoderLoader(async (onAbort) => {
  const require = createRequire(import.meta.url);
  const wasmBinary = await Bun.file(
    require.resolve("libheif-js/libheif-wasm/libheif.wasm"),
  ).bytes();
  const factory: (options: {
    wasmBinary: Uint8Array;
    onAbort: () => void;
    print: (text: string) => void;
    printErr: (text: string) => void;
  }) => HeicDecoder = require("libheif-js/libheif-wasm/libheif.js");
  return factory({
    wasmBinary,
    onAbort,
    print: () => {},
    printErr: (text) => decoderDiagnostics.push(text),
  });
});

/**
 * Decode HEIC's primary image in software to raw RGBA for sharp, since prebuilt
 * libvips has no HEVC decoder. libheif applies the container's rotation and
 * mirroring while decoding. An image over `maxPixels` is rejected from its
 * header, before any pixels are decoded. Every libheif failure throws with its
 * message, plus whatever the decoder printed while failing.
 *
 * Corruption detection is best-effort: a damaged container or truncated data is
 * rejected, but libde265 conceals errors inside the HEVC bitstream and returns a
 * damaged image without any error or warning, even with libheif's
 * `strict_decoding` (which in 1.23.5 only affects colour-profile metadata).
 */
const maxDiagnosticLines = 10;

export function decodeHeic(
  lib: HeicDecoder,
  bytes: Uint8Array,
  maxPixels: number,
): [SharpInput, SharpOptions] {
  decoderDiagnostics.length = 0;
  try {
    return decodePrimaryImage(lib, bytes, maxPixels);
  } catch (error) {
    if (decoderDiagnostics.length === 0) throw error;
    // Corrupt input can make the decoder print a line per bad block; keep the message bounded.
    const shown = decoderDiagnostics.slice(0, maxDiagnosticLines).join("; ");
    const more = decoderDiagnostics.length - maxDiagnosticLines;
    throw new Error(
      `${errorMessage(error)} (decoder: ${shown}${more > 0 ? `; +${more} more` : ""})`,
      { cause: error },
    );
  } finally {
    decoderDiagnostics.length = 0;
  }
}

function decodePrimaryImage(
  lib: HeicDecoder,
  bytes: Uint8Array,
  maxPixels: number,
): [SharpInput, SharpOptions] {
  const context = lib.heif_context_alloc();
  if (!context) throw new Error("libheif could not allocate a context");
  try {
    const read = lib.heif_context_read_from_memory(context, bytes);
    if (read.code !== lib.heif_error_Ok) throw new Error(read.message.trim());
    const ids = lib.heif_js_context_get_list_of_top_level_image_IDs(context);
    if (isError(ids)) throw new Error(ids.message.trim());
    const handles: number[] = [];
    try {
      for (const id of ids) {
        const handle = lib.heif_js_context_get_image_handle(context, id);
        if (isError(handle)) throw new Error(handle.message.trim());
        handles.push(handle);
      }
      const primary =
        handles.find((handle) => lib.heif_image_handle_is_primary_image(handle)) ?? handles[0];
      if (primary === undefined) throw new Error("no image in the HEIC container");
      const declaredWidth = lib.heif_image_handle_get_width(primary);
      const declaredHeight = lib.heif_image_handle_get_height(primary);
      if (declaredWidth * declaredHeight > maxPixels) {
        throw new Error(
          `${declaredWidth}×${declaredHeight} pixels exceeds the ${maxPixels}-pixel limit`,
        );
      }
      const decoded = lib.heif_js_decode_image2(
        primary,
        lib.heif_colorspace_RGB,
        lib.heif_chroma_interleaved_RGBA,
      );
      if (isError(decoded)) throw new Error(decoded.message.trim());
      try {
        const channel = decoded.channels.find(({ id }) => id === lib.heif_channel_interleaved);
        if (!channel) throw new Error("libheif returned no interleaved RGBA plane");
        const { width, height, stride, data } = channel;
        const rowBytes = width * 4;
        const pixels = new Uint8Array(rowBytes * height);
        for (let row = 0; row < height; row++) {
          pixels.set(data.subarray(row * stride, row * stride + rowBytes), row * rowBytes);
        }
        return [pixels, { raw: { width, height, channels: 4 }, limitInputPixels: maxPixels }];
      } finally {
        lib.heif_image_release(decoded.image);
      }
    } finally {
      for (const handle of handles) lib.heif_image_handle_release(handle);
    }
  } finally {
    lib.heif_context_free(context);
  }
}
