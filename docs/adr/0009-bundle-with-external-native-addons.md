---
title: "Ship a Bun JS bundle with only the native addons as node_modules, not a compiled binary"
status: accepted
date: 2026-10-30
---

# Ship a Bun JS bundle with only the native addons as node_modules, not a compiled binary

The server is built with `bun build --target bun`, marking the native addons (`onnxruntime-node`, `sharp`, `libsql`) external; the image is `distroless/cc-debian12` plus the `bun` binary, the bundle, and a production install of only those externals (generated from `bun.lock`, pruned to the target platform: ~55 MB instead of ~560 MB). `bun build --compile` with the same externals also works and is the same size and startup time, but needs `--compile-autoload-package-json` and a `NODE_PATH` workaround (oven-sh/bun#44053), so we chose the bundle.

## Consequences

- Bundling breaks Mastra's model-capability lookup silently (it reads JSON next to its own `package.json`); the build copies that metadata into `node_modules/@mastra/core/`, and a CI smoke test on the built image asserts capabilities resolve, ORT loads, `sharp` decodes and LibSQL opens.
- Model weights are not in the image; they are downloaded on first start into the data volume (ADR-0005).
- Amended by [ADR-0012](0012-container-binds-all-interfaces-publish-on-loopback.md): the final stage is `cc-debian13`, and `libheif-js` is a fourth external.
