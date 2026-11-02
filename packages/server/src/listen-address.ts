/**
 * Where the server listens, shared by the server and the container health
 * check. Dependency-free, so the health check's bundle loads nothing else.
 */

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4111;

/** Addresses that bind every interface, reachable on loopback. */
export const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

/**
 * `ICONOGRAPH_HOST` (default 127.0.0.1) and `ICONOGRAPH_PORT` (default 4111;
 * 0 picks a free port). Empty values count as unset; generic HOST/PORT never apply.
 */
export function listenAddress(env: Record<string, string | undefined> = process.env) {
  const portText = env.ICONOGRAPH_PORT || String(DEFAULT_PORT);
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port > 65_535) {
    throw new Error(`ICONOGRAPH_PORT must be a port number from 0 to 65535, got ${portText}`);
  }
  return { hostname: env.ICONOGRAPH_HOST || DEFAULT_HOST, port };
}

/** A host as it appears in a URL: IPv6 addresses in brackets. */
export const urlHost = (hostname: string) =>
  hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
