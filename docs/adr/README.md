# Architecture decision records

This directory records architectural decisions and their rationale. This README is the authoritative ADR frontmatter specification and template; it is not an ADR and is exempt from validation.

## Files and frontmatter

Place ADRs directly in `docs/adr/`, without nested directories. Use a four-digit number and a lowercase, hyphen-separated slug: `NNNN-lowercase-slug.md` (for example, `0001-workflow-owns-control-flow.md`). Markdown files with malformed ADR filenames fail validation rather than being silently skipped.

Each ADR starts with a YAML mapping between `---` delimiters. Only the following keys are allowed:

| Variable     | Required | Value and meaning                                                                                                                                                                                               |
| ------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`      | Yes      | A nonblank, single-line string matching the first body H1's plain text, ignoring inline Markdown formatting and decoding entities. Quote titles to protect punctuation such as colons from YAML interpretation. |
| `status`     | Yes      | One of `proposed`, `accepted`, `deprecated`, or `superseded`; see below.                                                                                                                                        |
| `date`       | Yes      | A real calendar date in `YYYY-MM-DD` form: when the decision was first recorded, not its latest edit, acceptance, or implementation date.                                                                       |
| `supersedes` | No       | A YAML list of existing ADR basenames replaced by this decision. Omit it or use `[]` when there are none.                                                                                                       |
| `amends`     | No       | A YAML list of existing ADR basenames adjusted by this decision without replacing them. Omit it or use `[]` when there are none.                                                                                |

Malformed or ambiguous YAML, duplicate keys, unknown keys, invalid value types, and missing required values fail validation. Relationship values must be filenames including `.md`, not paths, ADR numbers, or URLs. They must refer to existing ADRs, must not refer to the current ADR, must not contain duplicates, and must not appear in both relationship lists. Do not infer relationships merely because another ADR is mentioned in the prose.

### Status meanings

- `proposed`: recorded for discussion, not yet adopted.
- `accepted`: adopted as an architectural decision; this does not assert that every consequence has been implemented.
- `deprecated`: no longer recommended, without necessarily naming a replacement.
- `superseded`: replaced by another decision. The replacement records the relationship in its `supersedes` list.

The original nine decisions are `accepted` and dated `2026-10-30`, their first Git recording (`f15a5f2`). Their historical prose remains intact, including ADR 0006's schema guidance; frontmatter migration does not resolve historical discrepancies or assert implementation completeness.

## Template

The following is a conceptual template. Replace the title and date with the actual decision title and first-recorded date, choose its status, and use the same title in the body H1. The sample values are valid YAML, not literal angle-bracket placeholders.

```markdown
---
title: "A concise statement of the architectural decision"
status: proposed
date: 2026-11-01
---

# A concise statement of the architectural decision

Explain the decision and why it was made. Include context, alternatives, and
consequences where useful; no particular body sections are required.
```

For a new ADR that genuinely replaces one existing decision and adjusts another, optional relationships look like this (the referenced basenames must exist, and neither may be the new ADR itself):

```yaml
supersedes:
  - 0001-workflow-owns-control-flow.md
amends:
  - 0007-bun-runtime.md
```

This example illustrates syntax only; it does not assert those relationships for any existing decision.

## Validation

```sh
bun run adrs:check                # Validate the full worktree ADR collection.
bun scripts/check-adrs.ts         # The same full-collection validator directly.
bun scripts/check-adrs.ts --staged # Validate changed ADR snapshots in the index.
bun run check                     # Includes the full ADR check (also used by CI).
bun run hooks:install             # Install the repository-local pre-commit hook.
```

The pre-commit hook runs `--staged`: it checks added, copied, modified, and renamed ADRs using their staged contents, and resolves references against the staged ADR inventory. Unstaged edits do not change the result. Deletions are ignored, `docs/adr/README.md` is exempt, and initial commits without `HEAD` are supported. Full validation checks the worktree collection instead. Ordinary local Git hooks can be bypassed; the full check in CI is independent of that local hook.
