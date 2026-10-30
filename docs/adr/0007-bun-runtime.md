# Bun is the runtime, package manager and workspace tool

Iconograph runs on Bun, not Node, and uses Bun workspaces and `bun` scripts throughout. Mastra documents Node first; under Bun we verified `@mastra/core` workflows with `LibSQLStore` (`@libsql/client`), `onnxruntime-node`, `sharp`, `bunx --bun mastra dev` (Studio), and mounting Mastra's routes into our own Hono app via `@mastra/hono` on `Bun.serve`; Effect ships `@effect/platform-bun`. Production boots from our own Bun entrypoint with the Hono adapter; `mastra dev` is for development only.

## Consequences

- Bun sends crash reports to bun.report by default on macOS/Windows; `DO_NOT_TRACK=1` is set alongside `MASTRA_TELEMETRY_DISABLED=1` (ADR-0005).
- Native addons stay outside any bundle (ADR-0003).
