import { expect, test } from "bun:test";
import { FaceModelError } from "@iconograph/domain";
import { Effect, Logger } from "effect";
import { errorLine, errorMessage, withCleanup } from "../src/errors";
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
