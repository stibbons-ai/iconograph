import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  assertLockVersion,
  decodeBunLock,
  isRegistryVersion,
  keyPath,
  lockEntry,
  readBunLock,
  splitIdentity,
} from "./bun-lock.ts";

const valid = {
  lockfileVersion: 2,
  workspaces: { "": { name: "app" } },
  packages: {
    sharp: ["sharp@0.35.5", "", { os: "linux" }, "sha512-x"],
    "@iconograph/server": ["@iconograph/server@workspace:packages/server"],
    gitdep: ["gitdep@git+ssh://git@example.com/x.git#abc", { dependencies: {} }, "abc"],
  },
};

describe("bun.lock parsing", () => {
  test("accepts the repository's lock and a well-formed one", async () => {
    const lock = await readBunLock(fileURLToPath(new URL("../", import.meta.url)));
    expect(lock.packages.sharp?.[0]).toStartWith("sharp@");
    expect(decodeBunLock(valid).packages.sharp?.[2]).toEqual({ os: "linux" });
  });

  test("rejects other versions and malformed entries", () => {
    expect(() => assertLockVersion({ lockfileVersion: 3 })).toThrow(
      "Unsupported Bun lockfile version",
    );
    expect(() => decodeBunLock({ ...valid, lockfileVersion: 1 })).toThrow("Unsupported");
    expect(() => decodeBunLock({ workspaces: {}, packages: {} })).toThrow("no lockfileVersion");
    expect(() => decodeBunLock({ lockfileVersion: 2, workspaces: {} })).toThrow(
      "lacks its workspaces or packages",
    );
    expect(() => decodeBunLock({ ...valid, packages: { x: ["noversion"] } })).toThrow(
      "doesn't start with its name@version",
    );
    for (const entry of [
      ["x@1.0.0", "", "meta?"],
      // The registry string is required; without it the entry isn't a registry entry.
      ["x@1.0.0"],
      ["x@1.0.0", "", {}, 42],
      ["x@1.0.0", "", { dependencies: { y: 1 } }],
      ["x@1.0.0", "", { os: ["linux", 1] }],
      ["x@1.0.0", "", { optionalDependencies: ["y"] }],
    ]) {
      expect(() => decodeBunLock({ ...valid, packages: { x: entry } })).toThrow(
        "isn't [identity, registry, metadata, integrity]",
      );
    }
  });

  test("classifies entries by source; only registry entries expose metadata", () => {
    expect(lockEntry("sharp", ["sharp@0.35.5", "", { os: "linux" }, "sha512-x"])).toEqual({
      source: "registry",
      identity: "sharp@0.35.5",
      name: "sharp",
      version: "0.35.5",
      metadata: { os: "linux" },
      integrity: "sha512-x",
    });
    expect(lockEntry("d", ["@iconograph/domain@workspace:packages/domain"])).toMatchObject({
      source: "workspace",
      name: "@iconograph/domain",
    });
    expect(
      lockEntry("g", ["g@git+ssh://git@host/g.git#abc", { dependencies: { x: "1" } }, "abc"]),
    ).toEqual({
      source: "other",
      identity: "g@git+ssh://git@host/g.git#abc",
      name: "g",
      version: "git+ssh://git@host/g.git#abc",
    });
  });

  test("splits identities at the `@` after the name, for scopes and git sources", () => {
    expect(splitIdentity("sharp@0.35.5")).toEqual({ name: "sharp", version: "0.35.5" });
    expect(splitIdentity("@img/sharp-linux-arm64@0.35.5")).toEqual({
      name: "@img/sharp-linux-arm64",
      version: "0.35.5",
    });
    expect(splitIdentity("x@git+ssh://git@host/x.git#abc")).toEqual({
      name: "x",
      version: "git+ssh://git@host/x.git#abc",
    });
    expect(isRegistryVersion("0.0.0-beta.1")).toBe(true);
    expect(isRegistryVersion("workspace:packages/server")).toBe(false);
    expect(isRegistryVersion("git+ssh://git@host/x.git#abc")).toBe(false);
  });

  test("reads lock keys as install paths, scopes included", () => {
    expect(keyPath("libsql/detect-libc")).toEqual(["libsql", "detect-libc"]);
    expect(keyPath("parent/@scope/name")).toEqual(["parent", "@scope/name"]);
  });
});
