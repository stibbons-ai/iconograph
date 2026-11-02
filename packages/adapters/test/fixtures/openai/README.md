# OpenAI Images API response fixtures

HTTP response bodies of `POST https://api.openai.com/v1/images/edits` for the OpenAI adapter tests
(`openai.test.ts`). Tests serve them through a fake `fetch`; no test calls OpenAI or needs an API
key.

All were written from OpenAI's documentation as of 2026-11-02, none captured live: the Images API
reference for `POST /v1/images/edits` (the `ImagesResponse` with `data[].b64_json`,
`output_format`, `quality`, `size` and `usage`), the image generation guide (a moderation block is
an error with `type` `image_generation_user_error`, `code` `moderation_blocked` and optional
`moderation_details`) and the error codes guide (429 rate limit and `insufficient_quota`, 500, 503
`server_is_overloaded`, 401 `invalid_api_key`), in OpenAI's usual
`{ "error": { "message", "type", "param", "code" } }` body. The message texts paraphrase the
guide's descriptions; the token counts in `image-with-usage.json` are illustrative (1756 output
tokens is the guide calculator's figure for a high-quality 1024x1024 image).

Placeholders replace anything account-specific or personal:

| File                                | Placeholders                                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `image-with-usage.json`             | Image `b64_json`: the 16×16 plain orange JPEG of the Gemini fixtures (sharp `create`, quality 80, 268 bytes), no face. |
| `image-without-usage.json`          | The same image; no `usage`, as the API reference allows.                                                               |
| `error-moderation-blocked-400.json` | Request id `req_REDACTED`.                                                                                             |
| `error-rate-limit-429.json`         | Organization id `org-REDACTED`.                                                                                        |
| `error-insufficient-quota-429.json` | None.                                                                                                                  |
| `error-server-500.json`             | None.                                                                                                                  |
| `error-overloaded-503.json`         | None.                                                                                                                  |
| `error-invalid-key-401.json`        | The masked key OpenAI echoes is a made-up `sk-test-****WXYZ`, never a real key's ends.                                 |

No response headers are recorded.
