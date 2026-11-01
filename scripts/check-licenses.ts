import { readdir, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { licenseViolation, validateAllowlist } from "./license-policy.ts";
import type { LicenseException, PackageLicense } from "./license-policy.ts";

type Dependencies = Record<string, string>;

interface DependencyMetadata {
  dependencies?: Dependencies;
  devDependencies?: Dependencies;
  optionalDependencies?: Dependencies;
  peerDependencies?: Dependencies;
}

interface LockMetadata extends DependencyMetadata {
  os?: string | string[];
  cpu?: string | string[];
}

export interface BunLock {
  lockfileVersion: number;
  workspaces: Record<string, { name: string } & DependencyMetadata>;
  packages: Record<string, [string, string?, LockMetadata?, ...unknown[]]>;
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

/**
 * Package names a lock entry or workspace depends on, of every dependency kind.
 * An npm alias (`"alias": "npm:real@1.0.0"`) yields both names, since the lock
 * entry it points to carries the real name.
 */
function dependencyNames(metadata: DependencyMetadata | undefined): string[] {
  return [
    metadata?.dependencies,
    metadata?.devDependencies,
    metadata?.optionalDependencies,
    metadata?.peerDependencies,
  ].flatMap((dependencies) =>
    Object.entries(dependencies ?? {}).flatMap(([name, specifier]) => {
      const alias = /^npm:((?:@[^/@]+\/)?[^@]+)/.exec(specifier);
      return alias ? [name, alias[1]!] : [name];
    }),
  );
}

/** The dependency name a lock key installs, e.g. `parent/@scope/name` → `@scope/name`. */
function keyName(key: string): string {
  const segments = key.split("/");
  const scope = segments.at(-2);
  return scope?.startsWith("@") ? `${scope}/${segments.at(-1)}` : segments.at(-1)!;
}

/**
 * Split uninstalled lock entries into `missing` (this host should have them) and
 * `omitted` (foreign platform). An entry is omitted when its own os/cpu excludes
 * this host, or when it has dependents and every one of them is omitted, e.g.
 * sharp's WebAssembly fallback that only foreign-platform packages pull in.
 *
 * An entry's dependents are everything that depends, by any dependency kind
 * (including workspace devDependencies), on its real package name or on the name
 * its lock key installs it under. The key name covers aliases the specifier
 * doesn't show (`catalog:`, top-level overrides). Names ignore versions, so
 * dependents of another version count too. That keeps an entry missing when a
 * host package needs any version, but it can also make an entry with no
 * dependents of its own omitted because only foreign-platform packages use
 * another version. Omitted entries still need reviewed licence metadata whose
 * integrity matches the lock.
 */
export function missingLockedPackages(
  lock: BunLock,
  installed: readonly PackageLicense[],
  platform = process.platform,
  arch = process.arch,
): { missing: string[]; omitted: string[] } {
  if (lock.lockfileVersion !== 2)
    throw new Error("Unsupported Bun lockfile version; review scanner");
  const present = new Set(installed.map((pkg) => `${pkg.name}@${pkg.version}`));
  const entries = Object.entries(lock.packages).filter(
    ([, [identity]]) => !identity.includes("@workspace:") && !present.has(identity),
  );
  const omitted = new Set(
    entries
      .filter(
        ([, [, , metadata]]) => excluded(metadata?.os, platform) || excluded(metadata?.cpu, arch),
      )
      .map(([, [identity]]) => identity),
  );
  const dependents = new Map<string, string[]>();
  const dependencies: (readonly [string, DependencyMetadata | undefined])[] = [
    ...Object.values(lock.workspaces).map((workspace) => ["<workspace>", workspace] as const),
    ...Object.values(lock.packages).map(([identity, , metadata]) => [identity, metadata] as const),
  ];
  for (const [dependent, metadata] of dependencies) {
    for (const name of dependencyNames(metadata)) {
      const users = dependents.get(name);
      if (users) users.push(dependent);
      else dependents.set(name, [dependent]);
    }
  }
  // Every name the entry is installed or depended on under; one identity can sit under several keys.
  const usersOf = new Map<string, string[]>();
  for (const [key, [identity]] of entries) {
    const names = new Set([identity.slice(0, identity.lastIndexOf("@")), keyName(key)]);
    const users = [...names].flatMap((name) => dependents.get(name) ?? []);
    usersOf.set(identity, [...(usersOf.get(identity) ?? []), ...users]);
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const [, [identity]] of entries) {
      if (omitted.has(identity)) continue;
      const users = usersOf.get(identity)!;
      if (users.length > 0 && users.every((user) => omitted.has(user))) {
        omitted.add(identity);
        changed = true;
      }
    }
  }
  const identities = [...new Set(entries.map(([, [identity]]) => identity))];
  return {
    missing: identities.filter((identity) => !omitted.has(identity)),
    omitted: identities.filter((identity) => omitted.has(identity)),
  };
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
