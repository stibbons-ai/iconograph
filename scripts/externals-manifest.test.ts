import { describe, expect, test } from "bun:test";
import type { BunLock } from "./bun-lock.ts";
import { externalsManifest } from "./externals-manifest.ts";

const integrity = (name: string) => `sha512-${name}`;
const entry = (identity: string, metadata: Record<string, unknown> = {}) =>
  [identity, "", metadata, integrity(identity)] as BunLock["packages"][string];

/** A bun.lock shaped like the repository's: native packages per platform, one nested version. */
const lock: BunLock = {
  lockfileVersion: 2,
  configVersion: 1,
  workspaces: {
    "": { name: "app", dependencies: { "@app/adapters": "workspace:*", typescript: "6.0.0" } },
    "packages/adapters": { name: "@app/adapters", dependencies: { sharp: "catalog:" } },
  },
  packages: {
    "@app/adapters": entry("@app/adapters@workspace:packages/adapters"),
    typescript: entry("typescript@6.0.0"),
    sharp: entry("sharp@0.35.5", {
      dependencies: { "detect-libc": "^2.1.2", semver: "^7.8.5" },
      optionalDependencies: {
        "@img/sharp-linux-arm64": "0.35.5",
        "@img/sharp-linuxmusl-arm64": "0.35.5",
        "@img/sharp-linux-x64": "0.35.5",
        "@img/sharp-darwin-arm64": "0.35.5",
      },
    }),
    "@img/sharp-linux-arm64": entry("@img/sharp-linux-arm64@0.35.5", {
      optionalDependencies: { "@img/sharp-libvips-linux-arm64": "1.3.4" },
      os: "linux",
      cpu: "arm64",
    }),
    "@img/sharp-libvips-linux-arm64": entry("@img/sharp-libvips-linux-arm64@1.3.4", {
      os: "linux",
      cpu: "arm64",
    }),
    "@img/sharp-linuxmusl-arm64": entry("@img/sharp-linuxmusl-arm64@0.35.5", {
      os: "linux",
      cpu: "arm64",
    }),
    "@img/sharp-linux-x64": entry("@img/sharp-linux-x64@0.35.5", { os: "linux", cpu: "x64" }),
    "@img/sharp-darwin-arm64": entry("@img/sharp-darwin-arm64@0.35.5", {
      os: "darwin",
      cpu: "arm64",
    }),
    "detect-libc": entry("detect-libc@2.1.2"),
    semver: entry("semver@7.8.5"),
    libsql: entry("libsql@0.5.29", {
      dependencies: { "detect-libc": "2.0.2" },
      optionalDependencies: {
        "@libsql/linux-arm64-gnu": "0.5.29",
        "@libsql/linux-arm64-musl": "0.5.29",
        "@libsql/darwin-arm64": "0.5.29",
      },
      os: ["linux", "darwin"],
      cpu: ["x64", "arm64"],
    }),
    "libsql/detect-libc": entry("detect-libc@2.0.2"),
    "@libsql/linux-arm64-gnu": entry("@libsql/linux-arm64-gnu@0.5.29", {
      os: "linux",
      cpu: "arm64",
    }),
    "@libsql/linux-arm64-musl": entry("@libsql/linux-arm64-musl@0.5.29", {
      os: "linux",
      cpu: "arm64",
    }),
    "@libsql/darwin-arm64": entry("@libsql/darwin-arm64@0.5.29", { os: "darwin", cpu: "arm64" }),
  },
};

describe("externalsManifest", () => {
  test("keeps the externals' locked closure for linux-arm64-gnu, with only that platform's native packages", () => {
    const { packageJson, lock: subset } = externalsManifest(lock, ["sharp", "libsql"], {
      os: "linux",
      cpu: "arm64",
      libc: "glibc",
    });
    expect(packageJson.dependencies).toEqual({ sharp: "0.35.5", libsql: "0.5.29" });
    expect(Object.keys(subset.packages)).toEqual([
      "@img/sharp-libvips-linux-arm64",
      "@img/sharp-linux-arm64",
      "@libsql/linux-arm64-gnu",
      "detect-libc",
      "libsql",
      "libsql/detect-libc",
      "semver",
      "sharp",
    ]);
    // Entries are copied verbatim, so the install checks the repository's integrity hashes.
    for (const [key, value] of Object.entries(subset.packages)) {
      expect(value).toEqual(lock.packages[key]!);
    }
    // Only the externals: no workspaces, dev tools or catalogs of the repository.
    expect(subset).toEqual({
      lockfileVersion: 2,
      configVersion: 1,
      workspaces: { "": { name: packageJson.name, dependencies: packageJson.dependencies } },
      packages: subset.packages,
    });
  });

  test("picks musl and x64 packages by target", () => {
    const musl = externalsManifest(lock, ["sharp", "libsql"], {
      os: "linux",
      cpu: "arm64",
      libc: "musl",
    });
    expect(Object.keys(musl.lock.packages).filter((key) => key.startsWith("@"))).toEqual([
      "@img/sharp-linuxmusl-arm64",
      "@libsql/linux-arm64-musl",
    ]);
    const x64 = externalsManifest(lock, ["sharp"], { os: "linux", cpu: "x64", libc: "glibc" });
    expect(Object.keys(x64.lock.packages)).toEqual([
      "@img/sharp-linux-x64",
      "detect-libc",
      "semver",
      "sharp",
    ]);
  });

  test("fails on an external the target can't run or a dependency the lock lacks", () => {
    expect(() =>
      externalsManifest(lock, ["libsql"], { os: "win32", cpu: "x64", libc: "glibc" }),
    ).toThrow("External libsql doesn't support win32-x64-glibc");
    expect(() =>
      externalsManifest(lock, ["onnxruntime-node"], { os: "linux", cpu: "x64", libc: "glibc" }),
    ).toThrow("External onnxruntime-node is not in bun.lock");
    const { semver: _, ...withoutSemver } = lock.packages;
    expect(() =>
      externalsManifest({ ...lock, packages: withoutSemver }, ["sharp"], {
        os: "linux",
        cpu: "x64",
        libc: "glibc",
      }),
    ).toThrow("sharp depends on semver, which is not in bun.lock");
    // Platform and dependency metadata are only read from registry entries.
    expect(() =>
      externalsManifest(
        {
          ...lock,
          packages: {
            ...lock.packages,
            // A git entry keeps its metadata at [1], not where registry entries do.
            semver: ["semver@git+ssh://git@host/semver.git#abc", { dependencies: {} }, "abc"],
          },
        },
        ["sharp"],
        { os: "linux", cpu: "x64", libc: "glibc" },
      ),
    ).toThrow("semver (semver@git+ssh://git@host/semver.git#abc) isn't a registry package");
  });
});
