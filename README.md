# Iconograph

A Bun workspace proving a persistent, model-free **Run** workflow before image-product work.
There are no provider credentials, model calls, headshot processing, UI, or production deployment in
this milestone.

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

A task runs `bun install --frozen-lockfile` before shell entry. All direct dependencies are
exact-pinned and `bun.lock` records the transitive graph. A failed install task does **not**
guarantee that devenv refuses to open the shell: inspect the task output and resolve any install
failure before running workspace commands. To retry manually inside the shell:

```sh
bun install --frozen-lockfile
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
Formatting, linting, typechecking, and licence auditing use plain commands; `check` composes the
scripts and finishes with `bun run test`. Outside the shell, set both variables when invoking Bun
or Mastra directly instead of the runtime/evaluation/test scripts.

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
bun run check         # format check → lint → typecheck → licences → bun run test
```

The database's parent directory must already exist. The default Run database is `./iconograph.db`;
local database files and their WAL/shared-memory companions are gitignored. Without `--db`, the
evaluation harness uses an isolated temporary database and removes it afterwards. CLI success is
JSON on stdout; failures are JSON on stderr and exit nonzero. The tracer returns the message and
its JavaScript string length (**UTF-16 code units**, not Unicode graphemes).

CI is independent of Nix, devenv, and direnv: it installs Bun directly and explicitly sets
`MASTRA_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1` for all steps. It uses a frozen install, explicitly
runs `bun test`, and runs the complete `bun run check` on Linux and macOS. Native optional
dependencies are therefore audited on both hosts. Formatting commands name the files/directories
authored for this milestone rather than formatting unrelated existing domain/ADR drafts. Add
future adopted documentation deliberately to that target list.

## Architecture and schema authority

| Package                    | Responsibility                                               | Dependencies at the boundary                       |
| -------------------------- | ------------------------------------------------------------ | -------------------------------------------------- |
| `@iconograph/domain`       | Pure Run input/output Effect schemas                         | Effect only; no Mastra, storage, or infrastructure |
| `@iconograph/adapters`     | The one Effect-to-Mastra schema helper; local LibSQL storage | Effect, Mastra core and LibSQL adapter             |
| `@iconograph/server`       | Trivial Run workflow and persistent CLI                      | Domain and adapters; Mastra owns durable execution |
| `@iconograph/eval-harness` | Runnable local evaluation fixtures                           | Domain and server; no provider credentials         |

**Effect Schema is the single schema source.** Mastra is the single durable workflow engine; LibSQL
stores its snapshots. Zod exists transitively in Mastra's dependency graph but is not an independent
domain validator. Workflow boundaries decode untrusted input and step output explicitly with Effect,
so invalid values produce Effect validation details rather than silently bypassing schema rules.

### Current API compatibility

The installed pins are `effect@4.1.1`, `@mastra/core@1.80.0`, and `@mastra/libsql@1.27.1` (not a
historical Mastra API or an Effect 3 compatibility layer). In Effect 4.1.1,
`Schema.toStandardSchemaV1` and `Schema.toStandardJSONSchemaV1` return wrappers/clones; they do not
mutate the source schema. The adapter composes both capabilities and caches one composed wrapper
per schema. Existing draft ADR text describing mutation is not an accurate description of this
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
requests.

`bun run licenses` reads actual installed package manifests across the full runtime **and**
development graph, including nested installs, scopes, symlinks, and Bun's isolated `.bun` store.
It also checks the committed lockfile so a missing host-compatible package cannot turn into a
successful partial audit. Packages omitted because of another OS/CPU are audited offline using
reviewed entries in `scripts/platform-license-metadata.json`. Each entry records the exact package
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
current exception is `spdx-exceptions@2.5.0`'s CC-BY-3.0 SPDX identifier data, with attribution in
[`THIRD_PARTY_NOTICES`](THIRD_PARTY_NOTICES). Do not add an exception merely to make CI pass: inspect
the installed licence text and upstream terms first, and retain required notices on redistribution.

Mastra's package-level Apache-2.0 metadata explicitly excludes **every `ee/` directory**. Oxlint's
`no-restricted-imports` blocks enterprise roots and deep/relative `ee` segments in static imports,
re-exports, type imports and string-literal dynamic imports. This rule does not resolve computed
module names or CommonJS `require` calls; the workspace uses ES modules, and enterprise imports
must not be disguised through runtime loading. The domain lint boundary additionally rejects
Mastra, LibSQL, Node and infrastructure-package imports; its manifest declares Effect only.
