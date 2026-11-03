---
title: "The Judge uses direct AI SDK provider instances, not Mastra's model router"
status: accepted
date: 2026-11-03
---

# The Judge uses direct AI SDK provider instances, not Mastra's model router

The Judge stays a Mastra agent with structured output, but its model is an AI SDK language model built from the vendor's own provider package (`@ai-sdk/anthropic`, `@ai-sdk/openai` through the Responses API, `@ai-sdk/google`), not a Mastra model router id. Each provider gets the API key from our key lookup, the vendor's official API endpoint as an explicit base URL, and a `fetch` that turns off Bun's per-request idle timeout (`timeout: false`). The user-facing Judge id stays `vendor/model`, and only `anthropic`, `openai` and `google` are accepted.

Mastra 1.80's router config takes only an id, URL, key, headers and API kind, with no custom `fetch`. That forced two workarounds. First, Bun's fetch cuts off a request that is idle for 300 s, and a non-streaming medium- or high-effort Judge call can run as long as that or longer, so every entrypoint had to start Bun with `BUN_CONFIG_HTTP_IDLE_TIMEOUT` raised in the OS environment, and the Judge refused to start without it. Second, the router (and the providers it builds) send a vendor's calls to `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` or `GOOGLE_BASE_URL` when that variable is set, so the Judge refused Runs while its vendor's variable was set, or else the key and the Reference Photos would have gone there. A per-request `fetch` and an explicit base URL remove both workarounds, and the Judge no longer depends on how it was started or on the base-URL variables.

## Consequences

- Three direct dependencies, pinned in the root catalog (ADR-0010) to the versions Mastra 1.80 bundles for its router (AI SDK v6 providers, `LanguageModelV3`), so the requests are the same as the router's, apart from Mastra's `User-Agent` prefix. Upgrading Mastra or these providers is now two decisions instead of one.
- This departs from issue #8, which specified the Judge "via the model router". Image Models keep their native-SDK adapters (ADR-0004); this decision covers only the Judge's LLM calls.
- Supporting another Judge vendor means adding its provider package and endpoint, not just accepting a new router id.
