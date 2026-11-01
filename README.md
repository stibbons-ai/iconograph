# Iconograph

A Bun workspace proving a persistent, model-free **Run** workflow before image-product work, plus the
local face pipeline that validates Reference Photos. There are no provider credentials, vendor model
calls, UI, or production deployment in this milestone.

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
inheritance. Root `run`, `eval`, and `test` scripts, and package runtime entrypoints, retain explicit
`MASTRA_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1` prefixes so they remain safe outside the shell.
Formatting, linting, typechecking, licence auditing, and ADR validation use plain commands;
`check` composes the scripts and finishes with `bun run test`. Outside the shell, set both variables
when invoking Bun or Mastra directly instead of the runtime/evaluation/test scripts.

```sh
# Validate, execute, and persist one Run in a local SQLite-compatible file.
bun run run --db ./iconograph.db --input '{"message":"hello"}'

# Inspect the same persisted run from a separate CLI invocation.
# Replace RUN_ID with the runId from the first command's JSON output.
bun run run read --db ./iconograph.db --run-id RUN_ID

# Exercise four real, persisted tracer fixtures without model access.
bun run eval

# Optional: retain the evaluation database at a chosen path.
bun run eval --db ./evaluation.db

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

The database's parent directory must already exist. The default Run database is `./iconograph.db`;
local database files and their WAL/shared-memory companions are gitignored. Without `--db`, the
evaluation harness uses an isolated temporary database and removes it afterwards. CLI success is
JSON on stdout; failures are JSON on stderr and exit nonzero. The tracer returns the message and
its JavaScript string length (**UTF-16 code units**, not Unicode graphemes).

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
[`packages/adapters/models.lock.json`](packages/adapters/models.lock.json) pins each file to an
immutable Hugging Face revision URL, SHA-256, size, and licence. InsightFace weights (`buffalo_l`,
non-commercial) are never fetched automatically: the lock admits only MIT or Apache-2.0 entries,
rejects known InsightFace pack and file names (`buffalo`, `antelope`, `scrfd`, `w600k`, …), and a
test pins the shipped lock to exactly YuNet and SFace.

```sh
bun run models:fetch                      # fetch and verify every locked model now
bun run models:fetch --data-dir /srv/data # or ICONOGRAPH_DATA_DIR=/srv/data
```

Weights are otherwise downloaded on first use. Missing files stream into a temp file beside the
destination, are hashed, and are renamed into place only after the SHA-256 matches; present files
are re-hashed on every use and never downloaded again once verified. **Offline machines**: copy the
locked files (same names) into `<data dir>/models` by any means; they are verified like downloads.
**A checksum mismatch** is a hard error naming the model, path, expected and actual hash, and the
file is never used. A corrupt present file is left in place: delete it and rerun `models:fetch`.

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
  photos, `null` when it is the only one, and the stored file), `rejected` with `no-face`,
  `choice-required` with every detected face (box and score; rerun with `--face PHOTO:FACE`), or
  `flagged` as `not-the-same-person` with its similarity. Then the Identity Anchor (the 128-d
  normalised mean SFace embedding of the accepted photos), the Identity Ceiling (median pairwise
  similarity of the accepted photos, or SFace's single-photo default) and warnings: fewer than 3
  accepted photos, nothing accepted, or a Ceiling below the Gate (every photo passed against the
  others, but they barely agree with each other; the Ceiling is reported as measured, not clamped).
  Errors print JSON to stderr and exit nonzero, with `photo` when the error is about one photo
  (including a face-model failure while processing it); a HEIC decoder that fails to load is
  reported as such, not as a bad photo. Warnings from the run itself also go to stderr as JSON.
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
- **Privacy:** photos never leave the machine. Accepted photos are re-encoded from decoded pixels
  (JPEG, quality 95) into `<data dir>/images/<sha256>.jpg`, so no EXIF, GPS, XMP, IPTC or ICC
  metadata from the upload is stored. Rejected, flagged and choice-required photos are not stored.

Thresholds live in one per-model config (`sfaceConfig` in
[`packages/adapters/src/face-embedder.ts`](packages/adapters/src/face-embedder.ts)); the Identity
Gate and the single-photo Ceiling (0.60) are provisional until calibrated on real pairs in
Milestone 0 (issue #1). The
face tests use only licence-clear fixtures, listed in
[`packages/adapters/test/fixtures/faces/README.md`](packages/adapters/test/fixtures/faces/README.md),
and need the real weights: run `bun run models:fetch` first (CI caches them); missing weights fail
the tests with that command rather than skipping them.

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

| Package                    | Responsibility                                                                                                                                  | Dependencies at the boundary                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `@iconograph/domain`       | Pure Run schemas; `FaceEmbedder` seam; Identity Anchor/Ceiling and photo verdicts; price precedence and `Unpriced`                              | Effect only; no Mastra, storage, or infrastructure                                         |
| `@iconograph/adapters`     | Effect-to-Mastra schema helper; LibSQL storage; model weights; YuNet/SFace via ONNX; Reference Photo decoding and storage; LiteLLM price source | Effect, Mastra core and LibSQL adapter, libsql client, onnxruntime-node, sharp, libheif-js |
| `@iconograph/server`       | Trivial Run workflow and persistent CLI                                                                                                         | Domain and adapters; Mastra owns durable execution                                         |
| `@iconograph/eval-harness` | Runnable local evaluation fixtures                                                                                                              | Domain and server; no provider credentials                                                 |

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
`MASTRA_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1`; standalone runtime, evaluation, and test scripts
retain both flags as well. Tooling inherits the shell or CI environment rather than repeating the
flags in every script. Transitive telemetry libraries can still be present in the dependency graph;
their presence is not evidence of a telemetry request. This milestone does not make provider/model
requests; its only outbound requests fetch locked model weights and LiteLLM's price file. The
maintainer-run `bun run prices:snapshot` also queries `api.github.com` for LiteLLM's latest commit.

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
