import { readdir, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { licenseViolation, validateAllowlist } from "./license-policy.ts";
import type { LicenseException, PackageLicense } from "./license-policy.ts";

interface PlatformConstraints {
  os?: string | string[];
  cpu?: string | string[];
}

export interface BunLock {
  lockfileVersion: number;
  workspaces: Record<string, { name: string }>;
  packages: Record<string, [string, string?, PlatformConstraints?, ...unknown[]]>;
}

export interface InstalledPackage extends PackageLicense {
  path: string;
}

interface PlatformLicenseMetadata extends PackageLicense {
  license: string;
  integrity: string;
  source: string;
}

function excluded(constraint: string | string[] | undefined, actual: string): boolean {
  if (constraint === undefined) return false;
  const values = typeof constraint === "string" ? [constraint] : constraint;
  const positive = values.filter((value) => !value.startsWith("!"));
  return values.includes(`!${actual}`) || (positive.length > 0 && !positive.includes(actual));
}

export function missingLockedPackages(
  lock: BunLock,
  installed: readonly PackageLicense[],
  platform = process.platform,
  arch = process.arch,
): { missing: string[]; omitted: string[] } {
  if (lock.lockfileVersion !== 2)
    throw new Error("Unsupported Bun lockfile version; review scanner");
  const present = new Set(installed.map((pkg) => `${pkg.name}@${pkg.version}`));
  const missing: string[] = [];
  const omitted: string[] = [];
  for (const [identity, , constraints] of Object.values(lock.packages)) {
    if (identity.includes("@workspace:")) continue;
    if (present.has(identity)) continue;
    if (excluded(constraints?.os, platform) || excluded(constraints?.cpu, arch)) {
      omitted.push(identity);
    } else {
      missing.push(identity);
    }
  }
  return { missing: [...new Set(missing)], omitted: [...new Set(omitted)] };
}

function validatePlatformMetadata(value: unknown): Map<string, PlatformLicenseMetadata> {
  if (!Array.isArray(value)) throw new Error("Platform licence metadata must be an array");
  const metadata = new Map<string, PlatformLicenseMetadata>();
  for (const entry of value) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !["name", "version", "license", "integrity", "source"].every(
        (key) => typeof entry[key] === "string" && entry[key].trim().length > 0,
      ) ||
      !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(entry.name) ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(entry.version) ||
      entry.source !== `https://registry.npmjs.org/${entry.name}/${entry.version}`
    ) {
      throw new Error(
        "Every platform licence entry requires an exact package, version, licence, integrity and npm version source",
      );
    }
    const identity = `${entry.name}@${entry.version}`;
    if (metadata.has(identity)) throw new Error(`Duplicate platform licence metadata: ${identity}`);
    metadata.set(identity, entry);
  }
  return metadata;
}

export function auditLicenses(
  lock: BunLock,
  installed: readonly InstalledPackage[],
  platformMetadata: unknown,
  allowlist: readonly LicenseException[] = [],
  platform = process.platform,
  arch = process.arch,
): string[] {
  const metadata = validatePlatformMetadata(platformMetadata);
  const { missing, omitted } = missingLockedPackages(lock, installed, platform, arch);
  const failures = missing.map(
    (identity) => `${identity}: locked package missing; install the full graph`,
  );
  const omittedIdentities = new Set(omitted);
  for (const [identity, , , integrity] of Object.values(lock.packages)) {
    if (!omittedIdentities.has(identity)) continue;
    const pkg = metadata.get(identity);
    if (!pkg) {
      failures.push(`${identity}: missing reviewed platform licence metadata`);
    } else if (typeof integrity !== "string" || pkg.integrity !== integrity) {
      failures.push(`${identity}: platform metadata integrity does not match bun.lock`);
    } else {
      const violation = licenseViolation(pkg, allowlist);
      if (violation) failures.push(`${identity}: ${violation} (reviewed platform metadata)`);
    }
  }
  for (const pkg of installed) {
    const violation = licenseViolation(pkg, allowlist);
    if (violation) failures.push(`${pkg.name}@${pkg.version}: ${violation} (${pkg.path})`);
  }
  return failures;
}

export async function collectInstalledPackages(
  root: string,
  workspacePaths: readonly string[],
): Promise<InstalledPackage[]> {
  const workspaces = new Set(await Promise.all(workspacePaths.map((path) => realpath(path))));
  const visited = new Set<string>();
  const packages: InstalledPackage[] = [];

  async function visitPackage(directory: string): Promise<void> {
    const path = await realpath(directory);
    if (visited.has(path) || workspaces.has(path)) return;
    visited.add(path);
    const manifest = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
    if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
      throw new Error(`Invalid installed package identity: ${path}`);
    }
    packages.push({
      name: manifest.name,
      version: manifest.version,
      license: manifest.license,
      path,
    });
    await visitNodeModules(join(path, "node_modules"), false);
  }

  async function visitNodeModules(directory: string, required: boolean): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.name === ".bun") {
        for (const slot of await readdir(path, { withFileTypes: true })) {
          if (slot.isDirectory())
            await visitNodeModules(join(path, slot.name, "node_modules"), false);
        }
      } else if (entry.name.startsWith("@")) {
        for (const name of await readdir(path)) await visitPackage(join(path, name));
      } else if (!entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink())) {
        await visitPackage(path);
      }
    }
  }

  await visitNodeModules(join(root, "node_modules"), true);
  for (const workspace of workspaces)
    await visitNodeModules(join(workspace, "node_modules"), false);
  return packages.sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
  );
}

async function main(): Promise<void> {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const lock = Bun.JSONC.parse(await readFile(join(root, "bun.lock"), "utf8")) as BunLock;
  const allowlist = validateAllowlist(
    JSON.parse(await readFile(join(root, "scripts/license-allowlist.json"), "utf8")),
  );
  const installed = await collectInstalledPackages(
    root,
    Object.keys(lock.workspaces).map((path) => resolve(root, path)),
  );
  const platformMetadata: unknown = JSON.parse(
    await readFile(join(root, "scripts/platform-license-metadata.json"), "utf8"),
  );
  const failures = auditLicenses(lock, installed, platformMetadata, allowlist);
  if (failures.length > 0) {
    throw new Error(`Dependency licence policy failed:\n${failures.join("\n")}`);
  }
  console.log(
    `Licence policy passed for the full runtime + dev lock graph and ${installed.length} installed package locations.`,
  );
}

if (import.meta.main) {
  await main();
}
