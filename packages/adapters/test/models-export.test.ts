import { describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelLock } from "../src/models";
import { main, type Runner } from "../src/models-export-cli";
import { sha256 } from "./sha256";
import { spawnCli } from "./spawn-cli";
import { temporaryDirectories } from "./temporary-directory";

const temporaryDirectory = temporaryDirectories("models-export");
const cli = fileURLToPath(new URL("../src/models-export-cli.ts", import.meta.url));
const exported = new TextEncoder().encode("exported facenet");
const lock: ModelLock = {
  models: [
    {
      id: "facenet",
      file: "facenet.onnx",
      sha256: sha256(exported),
      size: exported.byteLength,
      license: "MIT",
      build: {
        command: "bun run models:export-facenet",
        script: "scripts/export-facenet.py",
        source: { url: "https://example.test/facenet.pt", sha256: "a".repeat(64), size: 1 },
      },
    },
  ],
};

/** A stand-in for `uv run`: writes `bytes` (unless undefined) to its output path, exits `code`. */
function exporter(bytes: Uint8Array | undefined, code = 0) {
  const commands: string[][] = [];
  const run: Runner = async (command) => {
    commands.push(command);
    if (bytes !== undefined) await Bun.write(command.at(-1)!, bytes);
    return code;
  };
  return { run, commands };
}

async function exportInto(data: string, run: Runner) {
  let output = "";
  let errors = "";
  await main(["--data-dir", data], {
    lock,
    run,
    stdout: (text) => (output += text),
    stderr: (text) => (errors += text),
  });
  return { ...JSON.parse(output), errors };
}

describe("models:export-facenet", () => {
  test("installs a verified export once, then keeps it", async () => {
    const data = await temporaryDirectory();
    const models = join(data, "models");
    const { run, commands } = exporter(exported);
    const path = join(models, "facenet.onnx");
    expect(await exportInto(data, run)).toEqual({
      id: "facenet",
      path,
      sha256: sha256(exported),
      built: true,
      errors: "",
    });
    expect(commands).toHaveLength(1);
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    expect(commands[0]!.slice(0, 3)).toEqual([
      "uv",
      "run",
      join(root, "scripts/export-facenet.py"),
    ]);
    expect(new Uint8Array(await readFile(path))).toEqual(exported);
    expect(await readdir(models)).toEqual(["facenet.onnx"]);

    expect((await exportInto(data, run)).built).toBe(false);
    expect(commands).toHaveLength(1);
  });

  test("installs nothing when the export doesn't match, the script fails or writes nothing", async () => {
    const data = await temporaryDirectory();
    const models = join(data, "models");
    const wrong = new TextEncoder().encode("another export");
    await expect(exportInto(data, exporter(wrong).run)).rejects.toThrow(
      `The FaceNet export failed SHA-256 verification: expected ${sha256(exported)}, actual ${sha256(wrong)}; nothing was installed`,
    );
    expect(await readdir(models)).toEqual([]);
    await expect(exportInto(data, exporter(exported, 2).run)).rejects.toThrow("exited with code 2");
    expect(await readdir(models)).toEqual([]);
    // Exit 0 but nothing written: the empty temp file fails verification.
    await expect(exportInto(data, exporter(undefined).run)).rejects.toThrow(
      `actual ${sha256(new Uint8Array())}; nothing was installed`,
    );
    // Exit 0 after removing its output.
    const removing: Runner = async (command) => {
      await rm(command.at(-1)!);
      return 0;
    };
    await expect(exportInto(data, removing)).rejects.toThrow("The FaceNet export wrote no file");
    expect(await readdir(models)).toEqual([]);
  });

  test("removes temp files left by an interrupted build before building", async () => {
    const data = await temporaryDirectory();
    const models = join(data, "models");
    const stale = join(models, "facenet.onnx.0b6f6a7e-interrupted.partial.onnx");
    const unrelated = join(models, "other.onnx.1234.partial.onnx");
    await Bun.write(stale, "half an export");
    await Bun.write(unrelated, "someone else's");
    expect((await exportInto(data, exporter(exported).run)).built).toBe(true);
    expect((await readdir(models)).sort()).toEqual([
      "facenet.onnx",
      "other.onnx.1234.partial.onnx",
    ]);
  });

  test("replaces a tampered file with a verified export and names the replaced hash", async () => {
    const data = await temporaryDirectory();
    const path = join(data, "models", "facenet.onnx");
    await Bun.write(path, "tampered");
    const result = await exportInto(data, exporter(exported).run);
    expect(result.built).toBe(true);
    expect(JSON.parse(result.errors)).toEqual({
      warning: `Rebuilding ${path}: its SHA-256 ${sha256("tampered")} does not match the lock's ${sha256(exported)}`,
    });
    expect(new Uint8Array(await readFile(path))).toEqual(exported);
  });

  test("raises an unreadable file instead of rebuilding it", async () => {
    const data = await temporaryDirectory();
    const path = join(data, "models", "facenet.onnx");
    await mkdir(path, { recursive: true }); // A directory where the file should be.
    const { run, commands } = exporter(exported);
    await expect(exportInto(data, run)).rejects.toThrow(
      `Model facenet at ${path} could not be read:`,
    );
    expect(commands).toHaveLength(0);
  });

  test("as a process, exits nonzero with a JSON error", async () => {
    const { stdout, stderr, exitCode } = await spawnCli([cli, "--bogus"]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr).error).toContain("--bogus");
  });

  test("as a process without uv on PATH, exits 1 with the install hint", async () => {
    const data = await temporaryDirectory();
    const emptyPath = await temporaryDirectory();
    const { stdout, stderr, exitCode } = await spawnCli([cli, "--data-dir", data], {
      env: { PATH: emptyPath },
    });
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    const { error } = JSON.parse(stderr);
    expect(error).toContain("install uv: https://docs.astral.sh/uv/");
    expect(await readdir(join(data, "models"))).toEqual([]);
  });
});
