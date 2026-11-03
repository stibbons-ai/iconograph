/**
 * The container's health check: distroless has no shell or curl, so the image
 * runs this with `bun`. Exits 0 when the server's `/health` answers 200; else
 * writes why, with the URL it checked, to stderr (Docker keeps it in the
 * health log) and exits 1.
 */
import { listenAddress, urlHost, WILDCARD_HOSTS } from "./listen-address";

let url = "/health";
try {
  const { hostname, port } = listenAddress();
  // A wildcard bind is reachable on loopback; a specific address only on itself.
  const host = WILDCARD_HOSTS.has(hostname) ? "127.0.0.1" : urlHost(hostname);
  url = `http://${host}:${port}/health`;
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) {
    process.stderr.write(`${url} answered ${response.status}: ${await response.text()}\n`);
    process.exit(1);
  }
} catch (error) {
  process.stderr.write(`${url}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
