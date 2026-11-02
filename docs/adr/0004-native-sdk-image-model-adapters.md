---
title: "Image Models use our own interface with native-SDK adapters, not the AI SDK"
status: accepted
date: 2026-10-30
---

# Image Models use our own interface with native-SDK adapters, not the AI SDK

Each Image Model is an adapter behind our own `ImageModel` Effect service (generate from Prompt + Reference Photos, report usage and cost, declare capabilities such as max character references, sizes, quality). Adapters call the vendor's native API (Gemini Interactions API, OpenAI `images.edit`; later ComfyUI, BFL, Seedream). The AI SDK's `generateImage` supports reference-image editing, but drops Gemini `image_size` and quality controls and OpenAI's newer quality levels, and hides `store=false`; those knobs matter for identity fidelity, cost and privacy.

## Consequences

- Every call returns at most one image, for every adapter: Gemini has no `n`, and the OpenAI adapter (#7) calls with `n=1`. N Candidates are N calls, so the Budget reserves per Candidate and each billable call has one cost record (decided 2026-11-02, review finding R1-7 of #6). A model's `n` is therefore not a capability.
