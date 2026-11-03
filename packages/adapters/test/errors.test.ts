import { expect, test } from "bun:test";
import { FaceModelError } from "@iconograph/domain";
import { Effect, Logger } from "effect";
import {
  attachCleanupError,
  errorChain,
  errorLine,
  errorMessage,
  withCleanup,
} from "../src/errors";
import { releaseSession } from "../src/face-embedder";
import { HeicDecoderError, ReferencePhotoError } from "../src/reference-photos";

test("a command's error line names the photo for photo and face-model errors only", () => {
  expect(
    JSON.parse(
      errorLine(new FaceModelError({ message: "Reference Photo a.jpg: boom", photo: "a.jpg" })),
    ),
  ).toEqual({ error: "Reference Photo a.jpg: boom", photo: "a.jpg" });
  expect(
    JSON.parse(errorLine(new ReferencePhotoError({ message: "bad", photo: "b.png" }))),
  ).toEqual({ error: "bad", photo: "b.png" });
  expect(JSON.parse(errorLine(new HeicDecoderError({ message: "no wasm" })))).toEqual({
    error: "no wasm",
  });
  expect(JSON.parse(errorLine("plain"))).toEqual({ error: "plain" });
  expect(errorLine(new Error("x"))).toEndWith("\n");
});

test("a failed model release is logged as a warning with its real reason, not raised", async () => {
  const messages: unknown[] = [];
  const capture = Logger.layer([Logger.make(({ message }) => messages.push(message))]);
  await Effect.runPromise(
    releaseSession("/models/sface.onnx", () => Promise.reject(new Error("session busy"))).pipe(
      Effect.provide(capture),
    ),
  );
  expect(JSON.stringify(messages)).toContain(
    "Releasing the face model /models/sface.onnx failed: session busy",
  );
});

test("withCleanup rethrows the original error with the cleanup failure attached", async () => {
  const original = new Error("write failed");
  const failure = await withCleanup(
    async () => {
      throw original;
    },
    async () => {
      throw new Error("close failed");
    },
  ).catch((error: unknown) => error);
  expect(failure).toBe(original);
  expect(errorMessage(failure)).toContain("close failed");
  // A successful operation whose cleanup fails reports the cleanup failure.
  await expect(
    withCleanup(
      async () => "ok",
      async () => {
        throw new Error("close failed");
      },
    ),
  ).rejects.toThrow("close failed");
});

test("an error chain keeps every cause and cleanup failure, quoting none twice", () => {
  const download = new Error("download failed", { cause: new Error("socket closed") });
  attachCleanupError(download, new Error("rm .partial: EACCES"));
  const outer = new Error("Model sface failed: download failed", { cause: download });
  expect(errorChain(outer)).toBe(
    "Model sface failed: download failed: download failed (cleanup also failed: rm .partial: EACCES): socket closed",
  );
  // Non-Error causes with a message (as some Effect errors are) count by their message, and
  // keep their cleanup failures too.
  expect(errorChain(new Error("outer", { cause: { message: "inner" } }))).toBe("outer: inner");
  const effectLike = { message: "inner", cleanupErrors: [new Error("close failed")] };
  expect(errorChain(new Error("outer", { cause: effectLike }))).toBe(
    "outer: inner (cleanup also failed: close failed)",
  );
  expect(errorChain(new Error("same", { cause: new Error("same") }))).toBe("same");
  // A null cause ends the chain instead of adding ": null".
  expect(errorChain(new Error("outer", { cause: null }))).toBe("outer");
});
