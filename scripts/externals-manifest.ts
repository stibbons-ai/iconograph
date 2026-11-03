import {
  assertLockVersion,
  type BunLock,
  excluded,
  keyPath,
  type LockMetadata,
  lockEntry,
} from "./bun-lock.ts";

/** The platform the externals are installed for, as npm names it. */
export interface Target {
  os: string;
  cpu: string;
  libc: "glibc" | "musl";
}

export interface ExternalsManifest {
  /** `dependencies`: each external at its locked version. */
  packageJson: { name: string; private: true; dependencies: Record<string, string> };
  /** The lock's entries for the externals and everything they need on `target`, verbatim. */
  lock: BunLock;
}

/**
 * Lock entries carry `os` and `cpu` but no `libc`; a Linux-only native package
 * names its libc instead (`@img/sharp-linuxmusl-arm64`, `@libsql/linux-arm64-musl`),
 * and the others are glibc builds. Packages for several systems fit any libc.
 */
const fitsLibc = (name: string, metadata: LockMetadata | undefined, libc: Target["libc"]) => {
  const os = [metadata?.os ?? []].flat();
  return os.length !== 1 || os[0] !== "linux" || /musl/.test(name) === (libc === "musl");
};

/**
 * The externals' production install for one platform, generated from the
 * repository's `bun.lock`: the externals at their locked versions and, as a
 * lockfile subset, every entry they depend on (dependencies, and optional
 * dependencies that fit `target`), so `bun install --frozen-lockfile` installs
 * exactly the locked versions with their integrity hashes. Dependencies resolve
 * as Bun's lock keys nest them (`libsql/detect-libc` before `detect-libc`).
 */
export function externalsManifest(
  lock: BunLock,
  externals: readonly string[],
  target: Target,
): ExternalsManifest {
  assertLockVersion(lock);
  /** The registry entry at `key`: its platform and dependencies are read from its metadata. */
  const registryEntry = (key: string) => {
    const entry = lockEntry(key, lock.packages[key]!);
    if (entry.source !== "registry") {
      throw new Error(`${key} (${entry.identity}) isn't a registry package`);
    }
    return entry;
  };
  const fits = (key: string) => {
    const { metadata } = registryEntry(key);
    return (
      !excluded(metadata?.os, target.os) &&
      !excluded(metadata?.cpu, target.cpu) &&
      fitsLibc(keyPath(key).at(-1)!, metadata, target.libc)
    );
  };
  /** The key `name` resolves to from the package at `from`: the nearest nesting first. */
  const resolve = (from: string, name: string) => {
    const path = keyPath(from);
    for (let depth = path.length; depth >= 0; depth--) {
      const key = [...path.slice(0, depth), name].join("/");
      if (key in lock.packages) return key;
    }
    return undefined;
  };

  const packages: BunLock["packages"] = {};
  const dependencies: Record<string, string> = {};
  const queue: string[] = [];
  for (const name of externals) {
    if (!lock.packages[name]) throw new Error(`External ${name} is not in bun.lock`);
    if (!fits(name)) throw new Error(`External ${name} doesn't support ${describe(target)}`);
    dependencies[name] = registryEntry(name).version;
    queue.push(name);
  }
  // Keys pushed while iterating are visited too: a breadth-first walk of the closure.
  for (const key of queue) {
    if (key in packages) continue;
    const { metadata } = registryEntry(key);
    packages[key] = lock.packages[key]!;
    const required = Object.keys(metadata?.dependencies ?? {});
    const optional = Object.keys(metadata?.optionalDependencies ?? {});
    for (const name of [...required, ...optional]) {
      const resolved = resolve(key, name);
      if (resolved === undefined) {
        // Bun locks optional dependencies for every platform, so a missing one is a lock fault too.
        throw new Error(`${key} depends on ${name}, which is not in bun.lock`);
      }
      if (fits(resolved)) queue.push(resolved);
      else if (required.includes(name)) {
        throw new Error(`${key} needs ${name}, which doesn't support ${describe(target)}`);
      }
    }
  }
  const name = "iconograph-server-externals";
  return {
    packageJson: { name, private: true, dependencies },
    // Only what the subset needs: the root's catalog, overrides and trusted packages don't apply.
    lock: {
      lockfileVersion: lock.lockfileVersion,
      ...(lock.configVersion !== undefined && { configVersion: lock.configVersion }),
      workspaces: { "": { name, dependencies } },
      packages: Object.fromEntries(
        Object.entries(packages).sort(([left], [right]) => left.localeCompare(right)),
      ),
    },
  };
}

const describe = ({ os, cpu, libc }: Target) => `${os}-${cpu}-${libc}`;
