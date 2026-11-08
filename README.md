# Iconograph

A Bun workspace for the headless Run loop: validate the Subject's Reference Photos with a local face
pipeline, generate Candidates with an Image Model inside a hard Budget, score their Likeness, judge
them, and let the Optimizer rewrite each Lane's Prompt until a stopping rule fires. Milestone 0
runs from the command line or through the HTTP server's API (see "Server and container"); there is
no UI yet.

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

### Vendor keys

Live Runs need vendor API keys; tests and CI never do. [SecretSpec](https://secretspec.dev)
declares them in the committed `secretspec.toml`, and the development shell exports them from
1Password on entry, so `bun run run` (and every other command in the shell) finds them in its
environment. The shell supplies the `secretspec` command (it ships with devenv); the 1Password
CLI (`op`) comes from the host.

The keys are Secure Notes `secretspec/iconograph/default/<KEY>` in the vault `Iconograph` of the
1Password account `my.1password.com`. The shell reads them as a **read-only service account**
(provider `onepassword_service`), so no Touch ID is needed and unattended shells get the keys
too. One-time setup:

1. In 1Password, create a service account with read access to the `Iconograph` vault only.
2. Store its token in the macOS Keychain: `secretspec config provider login onepassword_service`.
3. Add each key with your own account; the read-only service account can't write, so
   `secretspec set` fails. A key is a Secure Note titled `secretspec/iconograph/default/<KEY>`
   whose `value` field holds the key (fish; `read -s` keeps it off the screen and out of history):

   ```fish
   read -s -P "ICONOGRAPH_ANTHROPIC_API_KEY: " value
   op item create --account my.1password.com --vault Iconograph --category "Secure Note" \
       --title "secretspec/iconograph/default/ICONOGRAPH_ANTHROPIC_API_KEY" --tags automated,iconograph \
       "project[text]=iconograph" "key[text]=ICONOGRAPH_ANTHROPIC_API_KEY" "value[concealed]=$value"
   set -e value
   ```

4. Check without printing any key, then reload the shell (`direnv reload`, or leave and re-enter
   `devenv shell`):

   ```sh
   secretspec check --explain
   ```

The keys are `ICONOGRAPH_ANTHROPIC_API_KEY` (the default Judge and Optimizer),
`ICONOGRAPH_OPENAI_API_KEY` (OpenAI Lanes, an `openai/` Judge or Optimizer) and
`ICONOGRAPH_GEMINI_API_KEY` (Gemini Lanes, a `google/` Judge or Optimizer). They carry the
`ICONOGRAPH_` prefix, and Iconograph reads no other names, so that an AI coding agent started in
the shell (Claude Code, omp, Codex, Gemini CLI) doesn't find a vendor's standard variable
(`ANTHROPIC_API_KEY`, …) and bill the API instead of your subscription. All are optional, and a
missing or rejected service token only warns: the shell still opens, and a Run names the key it
is missing.

How it works: `enterShell` in `devenv.nix` runs `secretspec export` and exports the result into
the live shell. The keys are never set through devenv's `env`, which would write them into the
world-readable Nix store, and devenv's own SecretSpec integration (`secretspec.enable`) stays off:
it would fetch the keys a second time and refuse to open the shell when the token is missing.
Every process in the shell, including an AI coding agent started there, sees the keys, under
names no vendor's tool reads. To read them from another store, set the provider on entry, for
example `SECRETSPEC_PROVIDER=keyring devenv shell`.

The service account's reads are cached in the macOS Keychain for 30 days (`cache` on
`onepassword_service` in `secretspec.toml`), so entering a shell normally doesn't contact 1Password
and many shells or worktrees don't run into its rate limit. A fresh entry is used as is; an expired
or missing one is read from 1Password again. After rotating a key in 1Password, run
`secretspec cache clear` (all keys) or `secretspec cache clear <KEY>`, then reload the shell.

## Commands

The development shell supplies both telemetry opt-out variables to tooling through environment
inheritance. Root runtime scripts (`run`, `photos:validate`, `prices`, …) and `test`, and package
runtime entrypoints, retain explicit `MASTRA_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1` prefixes so they
remain safe outside the shell. Formatting, linting, typechecking, licence auditing, and ADR
validation use plain commands; `check` composes the scripts and finishes with `bun run test`.
Outside the shell, set both variables when invoking Bun or Mastra directly instead of the scripts.

```sh
# Start a Run (see "Runs" below); needs ICONOGRAPH_GEMINI_API_KEY (and ICONOGRAPH_OPENAI_API_KEY
# for an OpenAI Lane) and the Judge's key (ICONOGRAPH_ANTHROPIC_API_KEY), which the shell exports
# (see "Vendor keys").
bun run run --budget 0.50 me-1.jpg me-2.jpg me-3.jpg

# Print a stored Run again from the database.
bun run run read --run-id RUN_ID

# Compare the Optimizer loop with resampling the starting Prompt (see "Eval harness"); by hand only,
# with real keys.
bun run eval --out ~/eval-out ~/subjects

# The HTTP server on 127.0.0.1:4111 (see "Server and container").
bun run serve
bun run build:server  # bundle + pruned externals in dist/server, for this machine

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
A second job builds the container image on an amd64 and an arm64 runner and runs its smoke test
and a `/health` boot check on each; pushes to `main` then publish both to GHCR (the only job that
can write packages).

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
are re-hashed on every use and never downloaded again once verified. A download that receives no
data for 30 s (headers or body) is aborted with an error naming the model and URL; a slow but
progressing one is never cut off. A download names its temp file with its process id
(`<file>.<uuid>.<pid>.partial`) and refreshes it every minute; the next download of that model
removes one only once unmodified for 10 minutes and its process is gone (its own process id counts
as gone unless it is writing that file, since a restarted container is PID 1 again; machines sharing
the folder from separate process namespaces rely on the age alone). **Offline
machines**: copy the locked files (same names) into `<data dir>/models` by any means; they are
verified like downloads.
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
   on `main`), cached with its fetch time in `<data dir>/prices.db`, and refetched once 24 h old
   (or dated in the future). The server checks at boot, without holding up the start, and hourly
   while it runs, so while LiteLLM is reachable the cache reaches about 25 h at most; a failed
   refetch is logged as a warning and retried at the next hourly check. A Run CLI refreshes on its
   first price lookup; the `prices` command checks on every lookup (`--refresh` forces a fetch). A
   failed refresh keeps serving the old cache with its age, marked `stale` once it is 24 h old or
   dated in the future. An unrelated entry whose price fields are malformed is dropped (that model
   is unpriced) and listed in `refresh.rejected`. A default model's entry that is malformed or
   can't price that model (e.g. a required price field is missing), a response that isn't JSON, or
   one that prices no model fails the refresh and leaves the cache untouched.
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
OpenAI image models per input text token, input image token and output image token; LLMs per input
and output token. Only standard rates are read; cache, batch and long-context tiers are ignored.
Vendors may discount cached input automatically, so prices are upper bounds; batch calls and
contexts over 200k tokens are assumed unused.

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
Gate (0.40) and the single-photo Ceiling (0.66) were calibrated on real pairs with
`faces:calibrate` (see Calibrating the face thresholds below; issue #11). The
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
reaches the threshold. The threshold (0.52, calibrated on real pairs in issue #11; ADR-0008) lives in
`facenetConfig` in
[`packages/adapters/src/held-out-embedder.ts`](packages/adapters/src/held-out-embedder.ts).

**Never used by the Optimizer loop:** the held-out embedder is its own service
(`HeldOutFaceEmbedder`, not a `FaceEmbedder`) and is not exported from the `@iconograph/adapters`
index. Its module is also reachable as `@iconograph/adapters/held-out`, for the eval harness, which
scores Candidates only after their Run has ended; that subpath resolves from the server too, so lint
forbids it in `packages/server/**` and the import-graph test in
`packages/server/test/held-out-isolation.test.ts` fails on any server module that imports it
(`faces:calibrate` below and the eval harness are the other commands that load it).

### Calibrating the face thresholds

The SFace Identity Gate (0.40), the single-photo Identity Ceiling (0.66) and the FaceNet threshold
(0.52) were calibrated on real pairs (issue #11; rationale in ADR-0008). `faces:calibrate` measures both
face models on photos of consenting Subjects and suggests values; it never changes them.

```sh
bun run faces:calibrate ~/calibration                  # data dir as for models:fetch
bun run faces:calibrate --target-far 0.001 ~/calibration
```

- **Consent:** use only photos of people who agreed to their use for this calibration, and of
  generated Candidates of them.
- **Folder layout:** one directory per Subject holding that Subject's real photos (JPEG, PNG or
  HEIC, decoded as by `photos:validate`). Optional generated Candidates that a person labelled go in
  `<subject>/candidates/like/` (judged to show the Subject) or `<subject>/candidates/unlike/` (judged
  not to). No manifest is needed:

  ```text
  calibration/
    ada/1.jpg  ada/2.heic  ada/candidates/like/c1.png  ada/candidates/unlike/c2.png
    bob/1.jpg  bob/2.png
  ```

  Four pair sets are reported, the two the thresholds come from first. `realAnchor`: each real
  photo against the Identity Anchor of its Subject's other photos (same-person, Subjects with 2 or
  more photos) and against each other Subject's anchor (different-person), as Reference Photos are
  judged against the Gate; a value that is one photo pair twice (a 2-photo Subject's two photos, two
  1-photo Subjects against each other) is counted once. `candidateAnchor`: each Candidate against
  its Subject's Identity Anchor; the Gate also judges Candidates, against the full anchor, and so
  does the held-out check. `real` (photo against photo) and `candidatePhoto` (each Candidate against
  each real photo of its Subject) are context. `like` counts as same-person, `unlike` as
  different-person. Anchors and Ceilings use every photo with one face, with no cap at 8 and no
  Gate flagging, unlike a Run. At least 2 Subjects are needed, one with 2 or more photos. Hidden
  files are ignored and other entries outside the layout are listed as `skipped`; an image (photo
  or Candidate) with no face or several faces is skipped and reported, never guessed; any other file
  in a photo folder that can't be read or decoded as an image, or the same image twice, is an error.
  A backslash (`\`) in the folder's path (as given or as it links to) or in any entry's name fails
  the run with a hint to rename it: Bun reads it as a folder separator, which can name another file.

- **Never committed:** photos are read in place, from their real location, never copied, stored or
  uploaded. The report names images only relative to the folder; errors name the folder as you
  gave it (an absolute path if you gave one) and images relative to it, never by their absolute
  path (nor where a symlinked image really lives). Git must not be able to add any file in the
  folder or in the real folder of any image in it (symlinks resolved): each lies outside any git
  working tree, or all its files are ignored (`git ls-files --others --exclude-standard` lists
  nothing) and none is tracked; otherwise the command refuses, so git won't pick up the photos
  (keep the folder outside the repository, or under the git-ignored `.data/`). For a folder inside
  the calibration folder, the refusal names the first such file relative to it (often a stray
  `.DS_Store` or `notes.txt`); files beside a symlinked image's real file are not named. A folder
  inside a repository's git folder (e.g. a bare repository nested in a working tree) is refused
  too, since a working tree around it could add it. A forced `git add -f` is not prevented. The
  check runs for the folder and for each distinct real image folder, each twice: with your `GIT_*`
  variables (as your git sees it, e.g. with `GIT_DIR` and `GIT_WORK_TREE` set; then refusals and
  failures say "with your GIT_* settings", and a folder outside that `GIT_WORK_TREE` counts as
  outside for this pass) and without them (so `GIT_CEILING_DIRECTORIES` can't hide a repository);
  both must accept, with up to 3 git calls each. Git runs with English messages (`LC_ALL=C`), file
  names unquoted (`core.quotePath=false`, so umlauts print as they are), discovery across
  filesystems (so a folder on another volume is judged by the repository it is in, if any), and in
  the folder itself with a literal `.`, so no folder name is read as a pathspec. If git can't be
  run, or fails while checking (other than finding no repository), the command refuses. Limit: a
  repository bound to the folder only on git's command line or in its config (`--work-tree`,
  `core.worktree`, e.g. a bare dotfiles repository used through a shell alias) is invisible to the
  check.
- **Report** (one JSON object): per model (`sface`, `facenet`), its configured values and, per pair
  set, the same- and different-person similarity distributions (count, min, p05, p25, median, p75,
  p95, max; `null` for a side without pairs) and FAR (share of different-person pairs at or above a
  threshold) and FRR (share of same-person pairs below it; either is `null` without pairs) at
  0.20–0.90 in steps of 0.05 and at the configured threshold. `realAnchor` and `candidateAnchor`
  also give the `suggestion` (the lowest threshold on a 0.01 grid whose FAR is at most
  `--target-far`, default 0.01, with its FAR and FRR; absent when the set has no different-person
  pairs, `null` when no threshold up to 1 reaches the target) and the `equalErrorRate` point (`null`
  unless both sides have pairs); `real` and `candidatePhoto` don't. For SFace, `ceiling.suggested`
  is the median of the per-Subject Ceilings (`ceiling.subjects`, each the median of that Subject's
  real-photo pairs), with `pooledMedian` (the median of all same-person real-photo pairs) beside it.
  `rules` states each rule. Warnings per pair set: fewer than 30 pairs on a side; on the suggesting
  sets also too few different-person pairs to resolve the target FAR (at least 1/target) and no
  threshold reaching the target. Report-level `warnings`: a Subject whose Candidates have no real
  photo with one face to pair with; a Subject with more than 8 photos (its anchor similarities run
  higher than a Run's, for other people too); a suggested Ceiling more than 0.05 from the pooled
  median; and, since the thresholds require Ceiling ≥ Gate, a suggested Ceiling below a Gate
  suggested by `realAnchor` or `candidateAnchor` or below the configured Gate, and a suggested Gate
  above the configured Ceiling.
- **Recording the result:** take the SFace Identity Gate and the FaceNet threshold from the
  `realAnchor` suggestion, and from `candidateAnchor` when you have labelled Candidates; weigh both.
  Set the chosen values in `sfaceConfig` (`identityGate`, `singlePhotoCeiling`) and `facenetConfig`
  (`threshold`), update the tests that pin them, and record the rationale (pair counts, rates at the
  chosen values) in ADR-0008's consequences or on issue #11. Too high a FaceNet threshold marks real
  likeness "Likeness Unconfirmed"; too low misses scorer overfitting.

### Runs

`bun run run` starts a Run: it validates the Reference Photos (as `photos:validate` does), runs the
Lanes concurrently (a few at a time, as many as `LANE_CONCURRENCY` in
`packages/server/src/workflow.ts` allows and `--help` states; more wait their turn), and in each
Lane repeats an Iteration until a stopping rule fires: generate the Iteration's Candidates, score
each one's Likeness, have the Judge score every Candidate that passed the Identity Gate against the
Rubric, then stop the Lane or have the Optimizer write its next Prompt. It prints the results with
their costs. Without `--lane` the Run has one Gemini Lane (`gemini-nano-banana-2.1`).

```sh
bun run run --budget 0.50 --candidates 3 --look look.json --pin 2 me-1.jpg me-2.heic me-3.jpg

# A Gemini Lane and an OpenAI Lane (Flare) with its own photos and Prompt, in one Run.
bun run run --budget 0.50 --candidates 1 \
  --lane gemini --lane openai:flare,photos=1+3,prompt=openai-prompt.txt \
  me-1.jpg me-2.heic me-3.jpg
```

The development shell exports the keys (see "Vendor keys"); any other way of setting the
variables works too. A Run needs only the keys of its
Lanes' vendors, its Judge's vendor and, for more than one Iteration, its Optimizer's vendor. Keys
are read only from the environment and sent only in request headers; they never enter the
database, the output or an error. In the failure reasons of an OpenAI Lane and of every Judge
and Optimizer, a masked echo of a key in the usual form (a word with three or more asterisks,
such as `sk-proj-****abcd`) is redacted too, and every reason is cut to about 2000 characters. A
key shorter than 20 characters or with spaces, control or non-ASCII characters (a bad paste) is
rejected before its price lookup and before any billable call, without echoing it. That check
only proves a key is set, not that the vendor accepts it: a Judge or Optimizer call the vendor
answers with HTTP 401, 402, 403 or 404, or Google's HTTP 400 for a bad key (reason
`API_KEY_INVALID`), stops each Lane at the first such call it makes (`judge-failed`,
`optimizer-failed`; see "Stopping rules"): the Optimizer's after the Lane's first Iteration, the
Judge's in the Lane's first Iteration with a Scored Candidate.

- **Arguments:** 1 to 8 Reference Photos; `--budget USD` (default 5), `--candidates N` (1 to 8,
  default 3, per Lane and Iteration), `--look FILE`, `--lane SPEC` (repeatable, below), `--pin
  PHOTO` (repeatable), `--face PHOTO:FACE` (as for `photos:validate`), `--judge-model ID` and
  `--judge-effort LEVEL` (see "Judge" below), `--optimizer-model ID` and `--optimizer-effort
  LEVEL` (see "Optimizer" below), the stopping rules `--target-score N`, `--patience N`,
  `--min-improvement N` and `--max-iterations N` (see "Stopping rules" below), `--data-dir PATH`
  and `--db PATH` (default `./iconograph.db`, whose directory must exist). `bun run run read
  --run-id ID` prints a stored Run's report again; it refuses a `--db` file that doesn't exist.
- **Stopping rules:** a Lane stops after an Iteration when its best Candidate (the highest weighted
  total of any judged Candidate of the Lane) reaches `--target-score` (default 8.5, 0 to 10; the
  target itself counts) with `target-score`; when `--patience` Iterations in a row (default 3, 1
  to 50; above `--max-iterations` it never fires, which turns it off) haven't raised the best
  score by `--min-improvement` (default 0.2, above 0 and at most 10; exactly that counts, compared
  at 9 decimals so 8.3 → 8.5 does) with `patience`; when two Iterations in a row had only Refused
  or Failed Candidates (a Gated Candidate is an image, so it breaks the streak) with
  `repeated-failures`; and after `--max-iterations` Iterations (default 8, 1 to 50) with
  `iteration-limit`. Patience measures from the best score at the last counted improvement, so
  small rises that add up to the minimum count as one; an Iteration with no judged Candidate is no
  improvement. A billable call that doesn't fit the Budget isn't made (an image call's Candidate
  is stored Failed, a Judge call's `judge-failed`, saying so), and the Lane stops after that
  Iteration with `budget-exhausted` (unless its target was reached). A Judge or Optimizer call
  the vendor answers with HTTP 401, 402, 403 or 404 (a rejected key, no credit left, no access to
  the model, or no such model), or with Google's HTTP 400 for a bad key (`error.details[].reason`
  `API_KEY_INVALID`), would be turned away every time, so it isn't retried and the Lane stops: an
  Optimizer call at once with `optimizer-failed` (no next Prompt, no next Iteration); a Judge call
  with `judge-failed` once the Iteration's calls already made have settled (no image or Optimizer
  call, and no Judge call beyond retries of calls already running; Candidates judged before keep
  their scores, and the best is still reported). Each Lane stops on its own first such call, and
  the result and the report show the vendor's reason (the key itself redacted) as the Lane's
  `stopDetail`, and a warning names it.
  Cancelling the Run stops every Lane not yet stopped with `cancelled`, wherever the cancel
  lands (mid-call, between Iterations, during preparation, or with Lanes still waiting their
  turn; if the process stops before that is recorded, the report still shows them `cancelled`); a
  Lane's first recorded stop reason stands. When several hold after the same Iteration, the first of
  `cancelled`, `optimizer-failed`, `judge-failed`, `target-score`, `budget-exhausted`,
  `repeated-failures`, `patience`, `iteration-limit` wins: a Lane that reached its target says so
  even if a call of that Iteration didn't fit. The rules are frozen with the Run's request
  (`stopRules`).
- **Lanes:** each `--lane NAME[,photos=N+N...][,prompt=FILE]` adds one Lane. `NAME` is `gemini`
  (`gemini-nano-banana-2.1`), `openai` or `openai:sunburst` (`gpt-image-2.5-sunburst`), or
  `openai:flare` (`gpt-image-2.5-flare`). `photos=1+3` limits the Lane to those Reference Photos
  (numbered from 1; default all); a Lane none of whose photos is accepted fails the Run before any
  call. `prompt=FILE` replaces the Lane's initial Prompt (default: built from the Target Look) with
  the file's text, trimmed, up to 32,000 characters; it comes last, and everything after `prompt=`
  is the path, commas included. The Identity Anchor and the Judge's Reference Photos always come
  from all accepted photos, and one Budget covers every Lane and the Judge.
- **Target Look:** a JSON file with any of the facets `pose`, `background`, `lighting` (lighting
  and colour), `hairstyle`, `clothing`, `framing` and `retouching`, each a text of up to 500
  characters, e.g. `{"background": "dark navy backdrop", "clothing": "grey suit"}`. Missing facets
  take defaults (a neutral corporate headshot); `hairstyle` defaults to "as in the Reference
  Photos", and `retouching` to natural professional retouching that keeps the Subject at their
  real age as in the Reference Photos, never older or younger (the text is
  `DEFAULT_TARGET_LOOK.retouching` in `packages/domain/src/target-look.ts`); `"none"` for no
  retouching. Retouching never changes facial features, face shape, distinctive marks or the
  beard and hair colour (unless `hairstyle` asks otherwise), including any grey. A Run stored before
  the facet existed reads with `retouching` `"none"`. Unknown facets are rejected, and so is text
  with leading or trailing spaces. The look is frozen with the Run, and the first Prompt is built
  from it.
- **Character references:** each Image Model keeps a character's identity from a limited number of
  reference images (Gemini 4, OpenAI 16), chosen from the Lane's accepted photos: pinned photos
  first (pins apply to every Lane, must be among each Lane's photos, and more than the model takes
  is an error); without pins the first pick is the largest, most frontal face (frontality ×
  √area); each further pick is the photo farthest in face embedding from those already chosen, so
  near-duplicates lose to different angles or light. Only these photos, as the stripped stored
  copies (downscaled to 2048 px on the longest side when larger), and the Lane's Prompt are sent to
  its vendor.
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
- **OpenAI:** the native Images API edits endpoint (`POST /v1/images/edits`, JSON with the
  references as base64 data URLs), `quality: high`, a square `1024x1024` JPEG, `n: 1`, so N
  Candidates are N parallel calls. OpenAI keeps the inputs and outputs of `/v1/images/edits` for
  up to 30 days in its abuse-monitoring logs (not used for training; Zero Data Retention needs
  OpenAI's approval): see [your data](https://developers.openai.com/api/docs/guides/your-data). A
  moderation block (`moderation_blocked`) is Refused with OpenAI's message, stage and categories
  and not retried; 408, 429 rate limits and 5xx responses and network failures are retried with
  exponential backoff (1 s, 2 s) up to twice, then Failed; quota, credit and spend-limit 429s,
  other errors, and a response without a usable image are Failed at once.
- **Judge:** a Mastra agent with structured output, on its vendor's AI SDK provider
  (`@ai-sdk/anthropic`, `@ai-sdk/openai` through the Responses API, `@ai-sdk/google`); by
  default Claude Sonnet 5.5 (`anthropic/claude-sonnet-5-5`) at `low` effort. `--judge-model` takes
  any `anthropic/`, `openai/` or `google/` vision model as a `vendor/model` id; any other vendor is
  refused before any billable call. `--judge-effort` takes `low`, `medium` or `high`, passed as
  the vendor's reasoning parameter (Anthropic `effort`, OpenAI `reasoningEffort`, Gemini
  `thinkingConfig.thinkingLevel`). Its key comes from the environment only:
  `ICONOGRAPH_ANTHROPIC_API_KEY`, `ICONOGRAPH_OPENAI_API_KEY`, or `ICONOGRAPH_GEMINI_API_KEY`
  (`google/`). The Judge is checked first, before any billable call: its key, then (for a Run of
  more than one Iteration) the Optimizer's key, before any price is looked up; then their prices,
  then each Lane's Image Model, its key before its own price. The key and the Reference Photos go
  only to the vendor's own API (`https://api.anthropic.com/v1`, `https://api.openai.com/v1`,
  `https://generativelanguage.googleapis.com/v1beta`), set explicitly: the base-URL variables
  `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` and `GOOGLE_BASE_URL` have no effect on the Judge. A
  proxy set by `HTTPS_PROXY` (or `ALL_PROXY`) still carries the connection, tunnelled with TLS to
  the vendor unless certificate checks are relaxed.
  Gated, Refused and Failed Candidates are never judged. Each Judge call sees the Rubric, then at
  most 3 representative Reference Photos of the Run, then the Candidate, then the Target Look
  (each facet quoted as a JSON string, and the Judge told never to follow it as an instruction);
  nothing else leaves the machine. The photos are chosen once per Run from all accepted photos,
  whatever photos a Lane is limited to, by the character-reference ranking without pins (best face
  first, then each photo most unlike those chosen) and sent in that order for every Candidate of
  every Lane. Every image the Judge sees, photos and Candidate, is the stored (stripped)
  copy normalised (upright, flattened onto white, JPEG) and downscaled (never enlarged) to at most 1024 px on its
  longest side: a head-and-shoulders face then spans about 400 px, enough to judge identity,
  realism and the look, and it bounds what each image costs. Images go inline with every call (no
  vendor file reuse yet). A call is aborted after 180 s at `low` effort, 300 s at `medium` and
  600 s at `high`, room for the whole output cap at about 30 tokens/s. Calls don't stream, so no
  bytes arrive until the answer is done: the Judge's requests turn off Bun's fetch idle timeout
  (300 s by default), leaving that abort as their only deadline.
  Anthropic deletes API inputs and outputs within 30 days unless a request is flagged
  under its Usage Policy (then up to 2 years) or a zero-retention agreement applies
  ([Anthropic Privacy Center](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data));
  OpenAI and Google apply their own API terms. When the Judge's vendor also makes a Lane's Image
  Model (e.g. a `google/` Judge with a Gemini Lane, or an `openai/` Judge with an OpenAI Lane),
  the report carries the warning code `judge-same-vendor`, naming those Lanes: a Judge may favour
  its own vendor's images.
- **Rubric v2:** the Judge rates Resemblance (is it unmistakably the Subject, at the same
  apparent age?), Realism (does it look like a real professional photograph?), and how well Pose,
  Background, Lighting (and colour), Hairstyle, Clothing and Framing match the Target Look, each
  on an anchored level 1–5 with a written anchor per level, mapped linearly to 0–10 (1 → 0, 5 →
  10). The Target Look's `retouching` has no criterion of its own: for Resemblance, retouching
  within it is no difference, while retouching beyond it (e.g. any smoothing or whitening when it
  says none) and apparent age older or younger than in the Reference Photos are; visible
  over-editing (fake-white or uniform teeth, plastic or airbrushed skin, a younger-looking face) is
  a Realism artefact. It also lists the visible issues and suggested Prompt fixes (at most 10
  each); an answer outside that schema fails the judging. Likeness comes
  from the face model and is never blended with Resemblance; a Candidate is **Disputed** when they
  differ by more than 4 points (exactly 4 is not). The weighted total uses the Run's weights,
  frozen with its request: by default Likeness 0.30, Resemblance 0.15, Realism 0.15, Pose 0.10,
  Background 0.08, Lighting 0.08, Hairstyle 0.07, Clothing 0.05 and Framing 0.02 (they must be
  non-negative and sum to 1, and an unknown criterion fails the request). The total is rounded to
  9 decimals. Every judgement records its Rubric version (`rubric-v2`); `rubric-v1` judgements of
  earlier Runs still read, checked by v1's rules. A Run keeps its Rubric: one started under
  `rubric-v1` that still has Iterations to run fails its next one before any image is generated.
- **Judge failures:** a rate limit, server error or overload (408, 429, 5xx), a network failure
  (a coded error such as DNS, TLS or a reset, and a 2xx response whose body broke off) or a call
  past its timeout is retried like an Image Model call (1 s, 2 s, up to twice); a refusal,
  another HTTP error (400 and up), a local programming error (a TypeError, SyntaxError or
  RangeError with no code or a Bun/Node argument code such as `ERR_MISSING_ARGS`, booked at its
  estimate since it may follow a billed response; only `ERR_INVALID_URL`, thrown before
  anything is sent, at $0), an empty answer, an answer cut off at the
  output cap or one outside the schema (the reason names the first problem and where) is not.
  A 401, 402, 403 or 404, or Google's 400 for a bad key (reason `API_KEY_INVALID`), is
  `non-recoverable` (result in the call's record, at $0) and stops the Lane (`judge-failed`, see
  "Stopping rules"); any other 400 can be specific to one request, so it fails only that judging.
  OpenAI reports a structured-output refusal as an empty answer, which Mastra 1.80 doesn't mark,
  so it shows as cause `failed` ("empty answer"), not `refused`. Mastra's
  own retries are off, so every attempt is a reserved, recorded call. A Candidate whose judging
  failed keeps its Likeness and is marked `judge-failed` with a `cause` (`refused`, `failed`,
  `gave-up` after transient errors, `budget-exhausted`, or `non-recoverable`) and the reason; it
  never gets a made-up score.
- **Optimizer:** a Mastra agent with structured output, built as the Judge is (its vendor's AI SDK
  provider, the vendor's own API endpoint, the same keys, reasoning effort, deadlines per effort
  and output caps; ADR-0013); by default Claude Sonnet 5.5 (`anthropic/claude-sonnet-5-5`) at
  `medium` effort. `--optimizer-model` takes any `anthropic/`, `openai/` or `google/` model as a
  `vendor/model` id, `--optimizer-effort` `low`, `medium` or `high`; both are frozen with the Run
  and its key and price are checked at Run start, after the Judge's key (a Run of one Iteration
  never calls it, so it checks neither and stores no Optimizer price). Between two Iterations it
  writes the Lane's next Prompt from the Target Look (quoted, to rephrase but never change) and that
  Lane's recent Iterations only: the last 3, and the Iteration of the Lane's best Candidate when it
  is older, each with its Prompt and every Candidate's outcome (Refused or Failed with the reason,
  Gated, or Scored with its Likeness, weighted total, per-criterion scores, the Judge's issues and
  suggested fixes). Only that text is sent, never a photo; another Lane's Prompts never are. Its
  answer must be a Prompt of 1 to 32,000 characters (trimmed); an answer outside its schema, blank
  or longer is a failed call at its cost. When optimizing fails (a refusal, a failed call, retries
  that ran out), the next Iteration keeps the last Prompt and records why (`source: "kept"`); a
  401, 402, 403 or 404, or Google's 400 for a bad key, instead stops the Lane at once
  (`optimizer-failed`). Its calls are retried and costed like the Judge's; its estimate counts the
  instructions, schema and message text as the Judge's does, plus the whole output cap.
- **Budget:** every billable call, retries included, is checked against the remaining Budget
  (Budget − actual cost so far − estimates of calls in flight) before it is made. All N first calls
  of an Iteration are reserved in order before any is launched, so parallel calls can't overspend;
  a call that doesn't fit isn't made: its Candidate is stored Failed (`budgetExhausted: true`) and
  the Lane stops after the Iteration (`budget-exhausted`, unless its target was reached), as it
  does when an Optimizer call doesn't fit. Concurrent Lanes reserve
  against the same Budget, so together they can't overspend it either. Gemini's estimate assumes
  1120 input tokens per reference plus the Prompt (about 3 characters per token), the 2K image
  price and 4000 tokens of text and thinking. OpenAI's assumes the Prompt (3 characters per token),
  6144 image tokens per reference (OpenAI doesn't document GPT Image 2.5's input tokenization; this
  is 1.5× the 32 px patches covering a 2048 px square, not yet calibrated) and the 1756 output
  image tokens OpenAI's calculator gives for a high-quality 1024x1024 image. The actual cost comes
  from the response's usage at the price recorded for the Lane when the Run started (stdout shows
  its source, age and whether the LiteLLM data was stale). Gemini's HTTP errors are booked at $0
  (Google's billing page: failed 400 and 500 requests aren't charged); OpenAI doesn't document
  whether errors are billed, and a moderation block can come after the image was generated, so
  every OpenAI HTTP error counts at its estimate. A response without complete usage data (Gemini:
  input, output and thought totals, an output split by modality that adds up, and an image-token
  count whenever the response holds an image; OpenAI: input total with a text/image split that adds
  up, and the output total), or a call interrupted mid-flight, counts at its estimate. A
  reservation is booked at $0 when the engine knows its call wasn't sent; otherwise a call whose
  result couldn't be recorded stays unsettled (`settled: false`) and counts at its estimate,
  usually with a `{"warning": …}` line on stderr naming the Run, Lane, Iteration and Candidate.
  A process killed mid-call leaves the call unsettled without a warning; `read` still shows it.
  A call can cost more than its estimate, so the actual total can exceed the Budget by at most
  that difference on calls already in flight. Judge calls count against the same Budget: each
  Lane's Judge calls are reserved in Candidate order after its Candidates are scored; one that
  doesn't fit, or a retry that doesn't, isn't made, its Candidate is `judge-failed` with cause
  `budget-exhausted`, and the Lane stops as above. A Judge call's estimate is an
  upper bound: the instructions, Rubric, verdict schema (as sent) and Target Look with ASCII at
  2.5 characters per token (Anthropic's current tokenizer averages about that) and every other
  UTF-16 code unit at 2 tokens (CJK measures about 0.7, emoji and rare CJK up to about 1.5), each
  image at its model's documented worst case for 1024 px (Anthropic ⌈w/28⌉·⌈h/28⌉ ≤ 1,369; OpenAI
  patch models ⌈w/32⌉·⌈h/32⌉ × up to 2.46 ≤ 2,520, which also covers its tile models; Gemini 3
  and later ≤ 1,120), plus a margin for prompts vendors add unseen (structured output and
  thinking system prompts): 1,000 input tokens or 10%, whichever is more; and the whole output
  cap, reasoning included: 4,096 tokens at `low` effort, 8,192 at `medium`, 16,384 at `high`. A
  model with no documented bound (e.g. `openai/gpt-4o-mini`, whose image tiles cost 5,667 tokens
  each, or a Gemini model before Gemini 3, whose tiles are unbounded for wide images) can't be the
  Judge. For Sonnet 5.5 with 3 Reference Photos the estimate is
  about $0.059, $0.100 or $0.182 per call. Its actual cost comes from the reported
  input and output tokens (output includes reasoning) at the price recorded for the Judge when the
  Run started, looked up under LiteLLM's key (`claude-sonnet-5-5`, `gpt-5.5`, `gemini/gemini-…`).
  HTTP errors (400 and up) and network errors that show nothing was sent (ENOTFOUND, EAI_AGAIN,
  connection refused) are booked at $0; any other network failure or a timeout has an unknown cost, so it counts at
  its estimate against the Budget and as $0 in `actualUsd` (`unknownCostCalls`). A Run with an
  unpriced model, Judge or Optimizer doesn't start. The Budget is in whole
  micro-dollars: at most 6 decimals, from $0.000001 to $1,000,000.
- **Output:** first, before any Candidate is generated, one JSON line on stderr with at most what
  the Run can cost if every Lane ran all `maxIterations` Iterations, each call at its first-call
  estimate (retries, and calls that cost more than estimated, can exceed it) (`{"event":"estimate",
  …}`: per Lane its Image Model calls, `perCallUsd` being one call of the first Iteration, with the
  Lane's Prompt, and later ones quoted with the longest Prompt allowed; the Judge's calls, one per
  Candidate; and the Optimizer's, one between each two Iterations of a Lane, each at the largest
  request the Run allows plus 1% (`perCallUsd`): four Iterations with Prompts of 32,000 characters
  and every Candidate judged with every note at its longest, no lower than any realistic request
  and far above a typical one; none for a Run of one Iteration). Then one JSON object on stdout,
  with one entry per Lane (its model, stop reason — with `stopDetail`, the vendor's reason, for
  `optimizer-failed` and `judge-failed` — `iterations` begun — each has its Prompt
  stored; the last may have made no call, after a cancel or when its first calls didn't fit —
  `best` Candidate — `iteration` from 1, `candidate` index from 0 within it, and
  `score`, or null when none was judged — its `prompts`, one per Iteration with the Prompt, its
  `source` (`initial`, `optimizer`, `kept` with a `reason`, or `resampled` in an eval harness
  Resample Lane, marked `resample: true`) and the `optimizerCost` of that
  Iteration's Optimizer calls, which wrote the next Iteration's Prompt; character references and
  price source): per Candidate its Iteration, index and Outcome —
  `Refused` or `Failed` with a reason, `Gated` (`no-face` or `below-gate`, with the best face's
  similarity) or `Scored` with its Likeness (similarity to the Identity Anchor scaled linearly from
  the Gate, 0, to the Identity Ceiling, 10, and clamped; with a Ceiling at or below the Gate,
  anything at the Gate scores 10) — its stored image path and SHA-256, and its estimated and actual
  cost per call; its `judgement` — `null` when it wasn't judged, `judged` with `resemblance`,
  every criterion's `scores` and `levels`, `weightedTotal`, `disputed`, `rubricVersion`, `issues`
  and `promptFixes`, or `judge-failed` with its `cause` and `reason` — and its `judgeCost` (the
  Judge's calls and their costs); the `judge` (model, effort, weights, Rubric version, its
  Reference Photos and price source), the `optimizer` (model, effort and price source; no price
  source for a Run of one Iteration, which never calls it) and the
  `stopRules`; totals over every billable call of the Run and the remaining Budget; the Run's
  `warnings` (branch on `code`, e.g. `judge-same-vendor`, never on the message); the Reference
  Photo warnings. `actualUsd` counts calls of unknown cost (`unknownCostCalls`) as $0, while the
  remaining Budget counts them at their estimate, so `budgetUsd − actualUsd` can exceed
  `remainingUsd`; `committedUsd`, beside every `actualUsd`, counts them at their estimate too.
  Calls whose Candidate was never saved (the Run failed or was cancelled
  mid-call) are listed in `unattributedCalls` and still counted. With several faces in a
  Candidate, the best match to the
  Identity Anchor counts. A Run that fails after it started prints its `runId` in the stderr error,
  so `read` can show what it spent.
- **Storage:** Candidates are content-addressed files in `<data dir>/images` (JPEG or PNG; other
  types fail the Candidate). The `--db` file holds Mastra's workflow snapshots (no image data or
  embeddings, and no Prompt beyond a Lane's own, which is part of the Run request, the workflow
  input) and the tables `runs` (request with the frozen Target Look, Budget, Judge, Optimizer and
  stopping rules, and the photo report with the Identity Anchor and Ceiling), `lanes`,
  `iterations` (each Iteration's Prompt and its source), `candidates`, `judges` (the Judge's
  price, Rubric version and Reference Photos), `optimizers` (the Optimizer's price), `judgements`
  (one per judged Candidate, saved as soon as it exists) and `cost_records` (estimated and actual
  cost and usage per billable call, by purpose `generate`, `judge` or `optimize`), all keyed by
  Run, Lane, Iteration and Candidate (an Optimizer call by the Iteration it optimizes). A
  re-executed Iteration generates only the Candidates not yet stored, judges only those not yet
  judged, doesn't call the Optimizer for an Iteration already written, and runs nothing for a
  Lane whose stop is recorded: a call whose result was stored is never made again; one whose call
  ran but whose result was lost is made again, under the next attempt number, and billed again.
  A database written before the Judge or the Optimizer existed is refused (its cost records have
  no purpose, or can't hold an Optimizer call); use a new `--db` file. On one written before
  Resample Lanes (its Prompt sources lack `resampled`), every other Run works and a Run with a
  Resample Lane is refused before anything billable.

### Eval harness

`bun run eval` answers Milestone 0's question: does the Optimizer loop beat resampling the
starting Prompt at the same Budget? For every Subject and Image Model it runs two Arms, one Run
each, then scores every generated image of both with judges the loop never sees.

```sh
ICONOGRAPH_GEMINI_API_KEY=… ICONOGRAPH_OPENAI_API_KEY=… ICONOGRAPH_ANTHROPIC_API_KEY=… \
  bun run eval --out ~/eval-out --budget 2 --candidates 3 ~/subjects
```

- **Run by hand only, with real keys: it costs money.** About (Subjects × Image Models × 2) ×
  `--budget` goes to the Arms (a call that costs more than its estimate can overshoot a Run's
  Budget); the second Judge's spend comes on top, outside that Budget, and is reported separately.
  Both Judges' keys and prices, every Image Model's and, unless `--max-iterations 1`, the
  Optimizer's are checked, the photos validated and the face models loaded before the first
  billable call, and the plan (Runs, the Arms' total Budget) prints first. Until all of that has
  passed, nothing is written to the output folder (the price cache and the checked photos' copies
  go to a scratch folder that is removed afterwards), so the same `--out` works again; the output
  folder is created then, and never removed. CI never runs it: its tests use fake vendors only
  (`packages/eval-harness/test`).
- **Subjects folder** (required, outside this repository): one folder per consenting Subject with
  1 to 8 Reference Photos (JPEG, PNG or HEIC), numbered in name order with numbers compared as
  numbers (`2.jpg` before `10.jpg`) and validated as by `photos:validate`; every photo must be
  accepted. Optional files, matched without case: `look.json` (the Target Look, as `--look` of
  `bun run run`), `prompt.txt` (the starting Prompt of both Arms, not empty; default the Prompt
  built from the Target Look) and `faces.json` (`{"group.jpg": 2}`: face 2 of that photo, numbered
  as by `photos:validate`). Hidden entries are ignored.

  ```text
  subjects/
    ada/1.jpg  ada/2.heic  ada/look.json  ada/prompt.txt
    bob/1.jpg  bob/2.png   bob/faces.json
  ```

- **Arms:** `optimizer` is the normal Run (the Optimizer rewrites the Prompt between Iterations);
  `resample` is a Run whose single Lane is a Resample Lane (`resample: true` in its Lane request): it
  sends the starting Prompt every Iteration and never calls the Optimizer, so it is best-of-N
  sampling with the same Judge. Equal Budget means each Arm's Run gets the same `--budget` cap,
  Candidates per Iteration and Judge, and the same stopping rules except patience, which is off for
  the Resample Arm (set above the Iteration limit): patience stops an Optimizer that no longer
  improves, and a fixed Prompt never tries to, so it would end Resample Runs early with fewer
  images. The schema caps patience at 50, so at `--max-iterations 50` it is 50: it can then fire
  only in the last Iteration, and only when no Iteration scored. When the Budget, not the Iteration
  limit, ends its Runs, the Resample Arm spends what the Optimizer would have cost on more images.
  Each Arm's images and spend are reported beside its scores; `report.json` has each Arm's
  stopping rules (`settings.armStopRules`) and the second Judge's weights
  (`settings.evalJudgeWeights`).
- **Options:** `--out DIR` (new or empty, outside the repository; default `SUBJECTS/.eval-TIMESTAMP`)
  receives the Runs' database (`runs.db`, readable with `bun run run read --db DIR/runs.db --data-dir
  DIR/data --run-id ID`), their images (`data/`), every evaluated Run as soon as
  it finishes (`runs.jsonl`, one JSON line each) and `report.json`; nothing is written into the
  repository. `--model NAME` (repeatable: `gemini`, `openai`, `openai:sunburst`, `openai:flare`;
  default `gemini` and `openai`), `--budget`, `--candidates`, the loop's `--judge-*` and
  `--optimizer-*` and the stopping rules as for `bun run run` (`--patience` for the Optimizer Arm
  only); `--eval-judge-model ID` and `--eval-judge-effort LEVEL` (default: `openai/gpt-5.5`, or
  `google/gemini-3.1-pro-preview` when the loop's Judge is OpenAI's, at low effort); `--data-dir`
  holds the face-model weights (FaceNet built with `models:export-facenet`).
- **Held-out scores:** every Candidate with an image is scored by FaceNet (its best face's cosine
  similarity to the held-out anchor of the Subject's accepted Reference Photos, and whether it
  reaches the threshold, 0.52) and by the second Judge, which must come from another vendor than the
  loop's Judge (the same vendor is an error). It scores against the same Rubric with the existing
  Judge code and sees the Reference Photos the loop's Judge sees; its score is the Rubric's weighted
  total without Likeness (the default weights with Likeness at 0, the rest scaled to sum to 1), so
  the loop's face model never enters it. An image the held-out decode can't read is `unreadable`
  for both and not sent to the second Judge. A warning (`eval-judge-same-vendor`) names Image Models
  from the second Judge's vendor, whose images it may favour. Images without a face, unreadable
  images and Judge failures are counted, never averaged in; Candidates without an image (Refused,
  Failed) have no held-out score.
- **Flat second Judge:** a second Judge that gives (nearly) every image the same score can't tell
  the Arms apart (in the #14 run, 66 of 68 images got 7.50). Whenever `report.json` is written
  (also when the evaluation stopped early), a warning (`eval-judge-flat`) fires when at least 80%
  of at least 10 images it judged share one score, rounded to hundredths, the tables' precision. It
  counts the images of every Run of both Arms, the one that stopped the evaluation included, and
  only those it judged: failed, skipped and unreadable judgings count neither in the share nor in
  the 10. It checks all images and, when more than one Image Model has judged images, each Image
  Model's alone, one warning per flat scope, with the second Judge (`judge`), the scope
  (`imageModel`, null for all images), the dominant `score`, its `share` (0 to 1) and the judged
  `images`. Its second Judge comparison is then weak evidence: lean on FaceNet, or rerun with
  another second Judge or effort.
- **Failures:** the evaluation fails fast. A vendor's answer about one image (refused, failed, no
  face, unusable) is a score; anything else stops the evaluation after that Run: a Run that fails
  or can't be read back, a fault while scoring (the face models, a file, a bug), and a Run the
  vendor stopped because it rejected the loop's Judge or Optimizer for good (`judge-failed`,
  `optimizer-failed`: HTTP 401, 402, 403 or 404, i.e. its key, its model or the account's credit),
  since every later Run would pay for images it can't judge or improve. The Run that stopped it is
  listed with what it stored and spent (`complete: false`, and `armCost: null` when its spend
  couldn't be read back: unknown, not $0). When the second Judge's vendor rejects a call that way, a
  warning (`eval-judge-rejected`) prints at once and the remaining images are `skipped` by it; its
  calls run one at a time until its vendor has answered one (judged or refused), so a rejected key
  costs one call, and up to 4 at a time after that. Once a Run has started, `report.json` is always
  written: `incomplete` and `incompleteReason` (null when complete), and the command exits nonzero
  when it is incomplete. What stopped it stays the reason: errors after it (closing the vendors,
  writing the report) are attached to it; failing to remove the scratch folder is only a warning
  (`scratch-cleanup-failed`).
- **Report:** two tables on stdout and `report.json` with, per Arm, overall, per Image Model and per
  Subject and Image Model: Runs, images, FaceNet best, mean, mean of the Subjects' means (every
  Subject alike, where the mean weighs every image alike), mean of each Run's best (with how many
  Runs it covers in `report.json`), how many pass, images without a face, unreadable images; the
  same four for the second Judge with its failed and skipped judgings; the Arm's spend and the
  evaluation's spend; then the loop's own scores (its Judge's weighted total and SFace Likeness),
  kept apart. Only complete pairs (both Arms of a Subject and Image Model, neither stopped by a
  rejected Judge or Optimizer) are compared
  (`pairs.compared` of `pairs.planned`); every Run is listed and counted in the totals. Spend is
  what the vendors reported; with calls of unknown cost the table adds `~` the committed figure,
  which counts those at their estimate (`committedUsd` in `report.json`; a call can still cost
  more). `report.json` adds the settings, every Run (its id, null when it was never stored; stop
  reason, Iterations, costs, price sources and each Candidate's scores) and the warnings (price
  refresh failures, the Run engine's warnings, the second Judge's). Progress and each Run's
  estimate print as JSON lines on stderr. Below the tables, stdout repeats each `eval-judge-flat`
  warning's message, so a reader of the tables sees it.

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

## Server and container

The server ([`packages/server/src/server.ts`](packages/server/src/server.ts)) is a Bun entrypoint
that mounts, under `/api` through Mastra's Hono adapter, only the Mastra routes a Run needs
(`MOUNTED_ROUTES` in that file: reading workflows and Runs, creating, starting with `start-async`
or `stream`, observing and cancelling a Run), and adds `GET /health`. Mastra's fire-and-forget
`start` (it answers before checking the input), resuming (the Run workflow never suspends),
deleting Runs, time travel, Mastra's restart routes (the server restarts active Runs itself), its
internal routes and the legacy streams are not mounted. It listens at once,
downloads and verifies the face models into the data volume (retrying with backoff from 5 s up
to 5 minutes while that fails, also for failures only the operator can fix, such as a corrupt
file: fix the volume and the server picks it up), then restarts the Runs that were active when
it last stopped. `/health` and every `/api` route answer 503 until the face models are
verified; both name the failure. `/health` names each check (`database`, `faceModels`,
`restarts`). `restarts` is `failed` when listing the active Runs failed or when Mastra couldn't
restart one of them (it names the Run); that reports `"status": "degraded"` but stays 200, since
new Runs still work. A Run that restarted but then failed (e.g. one interrupted while generating,
below) shows in its own state, not here.

### Run it with Docker Compose

```sh
cp .env.example .env   # then set the keys your Runs need; .env is git-ignored and never in the image
docker compose up -d
curl http://127.0.0.1:4111/health
docker compose logs -f # one JSON line per event
```

The first start downloads YuNet and SFace (38.9 MB) into the named volume `iconograph-data`
(`/data` in the container); later starts only re-verify them. The image holds no weights, keys or
data. The volume also holds the Runs database (`iconograph.db`, with Mastra's snapshots),
content-addressed images (`images/`) and the price cache (`prices.db`). Offline machines can copy
the locked weights into the volume's `models/` folder first (see "Model weights").

**Keys** come from `.env` only: the Judge's and the Optimizer's vendor
(`ICONOGRAPH_ANTHROPIC_API_KEY` for the default `anthropic/claude-sonnet-5-5`,
`ICONOGRAPH_OPENAI_API_KEY` for `openai/`, `ICONOGRAPH_GEMINI_API_KEY` for `google/`) and every
Lane's Image Model (`ICONOGRAPH_GEMINI_API_KEY`, `ICONOGRAPH_OPENAI_API_KEY`).

**Only localhost can reach it.** The server listens on `127.0.0.1` by default; outside a
container `ICONOGRAPH_HOST` and `ICONOGRAPH_PORT` change that, and any non-loopback address logs a
warning at boot. Inside the container it must listen on every interface, so `compose.yaml`
publishes the port as `127.0.0.1:4111:4111` (ADR-0012). `compose.yaml` pins `ICONOGRAPH_HOST`,
`ICONOGRAPH_PORT`, `ICONOGRAPH_DATA_DIR` and the telemetry opt-outs in `environment:`, which
Compose gives precedence over `.env`: setting them in `.env` has no effect. To use another host
port, change the left side of `ports:` (e.g. `127.0.0.1:8080:4111`). There is no authentication
yet: **never publish it without `127.0.0.1:`** (e.g. `docker run -p 4111:4111`), which would
expose the server, your Reference Photos and your paid API keys to everyone on your network.

Requests must also be addressed to a loopback name (`localhost`, `127.0.0.1`, `[::1]`), so a web
page can't reach the server by rebinding its own DNS name to your machine. A request whose
`Origin` isn't the server as addressed, or that the browser marks cross-site, is refused, and
requests that change state under `/api` (POST, PUT, PATCH, DELETE) must be `application/json`
(415 otherwise), so a page on another site can't submit a form that starts a paid Run.

**Upgrading:** images are published from `main` as `ghcr.io/stibbons-ai/iconograph:latest` and
`:sha-<commit>`, for linux/amd64 and linux/arm64. `docker compose pull && docker compose up -d`
replaces the container and keeps the volume; Runs that were active restart (except, for now, a
Run interrupted during any Iteration, below). `docker compose up
-d --build` builds from your checkout instead.

### Start a Run through the API

Reference Photos must be files inside the data volume, named relative to it (or absolute under
`/data`); paths with `..`, outside the volume, or symlinks leading out of it are rejected before
anything else happens. Upload routes don't exist yet, so copy photos in:

```sh
docker compose exec iconograph /usr/local/bin/bun -e 'require("fs").mkdirSync("/data/photos")'
docker compose cp me-1.jpg iconograph:/data/photos/me-1.jpg
```

Mastra's workflow routes start Runs. `start-async` checks the input, then answers when the Run
ends, with its result or error. `create-run`, then `stream?runId=` answers at once and streams
the Run's events; `GET /api/workflows/run/runs/RUN_ID` shows its state. A Run starts once:
starting a `runId` again answers 409 while it runs and after it ended. A start that ran nothing
can be retried: one refused with 400 (invalid input to `start-async`), or a `stream` whose input
was refused (it answers 200, and the stream ends with the validation error); retry that one
with `start-async`, since Mastra streams a `runId` only once. The body's `inputData` is the Run
request, with every Target Look facet, every Lane, the Judge, the Optimizer and the stopping rules
given (the API applies no defaults, except a missing `retouching`, which is `"none"` as for Runs
stored before that facet; a Target Look key that is no facet is refused; the CLI's defaults are in
"Runs"). A Lane's `photos` are numbers into the Run's `photos` (from 1), so the data-volume check
covers them too; its `prompt` is the
Prompt's text. The Judge's `weights` must name every Rubric criterion and sum to 1:

```sh
curl -X POST http://127.0.0.1:4111/api/workflows/run/start-async \
  -H 'content-type: application/json' -d '{"inputData": {
    "photos": ["photos/me-1.jpg", "photos/me-2.jpg"], "faceChoices": [], "pins": [],
    "budgetUsd": 0.5, "candidates": 2,
    "lanes": [
      {"model": "gemini-nano-banana-2.1"},
      {"model": "gpt-image-2.5-sunburst", "photos": [2], "prompt": "A head-and-shoulders portrait …"}],
    "judge": {"model": "anthropic/claude-sonnet-5-5", "effort": "low", "weights": {
      "likeness": 0.3, "resemblance": 0.15, "realism": 0.15, "pose": 0.1, "background": 0.08,
      "lighting": 0.08, "hairstyle": 0.07, "clothing": 0.05, "framing": 0.02}},
    "optimizer": {"model": "anthropic/claude-sonnet-5-5", "effort": "medium"},
    "stopRules": {"targetScore": 8.5, "patience": 3, "minImprovement": 0.2, "maxIterations": 8},
    "targetLook": {"pose": "…", "background": "…", "lighting": "…",
      "hairstyle": "as in the Reference Photos", "clothing": "…", "framing": "…",
      "retouching": "…"}}}'
```

A missing key fails the Run with that message before any billable call: the Judge's and (for more
than one Iteration) the Optimizer's before any price lookup, then each Lane's before its own. A
Run interrupted during any Iteration is not resumed yet: Mastra marks the restarted Lane failed
(#35).

The server keeps its Runs in `<data volume>/iconograph.db`, while `bun run run read` defaults to
`./iconograph.db`; to read a server Run from a checkout, pass the volume's database, e.g.
`bun run run read --db .data/iconograph.db --data-dir .data --run-id RUN_ID`.

### Without Docker

`bun run serve` runs the server from source on `127.0.0.1:4111` with the data volume
`ICONOGRAPH_DATA_DIR` (default `./.data`). `bun run build:server` builds what the image ships into
`dist/server`: `server.js`, `smoke.js` and `healthcheck.js` (sharing code chunks), bundled with `onnxruntime-node`,
`sharp`, `libsql` and `libheif-js` external; a production install of only those, generated from
`bun.lock` with their exact versions and integrity hashes and pruned to one platform
(`--os`, `--cpu`, `--libc`; default this machine); and Mastra's model-capability JSON, which
Mastra reads beside its own `package.json`. `bun dist/server/smoke.js` (or, for an image,
`docker run --rm -v "$PWD/.data/models:/data/models:ro" --entrypoint /usr/local/bin/bun IMAGE
/app/smoke.js`) checks that the capabilities resolve, ONNX Runtime loads SFace, `sharp` decodes,
LibSQL opens a file and the HEIC decoder loads.

The image is `gcr.io/distroless/cc-debian13` (glibc, no shell) as the non-root user, with the
`bun` binary, the bundle and the pruned externals: about 202 MB for arm64 and 215 MB for amd64
(measured 2026-11-02), of which the externals are about 66 MB (ADR-0009 estimated ~55 MB before
`libheif-js` joined them, ADR-0012).

## Architecture and schema authority

| Package                | Responsibility                                                                                                                                                                                                                                                                                | Dependencies at the boundary                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `@iconograph/domain`   | Pure Run schemas; Target Look and Prompt; `FaceEmbedder`, `ImageModels`, `Judges` and `Optimizers` seams; Identity Anchor/Ceiling, photo verdicts, Likeness and Candidate Outcomes; character-reference choice; Rubric and stopping rules; Budget arithmetic; price precedence and `Unpriced` | Effect only; no Mastra, storage, or infrastructure                                         |
| `@iconograph/adapters` | Effect-to-Mastra schema helper; LibSQL storage and Run tables; model weights; YuNet/SFace via ONNX; Reference Photo decoding and storage; content-addressed images; LiteLLM price source; Gemini Interactions adapter                                                                         | Effect, Mastra core and LibSQL adapter, libsql client, onnxruntime-node, sharp, libheif-js |
| `@iconograph/server`   | Run workflow (prepare → Lanes → finish; a Lane repeats its Iteration step — generate, score, judge, optimize — until a stopping rule fires), the Judge and Optimizer agents, the Run CLI and the HTTP server (Mastra routes via Hono, `/health`)                                              | Domain and adapters; Mastra owns durable execution                                         |

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
