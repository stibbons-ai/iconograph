---
title: "Bun catalogs centralize dependency versions"
status: accepted
date: 2026-11-01
---

# Bun catalogs centralize dependency versions

Third-party dependency versions are declared in the root `package.json`'s `catalog`. Root and workspace package manifests use `catalog:` references instead of repeating version constraints. Dependencies between local packages continue to use `workspace:*`.

This gives shared dependencies one version source and makes upgrades a root-catalog change, avoiding version drift between packages. The catalog may contain exact versions or ranges; it centralizes the chosen constraints rather than changing their meaning. `bun.lock` continues to record resolved versions.

The tradeoff is that packages share the root catalog's constraints rather than choosing versions independently. This fits the monorepo's coordinated dependency upgrades and Bun runtime.
