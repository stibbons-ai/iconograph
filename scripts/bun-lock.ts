import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** The parts of Bun's text lockfile (`bun.lock`, version 2) the scripts read. */
type Dependencies = Record<string, string>;

export interface DependencyMetadata {
  dependencies?: Dependencies;
  devDependencies?: Dependencies;
  optionalDependencies?: Dependencies;
  peerDependencies?: Dependencies;
}

export interface LockMetadata extends DependencyMetadata {
  os?: string | string[];
  cpu?: string | string[];
}

/**
 * A `packages` entry as stored: `name@version` first; the rest depends on the
 * source (see `lockEntry`), so it is read only through `lockEntry`.
 */
export type RawLockEntry = readonly [string, ...unknown[]];

export interface BunLock {
  lockfileVersion: number;
  configVersion?: number;
  workspaces: Record<string, { name: string } & DependencyMetadata>;
  /** Keyed by install path (`parent/@scope/name`). */
  packages: Record<string, RawLockEntry>;
}

/**
 * A `packages` entry by source. Only registry entries
 * (`[identity, registry, metadata, integrity]`) carry platform and dependency
 * metadata where the scripts read it; workspace, git and file entries are
 * shaped differently.
 */
export type LockEntry =
  | {
      source: "registry";
      identity: string;
      name: string;
      version: string;
      metadata: LockMetadata | undefined;
      integrity: string | undefined;
    }
  | { source: "workspace" | "other"; identity: string; name: string; version: string };

/** A full semver version (`1.2.3`, `0.0.0-beta.1+build`), as registry packages have. */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** A registry version, not a `git+…`, `file:`, `link:` or `workspace:` source. */
export function isRegistryVersion(version: string): boolean {
  return SEMVER.test(version);
}

/**
 * A lock entry's `name@version` (`@scope/name@1.0.0`, `x@git+ssh://git@host/…`),
 * split at the `@` after the name.
 */
export function splitIdentity(identity: string): { name: string; version: string } {
  const at = identity.indexOf("@", 1);
  return { name: identity.slice(0, at), version: identity.slice(at + 1) };
}

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const satisfies readonly (keyof DependencyMetadata)[];

const isStringRecord = (value: unknown) =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((item) => typeof item === "string");

const isConstraint = (value: unknown) =>
  value === undefined ||
  typeof value === "string" ||
  (Array.isArray(value) && value.every((item) => typeof item === "string"));

/** Registry metadata the scripts read: string-valued dependency maps, `os`/`cpu` constraints. */
function isLockMetadata(value: unknown): value is LockMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  return (
    DEPENDENCY_FIELDS.every(
      (field) => fields[field] === undefined || isStringRecord(fields[field]),
    ) &&
    isConstraint(fields.os) &&
    isConstraint(fields.cpu)
  );
}

/** Entries already classified; an entry's shape never changes once decoded. */
const classified = new WeakMap<RawLockEntry, LockEntry>();

/** Classify an entry; throws when a registry entry isn't shaped like one. */
export function lockEntry(key: string, entry: RawLockEntry): LockEntry {
  const known = classified.get(entry);
  if (known !== undefined) return known;
  const result = classify(key, entry);
  classified.set(entry, result);
  return result;
}

function classify(key: string, entry: RawLockEntry): LockEntry {
  const identity = entry[0];
  const { name, version } = splitIdentity(identity);
  if (version.startsWith("workspace:")) return { source: "workspace", identity, name, version };
  if (!isRegistryVersion(version)) return { source: "other", identity, name, version };
  const [, registry, metadata, integrity] = entry;
  if (
    typeof registry !== "string" ||
    (metadata !== undefined && !isLockMetadata(metadata)) ||
    (integrity !== undefined && typeof integrity !== "string")
  ) {
    throw new Error(`bun.lock entry ${key} isn't [identity, registry, metadata, integrity]`);
  }
  return { source: "registry", identity, name, version, metadata, integrity };
}

/** The lockfile format these scripts understand; a newer one needs a review of them. */
export function assertLockVersion(lock: Pick<BunLock, "lockfileVersion">): void {
  if (lock.lockfileVersion !== 2)
    throw new Error("Unsupported Bun lockfile version; review scripts");
}

/**
 * Check the parts of a parsed lockfile the scripts rely on: its version, the
 * workspaces, and every package entry (`lockEntry`).
 */
export function decodeBunLock(value: unknown): BunLock {
  if (
    typeof value !== "object" ||
    value === null ||
    !("lockfileVersion" in value) ||
    typeof value.lockfileVersion !== "number"
  ) {
    throw new Error("bun.lock has no lockfileVersion");
  }
  assertLockVersion({ lockfileVersion: value.lockfileVersion });
  if (
    !("workspaces" in value) ||
    typeof value.workspaces !== "object" ||
    value.workspaces === null ||
    !("packages" in value) ||
    typeof value.packages !== "object" ||
    value.packages === null
  ) {
    throw new Error("bun.lock lacks its workspaces or packages");
  }
  for (const [key, entry] of Object.entries(value.packages)) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string" || !entry[0].includes("@", 1)) {
      throw new Error(`bun.lock entry ${key} doesn't start with its name@version`);
    }
    lockEntry(key, entry as unknown as RawLockEntry);
  }
  // Checked above; entries are read through `lockEntry`.
  return value as BunLock;
}

/** The repository's `bun.lock` under `root`, checked. */
export async function readBunLock(root: string): Promise<BunLock> {
  return decodeBunLock(Bun.JSONC.parse(await readFile(join(root, "bun.lock"), "utf8")));
}

/** An npm `os`/`cpu` constraint (`["linux"]`, `["!win32"]`) that rules out `actual`. */
export function excluded(constraint: string | string[] | undefined, actual: string): boolean {
  if (constraint === undefined) return false;
  const values = typeof constraint === "string" ? [constraint] : constraint;
  const positive = values.filter((value) => !value.startsWith("!"));
  return values.includes(`!${actual}`) || (positive.length > 0 && !positive.includes(actual));
}

/** The package names along a lock key: `libsql/@scope/name` → `libsql`, `@scope/name`. */
export function keyPath(key: string): string[] {
  const names: string[] = [];
  for (const segment of key.split("/")) {
    const last = names.at(-1);
    if (last?.startsWith("@") && !last.includes("/"))
      names[names.length - 1] = `${last}/${segment}`;
    else names.push(segment);
  }
  return names;
}
