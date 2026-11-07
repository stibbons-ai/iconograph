import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { heapSize } from "bun:jsc";
import { mkdir, open, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureModels,
  type Fetch,
  modelsDirectory,
  readModelLock,
  resolveDataDirectory,
} from "../src";
import {
  decodeModelLock,
  type DownloadedWeight,
  type ModelLock,
  modelDownloadIdleTimeoutMs,
} from "../src/models";
import { main, run } from "../src/models-cli";
import { sha256 } from "./sha256";
import { temporaryDirectories } from "./temporary-directory";
import { until } from "./until";

// Larger than one stream chunk so streaming to disk is exercised.
const detector = crypto.getRandomValues(new Uint8Array(200_000));
const recognizer = crypto.getRandomValues(new Uint8Array(1_000));
// Several times the memory a streaming download may hold at once.
const large = new Uint8Array(32 * 2 ** 20).fill(7);
const hits = new Map<string, number>();
// Holds /gated.onnx after its first chunk, and /silent.onnx before its headers, until a
// test releases it.
let gate = Promise.withResolvers<void>();

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const path = new URL(request.url).pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    if (path === "/detector.onnx") return new Response(detector);
    if (path === "/recognizer.onnx") return new Response(recognizer);
    if (path === "/large.onnx") return new Response(large);
    if (path === "/short.onnx") return new Response(detector.subarray(0, 1_000));
    if (path === "/gated.onnx") {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(detector.subarray(0, 1_000));
          },
          async pull(controller) {
            await gate.promise;
            controller.enqueue(detector.subarray(1_000));
            controller.close();
          },
        }),
      );
    }
    if (path === "/silent.onnx") {
      await gate.promise;
      return new Response(detector);
    }
    if (path === "/trickle.onnx") {
      // 10 chunks of 100 bytes, 40 ms apart: slow overall, never idle for long.
      let offset = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (offset > 0) await Bun.sleep(40);
            controller.enqueue(recognizer.subarray(offset, offset + 100));
            offset += 100;
            if (offset >= recognizer.byteLength) controller.close();
          },
        }),
      );
    }
    return new Response("missing", { status: 404 });
  },
});

afterAll(() => server.stop(true));

function weight(
  id: string,
  path: string,
  bytes: Uint8Array,
  overrides: Partial<DownloadedWeight> = {},
): DownloadedWeight {
  return {
    id,
    file: `${id}.onnx`,
    url: new URL(path, server.url).href,
    sha256: sha256(bytes),
    size: bytes.byteLength,
    license: "MIT",
    ...overrides,
  };
}

// The lock schema admits only HTTPS URLs, so locks for the plain-HTTP local
// server are built directly; ensureModels trusts an already-decoded lock.
const lock: ModelLock = {
  models: [
    weight("detector", "/detector.onnx", detector),
    weight("recognizer", "/recognizer.onnx", recognizer),
  ],
};

/** A built entry: never downloaded, so its bytes are written by the test. */
const built = {
  id: "embedder",
  file: "embedder.onnx",
  sha256: sha256(recognizer),
  size: recognizer.byteLength,
  license: "MIT",
  build: {
    command: "bun run models:export-embedder",
    script: "scripts/export-embedder.py",
    source: { url: "https://example.test/embedder.pt", sha256: "a".repeat(64), size: 1 },
  },
} as const;
const withBuilt: ModelLock = { models: [...lock.models, built] };

let directory: string;
beforeEach(async () => {
  hits.clear();
  gate = Promise.withResolvers<void>();
  directory = await temporaryDirectory();
});
afterEach(() => gate.resolve());
// Registered after the gate release so a held download is released before cleanup.
const temporaryDirectory = temporaryDirectories("models");

describe("ensureModels", () => {
  test("downloads missing weights once, then skips verified files", async () => {
    const models = join(directory, "models");
    const first = await ensureModels({ lock, directory: models });
    expect(first).toEqual([
      {
        id: "detector",
        path: join(models, "detector.onnx"),
        sha256: sha256(detector),
        downloaded: true,
      },
      {
        id: "recognizer",
        path: join(models, "recognizer.onnx"),
        sha256: sha256(recognizer),
        downloaded: true,
      },
    ]);
    expect(new Uint8Array(await readFile(join(models, "detector.onnx")))).toEqual(detector);
    expect(new Uint8Array(await readFile(join(models, "recognizer.onnx")))).toEqual(recognizer);
    expect(Object.fromEntries(hits)).toEqual({ "/detector.onnx": 1, "/recognizer.onnx": 1 });

    hits.clear();
    const second = await ensureModels({ lock, directory: models });
    expect(second.map((model) => model.downloaded)).toEqual([false, false]);
    expect(hits.size).toBe(0);
    expect((await readdir(models)).sort()).toEqual(["detector.onnx", "recognizer.onnx"]);
  });

  test("ensures only the requested models and rejects unknown ids", async () => {
    const [only] = await ensureModels({ lock, directory, ids: ["recognizer"] });
    expect(only?.id).toBe("recognizer");
    expect(Object.fromEntries(hits)).toEqual({ "/recognizer.onnx": 1 });
    await expect(ensureModels({ lock, directory, ids: ["buffalo_l"] })).rejects.toThrow(
      "Unknown model buffalo_l",
    );
  });

  test("never downloads a built model: missing fails with its build command", async () => {
    await expect(ensureModels({ lock: withBuilt, directory })).rejects.toThrow(
      `Model embedder is missing at ${join(directory, "embedder.onnx")}; it is never downloaded. Build it with \`bun run models:export-embedder\``,
    );
    // Downloadable models before it were fetched; nothing was requested for the built one.
    expect(Object.fromEntries(hits)).toEqual({ "/detector.onnx": 1, "/recognizer.onnx": 1 });
    expect((await readdir(directory)).sort()).toEqual(["detector.onnx", "recognizer.onnx"]);
  });

  test("verifies a built model like any other, and a tampered one names the rebuild", async () => {
    const path = join(directory, "embedder.onnx");
    await Bun.write(path, recognizer);
    expect(await ensureModels({ lock: withBuilt, directory, ids: ["embedder"] })).toEqual([
      { id: "embedder", path, sha256: sha256(recognizer), downloaded: false },
    ]);
    await Bun.write(path, detector);
    await expect(ensureModels({ lock: withBuilt, directory, ids: ["embedder"] })).rejects.toThrow(
      `Model embedder at ${path} failed SHA-256 verification: expected ${sha256(recognizer)}, actual ${sha256(detector)}. Rebuild it with \`bun run models:export-embedder\`.`,
    );
    expect(hits.size).toBe(0);
  });

  test("a download that fails verification leaves no file and no temp file", async () => {
    const tampered: ModelLock = {
      models: [weight("detector", "/detector.onnx", detector, { sha256: "0".repeat(64) })],
    };
    const failure = ensureModels({ lock: tampered, directory });
    await expect(failure).rejects.toThrow(
      `Model detector download to ${join(directory, "detector.onnx")} failed SHA-256 verification: expected ${"0".repeat(64)}, actual ${sha256(detector)}`,
    );
    expect(await readdir(directory)).toEqual([]);
  });

  test("a download larger than the locked size is aborted and cleaned up", async () => {
    const truncated: ModelLock = {
      models: [weight("detector", "/detector.onnx", detector, { size: 1_000 })],
    };
    await expect(ensureModels({ lock: truncated, directory })).rejects.toThrow(
      "exceeded the locked size of 1000 bytes",
    );
    expect(await readdir(directory)).toEqual([]);
  });

  test("a corrupt present file is an error, kept for the operator and never re-downloaded", async () => {
    const path = join(directory, "detector.onnx");
    await writeFile(path, "corrupt");
    await expect(ensureModels({ lock, directory, ids: ["detector"] })).rejects.toThrow(
      `Model detector at ${path} failed SHA-256 verification: expected ${sha256(detector)}, actual ${sha256("corrupt")}. Delete the file to re-download it.`,
    );
    expect(await readFile(path, "utf8")).toBe("corrupt");
    expect(hits.size).toBe(0);
  });

  test("an HTTP error status is an error and leaves nothing behind", async () => {
    const gone: ModelLock = { models: [weight("detector", "/gone.onnx", detector)] };
    await expect(ensureModels({ lock: gone, directory })).rejects.toThrow(
      `Model detector download failed: HTTP 404 from ${new URL("/gone.onnx", server.url).href}`,
    );
    expect(await readdir(directory)).toEqual([]);
  });

  test("an HTTP error status survives a body that fails to cancel", async () => {
    const unavailable = async () =>
      new Response(
        new ReadableStream({
          cancel() {
            throw new Error("cancel failed");
          },
        }),
        { status: 503 },
      );
    await expect(
      ensureModels({ lock, directory, ids: ["detector"], fetch: unavailable }),
    ).rejects.toThrow(`Model detector download failed: HTTP 503 from ${lock.models[0].url}`);
    expect(await readdir(directory)).toEqual([]);
  });

  test("the gate hashes stored bytes, so a short write is never accepted", async () => {
    const probePath = join(directory, "probe");
    const probe = await open(probePath, "w");
    const fileHandle = Object.getPrototypeOf(probe);
    await probe.close();
    await rm(probePath);
    const write = fileHandle.write;
    // Simulate a short write (as near ENOSPC): every chunk loses its last byte on disk.
    fileHandle.write = function (this: unknown, chunk: Uint8Array) {
      return write.call(this, chunk.subarray(0, chunk.byteLength - 1));
    };
    try {
      await expect(ensureModels({ lock, directory, ids: ["detector"] })).rejects.toThrow(
        "failed SHA-256 verification",
      );
    } finally {
      fileHandle.write = write;
    }
    expect(await readdir(directory)).toEqual([]);
  });

  test("a short body is a size error and leaves nothing behind", async () => {
    const short: ModelLock = { models: [weight("detector", "/short.onnx", detector)] };
    await expect(ensureModels({ lock: short, directory })).rejects.toThrow(
      `Model detector download from ${new URL("/short.onnx", server.url).href} ended after 1000 of 200000 bytes`,
    );
    expect(await readdir(directory)).toEqual([]);
  });

  test("a stream that errors mid-body names the model and leaves nothing behind", async () => {
    // Injected because Bun's fetch can report a server hang-up as a clean, short body.
    const reset = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(detector.subarray(0, 1_000));
            controller.error(new Error("connection reset"));
          },
        }),
      );
    await expect(
      ensureModels({ lock, directory, ids: ["detector"], fetch: reset }),
    ).rejects.toThrow(
      `Model detector download from ${lock.models[0].url} to ${join(directory, "detector.onnx")} failed: connection reset`,
    );
    expect(await readdir(directory)).toEqual([]);
  });

  test("an unreadable present path names the model", async () => {
    await mkdir(join(directory, "detector.onnx"));
    await expect(ensureModels({ lock, directory, ids: ["detector"] })).rejects.toThrow(
      `Model detector at ${join(directory, "detector.onnx")} could not be read: `,
    );
    expect(hits.size).toBe(0);
  });

  test("an undecoded lock cannot write outside the models folder", async () => {
    const models = join(directory, "models");
    const escaping: ModelLock = {
      models: [weight("detector", "/detector.onnx", detector, { file: "../escaped.onnx" })],
    };
    await expect(ensureModels({ lock: escaping, directory: models })).rejects.toThrow(
      `Model detector file ../escaped.onnx is not a bare file name inside ${models}`,
    );
    expect(await readdir(directory)).toEqual(["models"]);
    expect(hits.size).toBe(0);
  });

  test("concurrent callers never see the final path before the download verifies", async () => {
    const gated: ModelLock = { models: [weight("detector", "/gated.onnx", detector)] };
    const entries = () => readdir(directory);
    const callers: Promise<unknown>[] = [];
    try {
      const first = ensureModels({ lock: gated, directory });
      callers.push(first);
      // Polled: ensureModels exposes no mid-download signal, and the server can't tell when
      // the client has opened its temp file.
      await until(async () => (await entries()).length === 1);
      expect((await entries())[0]).toEndWith(".partial");
      const second = ensureModels({ lock: gated, directory });
      callers.push(second);
      await until(async () => (await entries()).length === 2);
      expect((await entries()).every((name) => name.endsWith(".partial"))).toBe(true);

      gate.resolve();
      for (const [model] of await Promise.all([first, second])) {
        expect(model?.downloaded).toBe(true);
        expect(new Uint8Array(await readFile(model!.path))).toEqual(detector);
      }
      expect(await entries()).toEqual(["detector.onnx"]);
    } finally {
      // A failed assertion must not leave callers floating into later tests.
      gate.resolve();
      await Promise.allSettled(callers);
    }
  });

  describe("idle timeout", () => {
    const idleTimeoutMs = 150;
    const stalled = (path: string) =>
      `Model detector download from ${new URL(path, server.url).href} stalled: no data for 0.15 s`;

    test("a server that never sends headers fails within the idle period, leaving nothing", async () => {
      const silent: ModelLock = { models: [weight("detector", "/silent.onnx", detector)] };
      const started = performance.now();
      await expect(ensureModels({ lock: silent, directory, idleTimeoutMs })).rejects.toThrow(
        stalled("/silent.onnx"),
      );
      const elapsed = performance.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(idleTimeoutMs - 5);
      expect(elapsed).toBeLessThan(idleTimeoutMs + 1_500);
      expect(await readdir(directory)).toEqual([]);
    });

    test("a body that stalls after some bytes fails the same way, leaving nothing", async () => {
      const gated: ModelLock = { models: [weight("detector", "/gated.onnx", detector)] };
      await expect(ensureModels({ lock: gated, directory, idleTimeoutMs })).rejects.toThrow(
        stalled("/gated.onnx"),
      );
      expect(hits.get("/gated.onnx")).toBe(1);
      expect(await readdir(directory)).toEqual([]);
    });

    // Real time: the server's chunks cross a real socket, which fake timers can't drive.
    test("a slow download that keeps receiving data is never aborted", async () => {
      const trickle: ModelLock = { models: [weight("recognizer", "/trickle.onnx", recognizer)] };
      const started = performance.now();
      const [model] = await ensureModels({ lock: trickle, directory, idleTimeoutMs });
      expect(performance.now() - started).toBeGreaterThan(idleTimeoutMs);
      expect(model?.downloaded).toBe(true);
      expect(new Uint8Array(await readFile(model!.path))).toEqual(recognizer);
      expect(await readdir(directory)).toEqual(["recognizer.onnx"]);
    });

    // Bun.serve sends headers only with the first body chunk, so a raw socket separates them.
    test("headers arriving count as data: the wait for the first chunk starts afresh", async () => {
      const slow = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: {
          async data(socket) {
            await Bun.sleep(idleTimeoutMs * 0.6);
            socket.write(
              `HTTP/1.1 200 OK\r\nContent-Length: ${recognizer.byteLength}\r\nConnection: close\r\n\r\n`,
            );
            await Bun.sleep(idleTimeoutMs * 0.6);
            socket.write(recognizer);
            socket.end();
          },
        },
      });
      try {
        const url = `http://127.0.0.1:${slow.port}/recognizer.onnx`;
        const [model] = await ensureModels({
          lock: { models: [weight("recognizer", "/", recognizer, { url })] },
          directory,
          idleTimeoutMs,
        });
        expect(new Uint8Array(await readFile(model!.path))).toEqual(recognizer);
      } finally {
        slow.stop(true);
      }
    });

    test("holds only a few chunks in memory, not the whole body", async () => {
      const big: ModelLock = { models: [weight("large", "/large.onnx", large)] };
      Bun.gc(true);
      const base = heapSize();
      let peak = 0;
      const sampler = setInterval(() => {
        Bun.gc(true);
        peak = Math.max(peak, heapSize() - base);
      }, 10);
      try {
        await ensureModels({ lock: big, directory, idleTimeoutMs: 5_000 });
      } finally {
        clearInterval(sampler);
      }
      expect(peak).toBeLessThan(large.byteLength / 4);
    }, 30_000);

    test("an idle period that setTimeout can't honour is rejected before any request", async () => {
      for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
        await expect(ensureModels({ lock, directory, idleTimeoutMs: invalid })).rejects.toThrow(
          `idleTimeoutMs must be a positive number of milliseconds up to 2147483647; got ${invalid}`,
        );
      }
      expect(hits.size).toBe(0);
      expect(await readdir(directory)).toEqual([]);
    });

    test("defaults to 30 s, aborts even a fetch that ignores the signal, and frees its late response", async () => {
      const fetched = Promise.withResolvers<AbortSignal>();
      const late = Promise.withResolvers<Response>();
      const ignoresSignal: Fetch = (_, init) => {
        fetched.resolve(init!.signal!);
        return late.promise;
      };
      jest.useFakeTimers();
      try {
        const failure = ensureModels({ lock, directory, ids: ["detector"], fetch: ignoresSignal });
        const signal = await fetched.promise;
        jest.advanceTimersByTime(modelDownloadIdleTimeoutMs - 1);
        expect(signal.aborted).toBe(false);
        jest.advanceTimersByTime(1);
        expect(signal.aborted).toBe(true);
        await expect(failure).rejects.toThrow(
          `Model detector download from ${lock.models[0].url} stalled: no data for 30 s`,
        );
      } finally {
        jest.useRealTimers();
      }
      const cancelled = Promise.withResolvers<void>();
      late.resolve(new Response(new ReadableStream({ cancel: () => cancelled.resolve() })));
      await cancelled.promise;
      expect(await readdir(directory)).toEqual([]);
    });

    test("time spent storing a chunk is no stall, and a storage error keeps its cause", async () => {
      // Stands in for a slow disk: reading the chunk's size lets twice the idle period pass,
      // and the chunk is no byte buffer, so storing it fails.
      const unstorable = {
        get byteLength() {
          jest.advanceTimersByTime(modelDownloadIdleTimeoutMs * 2);
          return 1;
        },
      };
      const fetchUnstorable: Fetch = async () =>
        new Response(new ReadableStream({ start: (controller) => controller.enqueue(unstorable) }));
      jest.useFakeTimers();
      let failure: unknown;
      try {
        await ensureModels({ lock, directory, ids: ["detector"], fetch: fetchUnstorable }).catch(
          (error: unknown) => (failure = error),
        );
      } finally {
        jest.useRealTimers();
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toStartWith(
        `Model detector download from ${lock.models[0].url} to ${join(directory, "detector.onnx")} failed: `,
      );
      expect((failure as Error).cause).toBeInstanceOf(TypeError);
      expect(await readdir(directory)).toEqual([]);
    });
  });

  describe("stale temp files", () => {
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    async function place(name: string, age: Date) {
      await writeFile(join(directory, name), "partial");
      await utimes(join(directory, name), age, age);
    }

    test("removes only this model's temp files older than 10 minutes", async () => {
      const crashed = `detector.onnx.${crypto.randomUUID()}.partial`;
      const live = `detector.onnx.${crypto.randomUUID()}.partial`;
      const keep = [
        live,
        `recognizer.onnx.${crypto.randomUUID()}.partial`, // another model's
        "detector.onnx.partial", // not writeFileAtomically's pattern
        `detector.onnx.${crypto.randomUUID()}.partial.bak`,
        `xdetector.onnx.${crypto.randomUUID()}.partial`,
        "notes.txt",
      ];
      await place(crashed, minutesAgo(11));
      await place(live, minutesAgo(9));
      for (const name of keep.slice(1)) await place(name, minutesAgo(60));

      await ensureModels({ lock, directory, ids: ["detector"] });
      expect((await readdir(directory)).sort()).toEqual(["detector.onnx", ...keep].sort());
    });

    test("the staleness threshold is 10x a longer idle timeout", async () => {
      const kept = `detector.onnx.${crypto.randomUUID()}.partial`;
      const crashed = `detector.onnx.${crypto.randomUUID()}.partial`;
      await place(kept, minutesAgo(19));
      await place(crashed, minutesAgo(21));
      await ensureModels({ lock, directory, ids: ["detector"], idleTimeoutMs: 120_000 });
      expect((await readdir(directory)).sort()).toEqual(["detector.onnx", kept].sort());
    });
  });
});

describe("model lock manifest", () => {
  const valid = weight("detector", "/detector.onnx", detector, {
    url: "https://example.test/detector.onnx",
  });

  test("accepts a well-formed entry", () => {
    expect(decodeModelLock({ models: [valid] })).toEqual({ models: [valid] });
  });

  test("the committed lock pins YuNet and SFace by HTTPS URL and FaceNet by its local build", () => {
    const committed = readModelLock();
    expect(committed.models.map(({ id, license }) => [id, license])).toEqual([
      ["yunet", "MIT"],
      ["sface", "Apache-2.0"],
      ["facenet", "MIT"],
    ]);
    const [yunet, sface, facenet] = committed.models;
    for (const model of [yunet!, sface!]) {
      expect(model.url).toStartWith("https://huggingface.co/opencv/");
      expect(model.url).not.toContain("/resolve/main/");
    }
    // FaceNet is never downloaded (ADR-0011): no URL, only its build and upstream source.
    expect(facenet!.url).toBeUndefined();
    expect(facenet!.build).toEqual({
      command: "bun run models:export-facenet",
      script: "scripts/export-facenet.py",
      source: {
        url: "https://github.com/timesler/facenet-pytorch/releases/download/v2.2.9/20180402-114759-vggface2.pt",
        sha256: "281cebca8662831adb987a874bdcb36e73f5b1c6dc5ee5878f305e985625d99b",
        size: 111898327,
      },
    });
  });

  test("accepts a built entry; an entry is either downloaded or built, never both", () => {
    expect(decodeModelLock({ models: [valid, built] })).toEqual({ models: [valid, built] });
    expect(() => decodeModelLock({ models: [{ ...built, url: valid.url }] })).toThrow();
    expect(() =>
      decodeModelLock({ models: [{ ...built, build: { ...built.build, command: "rm -rf /" } }] }),
    ).toThrow();
    for (const script of [
      "scripts/../outside.py",
      "scripts/..",
      "scripts/export.sh",
      "export.py",
    ]) {
      expect(() =>
        decodeModelLock({ models: [{ ...built, build: { ...built.build, script } }] }),
      ).toThrow();
    }
    expect(() =>
      decodeModelLock({
        models: [
          {
            ...built,
            build: {
              ...built.build,
              source: { ...built.build.source, url: "https://example.test/buffalo_l.zip" },
            },
          },
        ],
      }),
    ).toThrow("InsightFace weights are opt-in and never fetched automatically");
  });

  test.each([
    ["a malformed hash", { ...valid, sha256: "ABC" }],
    ["a non-HTTPS URL", { ...valid, url: "http://example.test/detector.onnx" }],
    ["a path as the file name", { ...valid, file: "../detector.onnx" }],
    ["a non-permissive licence", { ...valid, license: "CC-BY-NC-4.0" }],
    ["a non-InsightFace name with a bad pattern", { ...valid, id: "Detector" }],
  ])("rejects %s", (_, model) => {
    expect(() => decodeModelLock({ models: [model] })).toThrow();
  });

  test.each([
    "insightface",
    "buffalo",
    "antelope",
    "scrfd",
    "det_10g",
    "w600k",
    "glintr",
    "2d106det",
    "1k3d68",
    "genderage",
  ])("rejects InsightFace name %s as a file under a neutral id, even labelled MIT", (name) => {
    expect(() => decodeModelLock({ models: [{ ...valid, file: `${name}_r50.onnx` }] })).toThrow(
      "InsightFace weights are opt-in and never fetched automatically",
    );
  });

  test.each([
    ["an InsightFace pack id", { ...valid, id: "buffalo-l" }],
    [
      "an InsightFace URL",
      { ...valid, url: "https://github.com/deepinsight/insightface/releases/buffalo_l.zip" },
    ],
  ])("rejects %s even when labelled MIT", (_, model) => {
    expect(() => decodeModelLock({ models: [model] })).toThrow(
      "InsightFace weights are opt-in and never fetched automatically",
    );
  });

  test("rejects duplicate ids and an empty manifest", () => {
    expect(() => decodeModelLock({ models: [valid, { ...valid, file: "other.onnx" }] })).toThrow(
      "unique",
    );
    expect(() => decodeModelLock({ models: [] })).toThrow();
  });
});

describe("data directory", () => {
  test("resolves the flag, then ICONOGRAPH_DATA_DIR, then ./.data; empty counts as unset", () => {
    const fallback = join(process.cwd(), ".data");
    expect(resolveDataDirectory("/flag", { ICONOGRAPH_DATA_DIR: "/env" })).toBe("/flag");
    expect(resolveDataDirectory(undefined, { ICONOGRAPH_DATA_DIR: "/env" })).toBe("/env");
    expect(resolveDataDirectory("", { ICONOGRAPH_DATA_DIR: "/env" })).toBe("/env");
    expect(resolveDataDirectory(undefined, {})).toBe(fallback);
    expect(resolveDataDirectory("", { ICONOGRAPH_DATA_DIR: "" })).toBe(fallback);
    expect(modelsDirectory("/data")).toBe(join("/data", "models"));
  });
});

describe("models:fetch", () => {
  async function capture(args: string[]) {
    let output = "";
    await main(args, { lock, stdout: (text) => (output += text) });
    return output;
  }
  const downloaded = (output: string): boolean[] =>
    JSON.parse(output).models.map((model: { downloaded: boolean }) => model.downloaded);

  test("fetches every locked model into <data dir>/models and prints JSON", async () => {
    const first = await capture(["--data-dir", directory]);
    expect(JSON.parse(first).directory).toBe(join(directory, "models"));
    expect(downloaded(first)).toEqual([true, true]);
    expect(downloaded(await capture(["--data-dir", directory]))).toEqual([false, false]);
    expect(Object.fromEntries(hits)).toEqual({ "/detector.onnx": 1, "/recognizer.onnx": 1 });
  });

  test("leaves built models to their build command", async () => {
    let output = "";
    await main(["--data-dir", directory], { lock: withBuilt, stdout: (text) => (output += text) });
    expect(JSON.parse(output).models.map(({ id }: { id: string }) => id)).toEqual([
      "detector",
      "recognizer",
    ]);
  });

  test("help documents the data directory; unknown or extra arguments are rejected", async () => {
    const help = await capture(["--help"]);
    expect(help).toContain("--data-dir PATH");
    expect(help).toContain("ICONOGRAPH_DATA_DIR");
    await expect(capture(["--unknown"])).rejects.toThrow();
    await expect(capture(["extra"])).rejects.toThrow("Unexpected arguments");
  });

  test("walkthrough: a stalled download fails with the reason and leaves nothing; a slow one succeeds", async () => {
    let stdout = "";
    let stderr = "";
    const operator = {
      idleTimeoutMs: 150,
      stdout: (text: string) => (stdout += text),
      stderr: (text: string) => (stderr += text),
    };
    const models = join(directory, "models");
    const gated: ModelLock = { models: [weight("detector", "/gated.onnx", detector)] };
    expect(await run(["--data-dir", directory], { ...operator, lock: gated })).toBe(1);
    expect(JSON.parse(stderr).error).toContain(
      `Model detector download from ${gated.models[0].url} stalled: no data for 0.15 s`,
    );
    expect(stdout).toBe("");
    expect(await readdir(models)).toEqual([]);

    const trickle: ModelLock = { models: [weight("recognizer", "/trickle.onnx", recognizer)] };
    expect(await run(["--data-dir", directory], { ...operator, lock: trickle })).toBe(0);
    expect(JSON.parse(stdout).models).toEqual([
      {
        id: "recognizer",
        path: join(models, "recognizer.onnx"),
        sha256: sha256(recognizer),
        downloaded: true,
      },
    ]);
    expect(new Uint8Array(await readFile(join(models, "recognizer.onnx")))).toEqual(recognizer);
    expect(await readdir(models)).toEqual(["recognizer.onnx"]);
  });

  // The root script, run as an operator would; neither case can reach the network.
  async function script(...args: string[]) {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const child = Bun.spawn([process.execPath, "run", "--silent", "models:fetch", ...args], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  test("the root script prints help", async () => {
    const result = await script("--help");
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("--data-dir PATH");
  });

  test("the root script prints failures as JSON on stderr and exits nonzero", async () => {
    const result = await script("--bogus");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error).toContain("--bogus");
  });
});
