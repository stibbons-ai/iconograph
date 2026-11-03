import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readBunLock } from "./bun-lock.ts";
import { externalsManifest, type Target } from "./externals-manifest.ts";

/**
 * Packages the server bundle leaves external (ADR-0009): native addons and the
 * HEIC decoder, whose WebAssembly libheif is loaded unmodified from its own
 * package at runtime (LGPL-3.0).
 */
const SERVER_EXTERNALS = ["onnxruntime-node", "sharp", "libsql", "libheif-js"];

const help = `Build the server for one platform (ADR-0009)

Usage:
  bun run build:server [--os OS] [--cpu CPU] [--libc glibc|musl] [--out DIR]

Bundles packages/server's server, smoke test and health check with Bun, leaving
${SERVER_EXTERNALS.join(", ")} external, then installs only those
externals, production-only, from a manifest generated from bun.lock and pruned to
the target platform (default: this machine), and copies Mastra's model-capability
metadata beside them. Run DIR/server.js with bun. Default DIR: dist/server.
`;

const root = fileURLToPath(new URL("../", import.meta.url));
const serverSource = join(root, "packages/server/src");

function hostLibc(): Target["libc"] {
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } };
  return process.platform === "linux" && !report?.header?.glibcVersionRuntime ? "musl" : "glibc";
}

export async function buildServer(out: string, target: Target) {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  const build = await Bun.build({
    entrypoints: ["server.ts", "smoke.ts", "healthcheck.ts"].map((file) =>
      join(serverSource, file),
    ),
    outdir: out,
    target: "bun",
    external: SERVER_EXTERNALS,
    // The server and the smoke test share most of their code: one chunk instead of two copies.
    splitting: true,
  });
  if (!build.success) throw new AggregateError(build.logs, "Bundling the server failed");

  const manifest = externalsManifest(await readBunLock(root), SERVER_EXTERNALS, target);
  await Bun.write(join(out, "package.json"), `${JSON.stringify(manifest.packageJson, null, 2)}\n`);
  await Bun.write(join(out, "bun.lock"), `${JSON.stringify(manifest.lock, null, 2)}\n`);
  // Exactly the locked versions and integrity hashes; no lifecycle scripts (onnxruntime-node's
  // postinstall would fetch GPU libraries).
  const install = Bun.spawn(
    [
      process.execPath,
      "install",
      "--production",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--linker=hoisted",
      `--os=${target.os}`,
      `--cpu=${target.cpu}`,
    ],
    { cwd: out, stdout: "inherit", stderr: "inherit" },
  );
  if ((await install.exited) !== 0) throw new Error(`Installing the externals in ${out} failed`);

  // onnxruntime-node ships every platform's binaries in one package.
  const ortBinaries = join(out, "node_modules/onnxruntime-node/bin/napi-v6");
  const binding = join(ortBinaries, target.os, target.cpu, "onnxruntime_binding.node");
  if (!(await Bun.file(binding).exists())) {
    throw new Error(`onnxruntime-node ships no binary for ${target.os}/${target.cpu}: ${binding}`);
  }
  for (const os of await readdir(ortBinaries)) {
    if (os !== target.os) {
      await rm(join(ortBinaries, os), { recursive: true });
      continue;
    }
    for (const cpu of await readdir(join(ortBinaries, os))) {
      if (cpu !== target.cpu) await rm(join(ortBinaries, os, cpu), { recursive: true });
    }
  }

  // Mastra resolves model capabilities from JSON beside its own package.json, which the
  // bundle no longer has; without them every capability is silently undefined.
  const mastraCore = dirname(Bun.resolveSync("@mastra/core/package.json", serverSource));
  const mastraOut = join(out, "node_modules/@mastra/core");
  await mkdir(join(mastraOut, "dist"), { recursive: true });
  await cp(join(mastraCore, "package.json"), join(mastraOut, "package.json"));
  await cp(join(mastraCore, "dist/capabilities"), join(mastraOut, "dist/capabilities"), {
    recursive: true,
  });
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      os: { type: "string", default: process.platform },
      cpu: { type: "string", default: process.arch },
      libc: { type: "string", default: hostLibc() },
      out: { type: "string", default: join(root, "dist/server") },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(help);
  } else {
    if (values.libc !== "glibc" && values.libc !== "musl") {
      throw new Error(`--libc must be glibc or musl, got ${values.libc}`);
    }
    await buildServer(values.out, { os: values.os, cpu: values.cpu, libc: values.libc });
    console.log(`Built ${values.out} for ${values.os}-${values.cpu}-${values.libc}`);
  }
}
