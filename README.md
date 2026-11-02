# Iconograph

A Bun workspace for the headless Run loop: validate the Subject's Reference Photos with a local face
pipeline, generate Candidates with an Image Model inside a hard Budget, and score their Likeness.
Milestone 0 runs one Gemini Lane for one Iteration from the command line; there is no UI or
production deployment yet.

## Requirements and installation

Install **Nix**, **devenv**, and **direnv** with its shell hook enabled. From the repository root,
authorize the committed `.envrc`:

```sh
direnv allow
```

Alternatively, enter the same environment explicitly with `devenv shell` (without direnv).
The development shell supplies **Bun 1.4.2** (matching the `packageManager` pin) and **Git**,
and exports `MASTRA_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1` for tools and their child processes.
No separate Node installation is required: this workspace runs its TypeScript directly with Bun.
The committed `bunfig.toml` sets `[run] bun = true` so package-script executables use Bun even
when their shebang requests Node; keep workspace script execution Bun-only.

Before shell entry, tasks run `bun install --frozen-lockfile`, then `bun run hooks:install`.
Direct dependency constraints live in the root catalog; `bun.lock` records resolved versions.
Hook setup activates the committed `.githooks/pre-commit` via repository-local
`core.hooksPath=.githooks`; it does not change global Git configuration. It is safe to rerun,
but refuses a conflicting hooks path or existing executable nonsample files in the default hooks directory rather
than replacing or bypassing your hooks. Integrate those hooks manually before retrying.
A failed setup task does **not** guarantee that devenv refuses to open the shell: inspect task
output and resolve installation or hook failures before running workspace commands.
To set up or retry manually (also required when working outside devenv):

```sh
bun install --frozen-lockfile
bun run hooks:install
```

The shell setup intentionally does not reuse the reference project's Astro, Playwright/browser
downloads, application-server hooks, or Nixpacks configuration.

The initial install encountered a workstation-global 259,200-second minimum release age: the npm
registry's current `@mastra/core@1.80.0`, `@mastra/libsql@1.27.1` and `effect@4.1.1` were too recent
for that local policy. The explicitly reviewed initial install used
`MASTRA_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 bun install --minimum-release-age 0`. The repository does
**not** disable release-age protections globally. Prefer the committed frozen lockfile; if a local
policy still rejects these exact pins, wait for the release age or make an explicit, reviewed
one-command exception rather than weakening shared configuration.

## Commands

The development shell supplies both telemetry opt-out variables to tooling through environment
inheritance. Root runtime scripts (`run`, `photos:validate`, `prices`, …) and `test`, and package
runtime entrypoints, retain explicit `MASTRA_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1` prefixes so they
remain safe outside the shell. Formatting, linting, typechecking, licence auditing, and ADR
validation use plain commands; `check` composes the scripts and finishes with `bun run test`.
Outside the shell, set both variables when invoking Bun or Mastra directly instead of the scripts.

```sh
# Start a Run (see "Runs" below); needs GEMINI_API_KEY.
bun run run --budget 0.50 me-1.jpg me-2.jpg me-3.jpg

# Print a stored Run again from the database.
bun run run read --run-id RUN_ID

bun run test
bun run format        # write formatting in the authored workspace scope
bun run format:check
bun run lint
bun run typecheck
bun run licenses
bun run adrs:check    # validate every ADR in the worktree
bun run hooks:install
bun run check         # format → lint → typecheck → licences → ADRs → tests
```

CLI success is JSON on stdout; failures are JSON on stderr and exit nonzero.

CI is independent of Nix, devenv, and direnv: it installs Bun directly and explicitly sets
`MASTRA_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1` for all steps. It uses a frozen install, fetches the
locked face-model weights (cached by the lock file's hash), explicitly runs `bun test`, and runs the
complete `bun run check` on Linux and macOS. Native optional
dependencies are therefore audited on both hosts. Formatting commands include the adopted
`docs/adr` collection, including its template README, but exclude unrelated domain drafts.

### Model weights

The default face backend (YuNet detector, MIT; SFace recognizer, Apache-2.0) needs ONNX weights
that are never committed or baked into an image. They live in the data volume's models folder,
`<data dir>/models`, where the data dir is `ICONOGRAPH_DATA_DIR` (default `./.data`, gitignored).
[`packages/adapters/models.lock.json`](packages/adapters/models.lock.json) pins each downloaded
file to an immutable Hugging Face revision URL, SHA-256, size, and licence. InsightFace weights
(`buffalo_l`, non-commercial) are never fetched automatically: the lock admits only MIT or
Apache-2.0 entries, rejects known InsightFace pack and file names (`buffalo`, `antelope`, `scrfd`,
`w600k`, …), and a test pins the shipped lock to exactly YuNet, SFace and the held-out FaceNet.

```sh
bun run models:fetch                      # fetch and verify every downloadable locked model now
bun run models:fetch --data-dir /srv/data # or ICONOGRAPH_DATA_DIR=/srv/data
bun run models:export-facenet             # build the held-out FaceNet model (needs uv, see below)
```

Weights are otherwise downloaded on first use. Missing files stream into a temp file beside the
destination, are hashed, and are renamed into place only after the SHA-256 matches; present files
are re-hashed on every use and never downloaded again once verified. **Offline machines**: copy the
locked files (same names) into `<data dir>/models` by any means; they are verified like downloads.
**A checksum mismatch** is a hard error naming the model, path, expected and actual hash, and the
file is never used. A corrupt present file is left in place: delete it and rerun `models:fetch`.

**The held-out FaceNet model is built, never downloaded** (ADR-0011): how its training data's
terms (VGGFace2) reach trained weights is unsettled, so we choose not to redistribute it.
`models:export-facenet` runs [`scripts/export-facenet.py`](scripts/export-facenet.py) with
[uv](https://docs.astral.sh/uv/), which installs the script's pinned Python 3.12, PyTorch
(CPU-only on Linux x64) and facenet-pytorch on first run, downloads the upstream facenet-pytorch
weights (112 MB, verified by the SHA-256 in the lock entry's `build.source`), exports them to
ONNX, checks ONNX Runtime against PyTorch on fixed inputs, and installs
`<data dir>/models/facenet_inception_resnet_v1_vggface2.onnx` (94 MB) only if its SHA-256 matches
the lock. The Python packages download about 110 MB on macOS arm64 (about 540 MB installed) and
about 280 MB on Linux x64 (about 1.8 GB in uv's cache), measured 2026-11-01. The export is
byte-identical on macOS arm64 and Linux x64/arm64, which is what makes that hash pinnable.
`models:fetch` skips FaceNet; anything that needs it fails with the build command while it is
missing, and with a SHA-256 error if the file was changed; `models:export-facenet` rebuilds a
changed file.

### Model prices

The Budget needs a price for every model a Run uses, so prices are looked up, never hard-coded,
in this order:

1. **Manual override**, set per model with the command below.
2. **LiteLLM's public price data**
   ([`model_prices_and_context_window.json`](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json)
   on `main`), cached with its fetch time in `<data dir>/prices.db`. The `prices` command refreshes
   it when 24 h old (or dated in the future); the price source's `ensureFresh` is meant to run at
   server boot and daily. A failed refresh keeps serving the old cache with its age, marked `stale`
   once it is 24 h old or dated in the future. An unrelated entry whose price fields are malformed
   is dropped (that model is unpriced) and listed in `refresh.rejected`. A malformed entry for a
   default model, a response that isn't JSON, or one that prices no model fails the refresh and
   leaves the cache untouched.
3. **Bundled snapshot**,
   [`packages/adapters/litellm-prices.snapshot.json`](packages/adapters/litellm-prices.snapshot.json),
   used only offline before the first successful fetch. It never fills gaps in a fetched cache.
   `bun run prices:snapshot` regenerates it from LiteLLM's latest commit, recording that commit.

A model with no price is refused with an `Unpriced` error, so a Run can't start unpriced. Default
models map to LiteLLM keys explicitly (Gemini uses LiteLLM's Gemini API entry,
`gemini/gemini-nano-banana-2.1`); any other model id is looked up as an LLM under its own id, and
is unpriced if its entry carries image prices. Image prices: Gemini per image, per image token and
per text/thinking output token, with the 2K price derived from the 1680 image tokens
[Google lists](https://ai.google.dev/gemini-api/docs/pricing#gemini-nano-banana-2.1) for a 2K image;
OpenAI image models per input and output image token; LLMs per input and output token. Only
standard rates are read; cache, batch and long-context tiers are ignored. Vendors may discount
cached input automatically, so prices are upper bounds; batch calls and contexts over 200k tokens
are assumed unused.

```sh
bun run prices claude-sonnet-5-5           # price, source (override|litellm|snapshot) and age as JSON
bun run prices claude-sonnet-5-5 --refresh # fetch LiteLLM's data now; a failure is an error
bun run prices local-judge --set-override '{"input_cost_per_token":0,"output_cost_per_token":0}'
bun run prices local-judge --clear-override
```

Overrides use LiteLLM's field names in USD and must include every field the model's pricing mode
needs. All forms accept `--data-dir PATH` (or `ICONOGRAPH_DATA_DIR`). An implicit refresh that
fails to fetch or validate is reported in the output's `refresh.error` and the lookup still answers
from the old cache or the snapshot; if the lookup then fails, its error report includes that
`refresh`.

### Reference Photos

`photos:validate` checks 1 to 8 Reference Photos of one Subject the way a Run's prepare step will,
using the locked face models (fetched on first use, see Model weights above):

```sh
bun run photos:validate me-1.jpg me-2.heic me-3.png               # data dir as for models:fetch
bun run photos:validate --face 2:1 me-1.jpg team-photo.jpg me-3.png # photo 2: use face 1
```

- **Formats:** JPEG, PNG and HEIC (AVIF and other formats are rejected). Every file is fully decoded,
  not just sniffed. A truncated or unsupported file, one over 50 MiB, or an image over 50 megapixels
  (checked from its header before decoding) is an error naming the photo, and so is corrupt JPEG or
  PNG data (including JPEG "corrupt data" warnings). **HEIC corruption detection is best-effort:** a
  damaged or truncated HEIC container is rejected, but the HEVC decoder (libde265) conceals errors
  inside the image data and returns a damaged picture without any error, even with libheif's strict
  mode; such a photo is judged on its damaged pixels. 50 MP admits 48 MP phone captures (recent
  iPhones in HEIC); larger photos, such as some Android phones' 50–200 MP modes, must be downscaled
  first. A JPEG or PNG at the cap decodes to about 150 MB of RGB; a HEIC peaks higher, at about
  200 MB of RGBA in the decoder's WebAssembly heap (which never shrinks), a 200 MB copy and the
  150 MB RGB. The same file given twice is an error, and so is a photo with a usable face whose
  pixels repeat an earlier one: a duplicate would count twice. HEIC is decoded in software with
  `libheif-js` (libheif + libde265, LGPL-3.0) before `sharp`, whose prebuilt libvips has no HEVC
  decoder. HEVC is patent-encumbered in some countries; self-hosters who need certainty should check
  whether decoding HEVC needs a licence where they are. EXIF orientation is applied before face
  detection; transparency is flattened onto white.
- **Report** (one JSON object on stdout; photos and faces are numbered from 1, faces highest score
  first): per photo, `accepted` (with its face box and score, its similarity to the other accepted
  photos and the stored file), `rejected` with `no-face`, `choice-required` with every detected face
  (box and score; rerun with `--face PHOTO:FACE`), or `flagged` as `not-the-same-person` with its
  similarity. Every similarity states its basis in `similarityTo`: `accepted-anchor` (the Identity
  Anchor of the other accepted photos) or `best-photo` (the best match to any one other photo, used
  only when nothing was accepted); an accepted photo that is the only one has `similarity` and
  `similarityTo` `null`. Then the Identity Anchor (the 128-d normalised mean SFace embedding of the
  accepted photos), the Identity Ceiling (median pairwise similarity of the accepted photos, or
  SFace's single-photo default) and `warnings`, each `{ code, message }`: `few-photos` (fewer than 3
  accepted), `none-accepted`, or `ceiling-below-gate` (every photo passed against the others, but
  they barely agree with each other; the Ceiling is reported as measured, not clamped). Programs
  branch on `code`; `message` is for people and may change. Errors print JSON to stderr and exit
  nonzero, with `photo` when the error is about one photo (including a face-model failure while
  processing it); a HEIC decoder that fails to load is reported as such, not as a bad photo.
  Warnings from the run itself also go to stderr as JSON.
- **"Not the same person"** is judged against the others: each photo's cosine similarity to the
  Identity Anchor of the _other_ accepted photos, compared with the SFace Identity Gate (0.40,
  ADR-0008). The lowest photo below the Gate is flagged and left out, and the rest are rechecked,
  so one outlier can't drag genuine photos below the Gate or pull the anchor towards itself. A
  flagged photo that reaches the Gate once later outliers are out is re-admitted (once). If only two
  photos remain and they disagree, both are flagged; if that leaves nothing accepted, the most
  similar flagged pair that reaches the Gate is re-admitted. Reported similarities are against the
  final anchor of the _other_ accepted photos; when none is accepted, each flagged photo reports its
  best similarity to any one other photo (always below the Gate, since no pair reached it).
  Flagged photos are excluded from the anchor and ceiling; remove them, or replace them with better
  photos of the Subject.
- **Privacy:** `photos:validate` never sends photos anywhere. Accepted photos are re-encoded from
  decoded pixels (JPEG, quality 95) into `<data dir>/images/<sha256>.jpg`, so no EXIF, GPS, XMP,
  IPTC or ICC metadata from the upload is stored. Rejected, flagged and choice-required photos are
  not stored. A Run sends only these stripped copies of its character references (see Runs).

Thresholds live in one per-model config (`sfaceConfig` in
[`packages/adapters/src/face-embedder.ts`](packages/adapters/src/face-embedder.ts)); the Identity
Gate and the single-photo Ceiling (0.60) are provisional until calibrated on real pairs in
Milestone 0 (issue #1). The
face tests use only licence-clear fixtures, listed in
[`packages/adapters/test/fixtures/faces/README.md`](packages/adapters/test/fixtures/faces/README.md),
and need the real weights: run `bun run models:fetch` and `bun run models:export-facenet` first (CI
caches both); missing weights fail the tests with those commands rather than skipping them.

### Held-out face model

The Optimizer loop scores Likeness with SFace and drifts towards whatever that model rewards, so a
finalist is also scored with a second face model the loop never sees (ADR-0008): FaceNet
(Inception-ResNet-v1 trained on VGGFace2, built locally as above). A high Likeness that FaceNet
does not confirm is "Likeness Unconfirmed". `faces:heldout` scores one Candidate image against 1 to
8 Reference Photos of the Subject:

```sh
bun run faces:heldout candidate.png me-1.jpg me-2.heic me-3.png    # data dir as for models:fetch
bun run faces:heldout --candidate-face 2 --face 3:1 group.png me-1.jpg me-2.heic team-photo.jpg
```

Photos are decoded and checked as by `photos:validate` (formats, limits, the same file twice; also
the Candidate given again as a Reference Photo, and any two images with identical pixels) and
nothing is stored. Faces come from the same YuNet detector; each image needs exactly one face, or a
chosen one (`--candidate-face FACE`, `--face PHOTO:FACE` numbered as given, from 1), otherwise the
error lists the faces to choose from. FaceNet gets a square margin crop, not SFace's five-point
alignment: a square around the detection box, its side the box's longer side plus a margin of 32 of
the 160 output pixels (facenet-pytorch's MTCNN convention), padded black where it extends past the
image, resized to 160×160 and normalised as (x − 127.5) / 128. The JSON report gives the model, the
threshold, the Candidate's face and its cosine similarity to each Reference Photo, its similarity
to the held-out anchor (the normalised mean of the reference embeddings) and `pass` when that
reaches the threshold. The threshold (0.70, ADR-0008, to be recalibrated on real pairs) lives in
`facenetConfig` in
[`packages/adapters/src/held-out-embedder.ts`](packages/adapters/src/held-out-embedder.ts).

**Never used by the Optimizer loop:** the held-out embedder is its own service
(`HeldOutFaceEmbedder`, not a `FaceEmbedder`) and is not exported from `@iconograph/adapters`,
whose `exports` field exposes only its index, so the server and its run workflow cannot import or
provide it; `packages/server/test/held-out-isolation.test.ts` checks this.

### Runs

`bun run run` starts a Run: it validates the Reference Photos (as `photos:validate` does), generates
one Iteration of Candidates in one Gemini Lane (`gemini-nano-banana-2.1`), scores each Candidate's
Likeness and prints the results with their costs.

```sh
GEMINI_API_KEY="op://Freelancing/Gemini test run key/password" \
  op run --account my.1password.com -- \
  bun run run --budget 0.50 --candidates 3 --look look.json --pin 2 me-1.jpg me-2.heic me-3.jpg
```

`op run` resolves the 1Password reference into the environment of that one process, so the key is
never written to disk; any other way of setting `GEMINI_API_KEY` works too. The key is read only
from the environment and sent only in the request header; it never enters the database, the output
or an error. A key shorter than 20 characters or with spaces, control or non-ASCII characters (a
bad paste) is rejected before any call, without echoing it.

- **Arguments:** 1 to 8 Reference Photos; `--budget USD` (default 5), `--candidates N` (1 to 8,
  default 3), `--look FILE`, `--pin PHOTO` (repeatable), `--face PHOTO:FACE` (as for
  `photos:validate`), `--data-dir PATH` and `--db PATH` (default `./iconograph.db`, whose directory
  must exist). `bun run run read --run-id ID` prints a stored Run's report again; it refuses a
  `--db` file that doesn't exist.
- **Target Look:** a JSON file with any of the facets `pose`, `background`, `lighting` (lighting
  and colour), `hairstyle`, `clothing` and `framing`, each a text of up to 500 characters, e.g.
  `{"background": "dark navy backdrop", "clothing": "grey suit"}`. Missing facets take defaults (a
  neutral corporate headshot); `hairstyle` defaults to "as in the Reference Photos". Unknown facets
  are rejected, and so is text with leading or trailing spaces. The look is frozen with the Run, and
  the first Prompt is built from it.
- **Character references:** Gemini keeps a character's identity from at most 4 reference images,
  chosen from the accepted photos: pinned photos first (more than 4 pins is an error); without pins
  the first pick is the largest, most frontal face (frontality × √area); each further pick is the
  photo farthest in face embedding from those already chosen, so near-duplicates lose to different
  angles or light. Only these photos, as the stripped stored copies (downscaled to 2048 px on the
  longest side when larger), and the Prompt are sent to Google.
- **Gemini:** the native Interactions API (`v1beta`, `Api-Revision: 2026-05-20`; v1 rejects image
  input), one inline 2K JPEG per call, `store=false`, so Google doesn't keep the interaction for
  later retrieval (stored interactions are otherwise retained 55 days on the paid tier); Google's
  own abuse monitoring and terms still apply, and every generated image carries a SynthID
  watermark. Every call returns at most one image (ADR-0004), so N Candidates are N parallel calls.
  A policy block (`safety`, `jailbreak`, `prohibited_content`, `blocklist`, or `content_blocked`,
  which Google returned live for photos of a public figure) and a text-only answer are Refused with
  Google's reason and not retried; 408, 429 and 5xx responses and network failures are retried with
  exponential backoff (1 s, 2 s) up to twice, then Failed; other errors, and a response without a
  usable image, are Failed at once.
- **Budget:** every billable call, retries included, is checked against the remaining Budget
  (Budget − actual cost so far − estimates of calls in flight) before it is made. All N first calls
  are reserved in order before any is launched, so parallel calls can't overspend; a call that
  doesn't fit isn't made and the Lane stops with `budget-exhausted`. The estimate assumes 1120
  input tokens per reference plus the Prompt (about 3 characters per token), the 2K image price
  and 4000 tokens of text and thinking; the actual cost comes from the response's usage at the
  price recorded for the Lane when the Run started (stdout shows its source, age and whether the
  LiteLLM data was stale). Every HTTP error status is booked at $0 (Google's billing page: failed
  400 and 500 requests aren't charged); a response without complete usage data (input, output and
  thought totals, an output split by modality that adds up, and an image-token count whenever the
  response holds an image), or a call interrupted mid-flight, counts at its estimate. A
  reservation is booked at $0 when the engine knows its call wasn't sent; otherwise a call whose
  result couldn't be recorded stays unsettled (`settled: false`) and counts at its estimate,
  usually with a `{"warning": …}` line on stderr naming the Run, Lane, Iteration and Candidate.
  A process killed mid-call leaves the call unsettled without a warning; `read` still shows it.
  A call can cost more than its estimate, so the actual total can exceed the Budget by at most
  that difference on calls already in flight. A Run with an unpriced model doesn't start. The
  Budget is in whole micro-dollars: at most 6 decimals, from $0.000001 to $1,000,000.
- **Output:** first, before any Candidate is generated, one JSON line on stderr with the estimated
  cost (`{"event":"estimate", …}`). Then one JSON object on stdout: per Candidate its Outcome —
  `Refused` or `Failed` with a reason, `Gated` (`no-face` or `below-gate`, with the best face's
  similarity) or `Scored` with its Likeness (similarity to the Identity Anchor scaled linearly from
  the Gate, 0, to the Identity Ceiling, 10, and clamped; with a Ceiling at or below the Gate,
  anything at the Gate scores 10) — its stored image path and SHA-256, and its estimated and actual
  cost per call; the Lane's stop reason (`budget-exhausted` or `iteration-limit`); totals over
  every billable call of the Run and the remaining Budget; the Reference Photo warnings. `actualUsd`
  counts calls of unknown cost (`unknownCostCalls`) as $0, while the remaining Budget counts them at
  their estimate, so `budgetUsd − actualUsd` can exceed `remainingUsd`. Calls whose Candidate was
  never saved (the Run failed mid-way) are listed in `unattributedCalls` and still counted. With
  several faces in a Candidate, the best match to the Identity Anchor counts. A Run that fails after
  it started prints its `runId` in the stderr error, so `read` can show what it spent.
- **Storage:** Candidates are content-addressed files in `<data dir>/images` (JPEG or PNG; other
  types fail the Candidate). The `--db` file holds Mastra's workflow snapshots (no image data or
  embeddings; the Run request is the workflow input) and the tables `runs` (request with the frozen
  Target Look and Budget, and the photo report with the Identity Anchor and Ceiling), `lanes`, `iterations`
  (Prompts), `candidates` and `cost_records` (estimated and actual cost and usage per billable call),
  all keyed by Run, Lane, Iteration and Candidate.

### ADR validation and commits

[`docs/adr/README.md`](docs/adr/README.md) defines the required frontmatter and reusable template.
The pre-commit hook validates added, copied, modified, or renamed ADRs from the **Git index**,
not your unstaged edits. Stage a corrected ADR before retrying a rejected commit; conversely,
an invalid unstaged edit does not block a valid staged version. Deleted ADRs and the template
README are exempt, and references resolve against the staged ADR inventory. The hook runs
from the repository root even when you commit from a subdirectory.

`bun run adrs:check` validates the entire working-tree collection, and root `bun run check`
runs it in CI regardless of local hook installation. Ordinary local hooks can be bypassed
(for example, `git commit --no-verify`); they are an early feedback mechanism, not a security
boundary or a replacement for the full CI check.

## Architecture and schema authority

| Package                | Responsibility                                                                                                                                                                                                                             | Dependencies at the boundary                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `@iconograph/domain`   | Pure Run schemas; Target Look and Prompt; `FaceEmbedder` and `ImageModels` seams; Identity Anchor/Ceiling, photo verdicts, Likeness and Candidate Outcomes; character-reference choice; Budget arithmetic; price precedence and `Unpriced` | Effect only; no Mastra, storage, or infrastructure                                         |
| `@iconograph/adapters` | Effect-to-Mastra schema helper; LibSQL storage and Run tables; model weights; YuNet/SFace via ONNX; Reference Photo decoding and storage; content-addressed images; LiteLLM price source; Gemini Interactions adapter                      | Effect, Mastra core and LibSQL adapter, libsql client, onnxruntime-node, sharp, libheif-js |
| `@iconograph/server`   | Run workflow (prepare → Lanes → finish; a Lane generates and scores one Iteration) and the Run CLI                                                                                                                                         | Domain and adapters; Mastra owns durable execution                                         |

**Effect Schema is the single schema source.** Mastra is the single durable workflow engine; LibSQL
stores its snapshots. Zod exists transitively in Mastra's dependency graph but is not an independent
domain validator. Workflow boundaries decode untrusted input and step output explicitly with Effect,
so invalid values produce Effect validation details rather than silently bypassing schema rules.

### Current API compatibility

The installed pins are `effect@4.1.1`, `@mastra/core@1.80.0`, and `@mastra/libsql@1.27.1` (not a
historical Mastra API or an Effect 3 compatibility layer). In Effect 4.1.1,
`Schema.toStandardSchemaV1` and `Schema.toStandardJSONSchemaV1` return wrappers/clones; they do not
mutate the source schema. The adapter composes both capabilities and caches one composed wrapper
per schema. Historical ADR text describing mutation is not an accurate description of this
installed release and is intentionally not edited as part of the workspace cutover.

Standalone Oxlint/Oxfmt are the M0 tools, not a claim that Vite+ is incompatible with Bun. An isolated
Vite+ 1.4.0 probe under Bun 1.4.2 successfully exercised actual development responses, built artifacts,
checks (including intentional type/lint failures), and a behavior test. The commands checked were
`bunx --bun vp dev`, `bunx --bun vp build`, and `bunx --bun vp check`; strict lint failure required
`--deny-warnings`. This small application probe does not establish compatibility for every plugin,
OS, or workspace configuration.

## Telemetry and licensing policy

No application telemetry is intentionally enabled. The development shell and CI explicitly set
`MASTRA_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1`; standalone runtime and test scripts retain both flags
as well. Tooling inherits the shell or CI environment rather than repeating the flags in every
script. Transitive telemetry libraries can still be present in the dependency graph; their
presence is not evidence of a telemetry request. Outbound requests: locked model weights,
LiteLLM's price file, and, during a Run, the Gemini Interactions API with the Prompt and the chosen
character references. Tests never call a paid vendor API. The maintainer-run
`bun run prices:snapshot` also queries `api.github.com` for LiteLLM's latest commit.

`bun run licenses` reads actual installed package manifests across the full runtime **and**
development graph, including nested installs, scopes, symlinks, and Bun's isolated `.bun` store.
It also checks the committed lockfile so a missing host-compatible package cannot turn into a
successful partial audit. Packages omitted because of another OS/CPU are audited offline using
reviewed entries in `scripts/platform-license-metadata.json`; so are packages that only such
omitted packages depend on (for example `sharp`'s WebAssembly fallback). Each entry records the exact package
name and version, full registry licence string, integrity from `bun.lock`, and exact public npm
version URL. Missing, malformed or duplicate metadata and integrity mismatches fail closed.
Installed packages are always audited from their actual manifests, not the metadata snapshot.

When updating dependencies, review the registry licence metadata and upstream terms for **every**
lock entry with an OS/CPU constraint, including packages installed on your current host. Update the
committed snapshot with each exact version's licence and npm URL and its lockfile integrity; remove
obsolete entries. This complete snapshot covers omissions on every CI host without online fetches
or a Windows runner. Metadata is evidence, not an exception: omitted dependencies must satisfy the
same SPDX policy and exact allowlist below. Never copy a permissive licence from a sibling package
or carry metadata forward to a new version without review.

The default reviewed SPDX set is MIT, Apache-2.0, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, CC0-1.0,
Unlicense and BlueOak-1.0.0. A real SPDX expression parser respects parentheses and operator
precedence: `OR` needs one compliant licence choice; `AND` needs every obligation to comply.
Copyleft (including GPL, AGPL, LGPL and MPL), noncommercial/source-available terms, unreviewed
exceptions, unknown SPDX identifiers, and absent/non-string metadata fail closed unless an exact
reviewed exception applies. `WITH` exceptions and `+` suffixes are not approved implicitly.

Exceptions live in `scripts/license-allowlist.json` and require an exact package name, exact version,
full licence string, and a substantive review reason. Wildcard/range versions, empty reasons and
duplicate exceptions are rejected. Updating a dependency does not inherit an old exception. The
current exceptions are `spdx-exceptions@2.5.0`'s CC-BY-3.0 SPDX identifier data; the prebuilt
LGPL-3.0-or-later libvips binaries that `sharp` loads as unmodified, separately installed shared
libraries (`@img/sharp-libvips-*`); `sharp`'s Windows and WebAssembly builds, which bundle libvips
and are locked only as optional platform builds, never installed on the supported Linux and macOS
hosts; and the LGPL-3.0 `libheif-js@1.23.5` WebAssembly HEIC decoder, loaded unmodified from its own package,
with attribution in [`THIRD_PARTY_NOTICES`](THIRD_PARTY_NOTICES). Do not add an exception merely to make CI pass: inspect
the installed licence text and upstream terms first, and retain required notices on redistribution.

Mastra's package-level Apache-2.0 metadata explicitly excludes **every `ee/` directory**. Oxlint's
`no-restricted-imports` blocks enterprise roots and deep/relative `ee` segments in static imports,
re-exports, type imports and string-literal dynamic imports. This rule does not resolve computed
module names or CommonJS `require` calls; the workspace uses ES modules, and enterprise imports
must not be disguised through runtime loading. The domain lint boundary additionally rejects
Mastra, LibSQL, Node and infrastructure-package imports; its manifest declares Effect only.
