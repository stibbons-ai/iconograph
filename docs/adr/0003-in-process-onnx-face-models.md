# Face models run in-process via onnxruntime-node, not Rust or a Python sidecar

Face detection and recognition run inside the Bun process with `onnxruntime-node` (loaded through Bun's Node-API support), `sharp` for decoding and a TypeScript alignment step, behind a `FaceEmbedder` interface. Rust was preferred initially, but `ort` is still a release candidate, a napi addon adds per-platform native builds that `onnxruntime-node` already ships prebuilt, and face work is milliseconds per Candidate (SFace and YuNet each ran in ~6 ms on CPU under Bun on macOS arm64) next to image API calls of 10–60 s. A Python sidecar would add a ~0.5–1 GB container only to reach InsightFace weights we don't use by default (ADR-0002). Revisit only if profiling shows face work as a hotspot; a Rust implementation can slot in behind the same interface.

## Consequences

- The native addons (`onnxruntime-node`, `sharp`, `libsql`) can't be embedded in a bundle or `bun build --compile` executable (oven-sh/bun#44063); they stay external and ship as the only `node_modules`.
- Container images must be glibc-based (Debian or distroless `cc`), not Alpine/musl; `onnxruntime-node` also needs `libstdc++`, which `oven/bun`'s distroless image lacks.
- `onnxruntime-web` (WASM) works under Bun at ~3–5× the latency and is the fallback if a platform's native binary fails.
