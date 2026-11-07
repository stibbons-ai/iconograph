## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for stibbons-ai/iconograph (via `gh`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.

Third-party versions: root `catalog`; manifests use `catalog:`.

## Vendored Repositories

External repos vendored under `vendor/` as squashed git subtrees (`vendor-repos` skill):
- vendor/effect: https://github.com/Effect-TS/effect.git @ effect@4.1.2

- Read them as reference: when using one of these libraries, check its source, tests and examples for idiomatic usage before guessing or searching the web.
- Import from the normal package dependency; `vendor/` is read-only reference, edited only on explicit request.
- When writing Effect code, read `vendor/effect/LLMS.md` first, then `vendor/effect/packages/effect/` (source, tests) for idiomatic patterns; it is the source of truth for Effect 4.
- agent-patterns/: per-module pattern notes; read the matching one before writing code with that module.
