# Gemini Interactions API response fixtures

HTTP response bodies of `POST https://generativelanguage.googleapis.com/v1beta/interactions` for the
Gemini adapter tests (`gemini.test.ts`). Tests serve them through a fake `fetch`; no test calls Google
or needs an API key.

The shapes follow Google's documentation as of 2026-11-01: the Interactions API reference and OpenAPI
spec (`Interaction`, `Usage`, `ModalityTokens`, the `{ "error": { "code", "message" } }` error body),
the safety-settings guide (HTTP 400 with `error.code` `safety`) and Google's standard HTTP errors
(`429 RESOURCE_EXHAUSTED`, `503 UNAVAILABLE`, `400 INVALID_ARGUMENT` for a bad key). Those were
written from the documents. `error-content-blocked-400.json` was captured from the live walkthrough
on 2026-11-01 (`gemini-nano-banana-2.1`, v1beta, public-domain portraits of a public figure); no
live call has returned an image yet, so the success shape is still the documented one.

The fixtures written from the docs carry placeholders where a real response would hold
account-specific or personal content; the captured one needed nothing removed:

| File                             | Origin   | Placeholders                                                                                                                                                                                 |
| -------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `completed-image.json`           | docs     | Image `data`: a generated 16×16 plain orange JPEG (sharp `create`, quality 80, 268 bytes), not a generated face; interaction `id` `REDACTED_INTERACTION_ID`; thought `signature` `REDACTED`. |
| `completed-text-only.json`       | docs     | Interaction `id` `REDACTED_INTERACTION_ID`.                                                                                                                                                  |
| `error-safety-400.json`          | docs     | None: Google's documented example body.                                                                                                                                                      |
| `error-rate-limit-429.json`      | docs     | None.                                                                                                                                                                                        |
| `error-unavailable-503.json`     | docs     | None.                                                                                                                                                                                        |
| `error-invalid-key-400.json`     | docs     | None; such a body never contains the key.                                                                                                                                                    |
| `error-content-blocked-400.json` | captured | None needed: the body holds only `message` and `code` (no ids, no key).                                                                                                                      |

No response headers are recorded.
