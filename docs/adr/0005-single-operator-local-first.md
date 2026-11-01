---
title: "Single operator, local-first, no telemetry"
status: accepted
date: 2026-10-30
---

# Single operator, local-first, no telemetry

Iconograph serves one operator on their own machine or LAN: no user accounts, listening on `127.0.0.1` by default. For phone access there is an opt-in LAN mode (`HOST=0.0.0.0`) that refuses to start unless `ICONOGRAPH_PASSWORD` is set; it is one shared password with a session cookie, not multi-user auth, and HTTPS or Tailscale in front is recommended. State lives in data volumes (SQLite file, content-addressed image files, downloaded model weights). Reference Photos leave the machine only to the Image Models and Judge the operator configured; there is no telemetry (`MASTRA_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`), no CDN or font requests, Gemini calls send `store=false`, EXIF/GPS is stripped on upload, and API keys never enter the database.

## Considered Options

Binding to the LAN without a password was rejected: Reference Photos and paid API keys would be exposed to anyone on the network.
