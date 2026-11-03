---
title: "In a container the server binds every interface; the host publishes it on loopback only"
status: accepted
date: 2026-11-02
amends:
  - 0003-in-process-onnx-face-models.md
  - 0005-single-operator-local-first.md
  - 0009-bundle-with-external-native-addons.md
---

# In a container the server binds every interface; the host publishes it on loopback only

The server listens on `127.0.0.1` by default; `ICONOGRAPH_HOST` and `ICONOGRAPH_PORT` change that, and any non-loopback address logs a warning at boot that the server has no authentication. A loopback listener inside a container is unreachable through a published port, so the image sets `ICONOGRAPH_HOST=0.0.0.0` inside its own network namespace, and the shipped `compose.yaml` publishes the port as `127.0.0.1:4111:4111`. The host-side publish address, not the bind address, then decides who can reach the server.

This amends ADR-0005, where binding beyond loopback refuses to start without `ICONOGRAPH_PASSWORD`: the LAN password mode isn't built yet, so an explicit non-loopback bind starts with the warning instead. The server can't tell a container's wildcard bind from any other, so when the password mode lands it must decide what a non-loopback bind requires for both.

It also amends ADR-0009's image details and ADR-0003's list of externals: the final stage is `gcr.io/distroless/cc-debian13` (the current distroless release) and `libheif-js` is a fourth external beside the native addons (its LGPL WebAssembly decoder is loaded unmodified from its package at runtime). The measured image sizes are in the README ("Server and container").

## Consequences

- `docker run -p 4111:4111` (without `127.0.0.1:`) exposes the unauthenticated server, its Reference Photos and paid API keys to the network; the README says so next to the compose instructions.
- The server answers only requests whose `Host` is a loopback name or its configured address, so a web page can't reach it by rebinding its own DNS name to `127.0.0.1`. It also refuses requests whose `Origin` isn't the server as addressed or that browsers mark cross-site, and `/api` writes that aren't JSON, so a page on another site can't submit a form to it. Only the Mastra routes a Run needs are mounted.
- The `Origin` rule expects plain `http://` to the address the client used, so HTTPS or a reverse proxy in front fails it; the LAN mode work (ADR-0005) must revisit it.
- The generic `HOST`/`PORT` variables that shells and platforms set never change the bind; `compose.yaml` pins the `ICONOGRAPH_*` settings over `.env`.
