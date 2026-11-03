# syntax=docker/dockerfile:1
# The server image (ADR-0009, ADR-0012): distroless glibc with `bun`, the server
# bundle and a production install of only its external packages, pruned to the
# target platform. No face-model weights: the server downloads and verifies them
# into the data volume on first start.

# Base images pinned by digest (multi-arch indexes); bump tag and digest together.
ARG BUN_IMAGE=oven/bun:1.4.2-debian@sha256:4f6e31d1a54d6a3dd312daef655fc998101b5043d52e12592ac293ef04b9bc73
ARG RUNTIME_IMAGE=gcr.io/distroless/cc-debian13:nonroot@sha256:08476c244888bfb425bae1ae4dd7c17f093e972aab8426883d97f3c6f280f7c1

# Bundling is platform-independent, so it runs on the build machine's platform and installs
# the externals for the target one (no emulation).
FROM --platform=$BUILDPLATFORM ${BUN_IMAGE} AS build
WORKDIR /src
COPY package.json bun.lock bunfig.toml ./
COPY packages/adapters/package.json packages/adapters/
COPY packages/domain/package.json packages/domain/
COPY packages/server/package.json packages/server/
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
  bun install --frozen-lockfile --ignore-scripts
COPY packages packages
COPY scripts scripts
# Declared here, so the install above is shared by every target platform.
ARG TARGETOS
ARG TARGETARCH
# npm names Docker's amd64 x64.
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
  cpu="$(if [ "$TARGETARCH" = amd64 ]; then echo x64; else echo "$TARGETARCH"; fi)" \
  && bun scripts/build-server.ts --os "$TARGETOS" --cpu "$cpu" --libc glibc --out /out \
  && mkdir /data

# The target platform's bun binary.
FROM ${BUN_IMAGE} AS bun

FROM ${RUNTIME_IMAGE}
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=build /out /app
LABEL org.opencontainers.image.source="https://github.com/stibbons-ai/iconograph" \
      org.opencontainers.image.licenses="MIT"
COPY --from=build --chown=nonroot:nonroot /data /data
WORKDIR /app
# Listening on every interface is needed inside the container's own network namespace for a
# published port to reach the server; the host-side exposure is the publish address
# (compose.yaml: 127.0.0.1 only, ADR-0012).
ENV ICONOGRAPH_HOST=0.0.0.0 \
    ICONOGRAPH_PORT=4111 \
    ICONOGRAPH_DATA_DIR=/data \
    MASTRA_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1 \
    NODE_ENV=production
USER nonroot
VOLUME /data
EXPOSE 4111
# The container's health check, also under compose; the start period covers the first start's
# face-model download. Distroless has no shell or curl, so the image's bun runs the check.
HEALTHCHECK --interval=30s --timeout=10s --start-period=5m --retries=3 \
  CMD ["/usr/local/bin/bun", "/app/healthcheck.js"]
ENTRYPOINT ["/usr/local/bin/bun", "/app/server.js"]
