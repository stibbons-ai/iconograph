import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditLicenses,
  collectInstalledPackages,
  missingLockedPackages,
} from "./check-licenses.ts";
import type { BunLock } from "./check-licenses.ts";
import { licenseViolation, validateAllowlist } from "./license-policy.ts";

const pkg = (license: unknown) => ({ name: "example", version: "1.2.3", license });
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SPDX licence choices", () => {
  test.each(["MIT", "Apache-2.0", "ISC", "BSD-2-Clause", "BSD-3-Clause", "BlueOak-1.0.0"])(
    "accepts reviewed permissive %s",
    (license) => expect(licenseViolation(pkg(license))).toBeUndefined(),
  );

  test.each([
    "GPL-3.0-only",
    "AGPL-3.0-or-later",
    "LGPL-2.1-only",
    "MPL-2.0",
    "CC-BY-NC-4.0",
    "BUSL-1.1",
    "LicenseRef-Proprietary",
    "UNLICENSED",
    "SEE LICENSE IN LICENSE.txt",
    "MIT-ish",
    "MIT WITH LLVM-exception",
    "MIT+",
    "",
    undefined,
    null,
    { type: "MIT" },
  ])("rejects unapproved licence %j", (license) => {
    expect(licenseViolation(pkg(license))).toBeString();
  });

  test("OR permits a compliant choice; AND requires every obligation", () => {
    expect(licenseViolation(pkg("(GPL-3.0-only OR MIT)"))).toBeUndefined();
    expect(licenseViolation(pkg("(AFL-2.1 OR BSD-3-Clause)"))).toBeUndefined();
    expect(licenseViolation(pkg("MIT AND Apache-2.0"))).toBeUndefined();
    expect(licenseViolation(pkg("(MIT OR GPL-3.0-only) AND LGPL-2.1-only"))).toBeString();
    expect(licenseViolation(pkg("GPL-3.0-only OR (MIT AND AGPL-3.0-only)"))).toBeString();
    expect(licenseViolation(pkg("MIT AND GPL-3.0-only OR Apache-2.0"))).toBeUndefined();
    expect(licenseViolation(pkg("MIT OR not-a-license"))).toBeString();
  });
});

describe("reviewed exact exceptions", () => {
  const reviewed = {
    name: "example",
    version: "1.2.3",
    license: "LicenseRef-Reviewed",
    reason: "Reviewed upstream licence text and documented attribution.",
  };

  test("matches package, version and full licence string", () => {
    const allowlist = validateAllowlist([reviewed]);
    expect(licenseViolation(pkg(reviewed.license), allowlist)).toBeUndefined();
    expect(licenseViolation({ ...pkg(reviewed.license), name: "other" }, allowlist)).toBeString();
    expect(
      licenseViolation({ ...pkg(reviewed.license), version: "1.2.4" }, allowlist),
    ).toBeString();
    expect(licenseViolation(pkg("LicenseRef-Different"), allowlist)).toBeString();
    expect(licenseViolation(pkg(undefined), allowlist)).toBeString();
  });

  test("rejects broad versions, empty reasons and duplicate entries", () => {
    expect(() => validateAllowlist([{ ...reviewed, version: "^1.2.3" }])).toThrow();
    expect(() => validateAllowlist([{ ...reviewed, name: "@scope/*" }])).toThrow();
    expect(() => validateAllowlist([{ ...reviewed, reason: " " }])).toThrow();
    expect(() => validateAllowlist([reviewed, reviewed])).toThrow();
    expect(() => validateAllowlist({})).toThrow();
  });
});

describe("installed graph coverage", () => {
  test("includes nested, scoped and isolated Bun packages and follows links without cycles", async () => {
    const root = await mkdtemp(join(tmpdir(), "iconograph-licenses-"));
    roots.push(root);
    async function install(path: string, name: string, license = "MIT") {
      await mkdir(path, { recursive: true });
      await writeFile(
        join(path, "package.json"),
        JSON.stringify({ name, version: "1.0.0", license }),
      );
    }
    const a = join(root, "node_modules/a");
    const b = join(a, "node_modules/b");
    await install(a, "a");
    await install(b, "b", "GPL-3.0-only");
    await mkdir(join(b, "node_modules"));
    await symlink(a, join(b, "node_modules/a"));
    await install(join(root, "node_modules/@scope/c"), "@scope/c");
    const d = join(root, "node_modules/.bun/d@1.0.0/node_modules/d");
    await install(d, "d");
    await symlink(d, join(root, "node_modules/d"));
    const installed = await collectInstalledPackages(root, []);
    expect(installed.map((entry) => entry.name)).toEqual(["@scope/c", "a", "b", "d"]);
    expect(installed.filter((entry) => licenseViolation(entry))).toHaveLength(1);
  });

  test("fails a missing install instead of passing an empty audit", async () => {
    const root = await mkdtemp(join(tmpdir(), "iconograph-licenses-"));
    roots.push(root);
    await expect(collectInstalledPackages(root, [])).rejects.toThrow();
  });

  test("requires all host-compatible lock entries and reports foreign-platform omissions", () => {
    const lock: BunLock = {
      lockfileVersion: 2,
      workspaces: {},
      packages: {
        a: ["a@1.0.0"],
        alias: ["real-package@2.0.0"],
        native: ["native@1.0.0", "", { os: "linux", cpu: "x64" }],
        foreign: ["foreign@1.0.0", "", { os: "darwin", cpu: "arm64" }],
        excluded: ["excluded@1.0.0", "", { os: ["!linux"] }],
        workspace: ["@iconograph/domain@workspace:packages/domain"],
      },
    };
    expect(
      missingLockedPackages(
        lock,
        [{ name: "a", version: "1.0.0", license: "MIT" }],
        "linux",
        "x64",
      ),
    ).toEqual({
      missing: ["real-package@2.0.0", "native@1.0.0"],
      omitted: ["foreign@1.0.0", "excluded@1.0.0"],
    });
    expect(() => missingLockedPackages({ ...lock, lockfileVersion: 99 }, [])).toThrow();
  });
});

describe("offline platform licence coverage", () => {
  const metadata = {
    name: "@example/windows-only",
    version: "1.0.0",
    license: "MIT",
    integrity: "sha512-reviewed",
    source: "https://registry.npmjs.org/@example/windows-only/1.0.0",
  };
  const identity = `${metadata.name}@${metadata.version}`;
  const lock: BunLock = {
    lockfileVersion: 2,
    workspaces: {},
    packages: {
      native: [identity, "", { os: "win32", cpu: "x64" }, metadata.integrity],
    },
  };

  test.each(["linux", "darwin"] as const)(
    "rejects an unknown omitted Windows-only dependency on %s",
    (platform) => {
      expect(auditLicenses(lock, [], [], [], platform, "x64")).toEqual([
        `${identity}: missing reviewed platform licence metadata`,
      ]);
    },
  );

  test.each(["linux", "darwin"] as const)(
    "accepts exact reviewed permissive metadata on %s",
    (platform) => {
      expect(auditLicenses(lock, [], [metadata], [], platform, "x64")).toEqual([]);
    },
  );

  test("applies the same licence policy and exact allowlist to omitted dependencies", () => {
    const forbidden = { ...metadata, license: "AGPL-3.0-only" };
    expect(auditLicenses(lock, [], [forbidden], [], "linux", "x64")).toEqual([
      `${identity}: Licence requires review: AGPL-3.0-only (reviewed platform metadata)`,
    ]);
    const exception = { ...forbidden, reason: "Reviewed upstream terms for this exact package." };
    expect(
      auditLicenses(lock, [], [forbidden], validateAllowlist([exception]), "linux", "x64"),
    ).toEqual([]);
    for (const mismatch of [
      { ...exception, name: "other" },
      { ...exception, version: "1.0.1" },
      { ...exception, license: "AGPL-3.0-or-later" },
    ]) {
      expect(
        auditLicenses(lock, [], [forbidden], validateAllowlist([mismatch]), "linux", "x64"),
      ).toHaveLength(1);
    }
    expect(
      auditLicenses(lock, [], [{ ...metadata, license: "MIT-ish" }], [], "linux", "x64"),
    ).toEqual([
      `${identity}: Unknown or invalid SPDX licence expression: MIT-ish (reviewed platform metadata)`,
    ]);
  });

  test("does not reuse metadata for another package or version", () => {
    for (const mismatch of [
      {
        ...metadata,
        name: "@example/other",
        source: "https://registry.npmjs.org/@example/other/1.0.0",
      },
      {
        ...metadata,
        version: "1.0.1",
        source: "https://registry.npmjs.org/@example/windows-only/1.0.1",
      },
    ]) {
      expect(auditLicenses(lock, [], [mismatch], [], "linux", "x64")).toEqual([
        `${identity}: missing reviewed platform licence metadata`,
      ]);
    }
  });

  test("requires the reviewed integrity to match the exact lock entry", () => {
    expect(
      auditLicenses(lock, [], [{ ...metadata, integrity: "sha512-changed" }], [], "linux", "x64"),
    ).toEqual([`${identity}: platform metadata integrity does not match bun.lock`]);
    const missingIntegrity: BunLock = {
      ...lock,
      packages: { native: [identity, "", { os: "win32" }] },
    };
    expect(auditLicenses(missingIntegrity, [], [metadata], [], "linux", "x64")).toEqual([
      `${identity}: platform metadata integrity does not match bun.lock`,
    ]);
  });

  test.each(
    [
      undefined,
      null,
      {},
      [null],
      [{ ...metadata, name: "@example/*" }],
      [{ ...metadata, version: "^1.0.0" }],
      [{ ...metadata, license: null }],
      [{ ...metadata, license: " " }],
      [{ ...metadata, integrity: "" }],
      [{ ...metadata, source: "https://registry.npmjs.org/@example/windows-only/latest" }],
      [metadata, metadata],
    ].map((value) => ({ value })),
  )("fails closed for malformed or duplicate metadata %j", ({ value }) => {
    expect(() => auditLicenses(lock, [], value, [], "linux", "x64")).toThrow();
  });

  test("cannot replace a missing host-compatible manifest with reviewed metadata", () => {
    expect(auditLicenses(lock, [], [metadata], [], "win32", "x64")).toEqual([
      `${identity}: locked package missing; install the full graph`,
    ]);
  });

  test("audits installed manifests instead of their permissive platform metadata", () => {
    const installed = [{ ...metadata, license: "AGPL-3.0-only", path: "/node_modules/native" }];
    expect(auditLicenses(lock, installed, [metadata], [], "win32", "x64")).toEqual([
      `${identity}: Licence requires review: AGPL-3.0-only (/node_modules/native)`,
    ]);
  });

  test("also requires reviewed metadata for CPU-only omissions", () => {
    const cpuOnly: BunLock = {
      ...lock,
      packages: { native: [identity, "", { cpu: "arm64" }, metadata.integrity] },
    };
    expect(auditLicenses(cpuOnly, [], [], [], "linux", "x64")).toHaveLength(1);
    expect(auditLicenses(cpuOnly, [], [metadata], [], "linux", "x64")).toEqual([]);
  });
});
