---
title: "A Lane loops over one Iteration step, not a nested Iteration workflow"
status: accepted
date: 2026-11-03
---

# A Lane loops over one Iteration step, not a nested Iteration workflow

A Lane is a nested Mastra workflow that repeats a single `iteration` step with `dountil` until the step gives the Lane a stop reason; the step's Effect program runs the Iteration's phases in order (generate → score → judge → optimize). We chose this over looping a nested Iteration workflow with one Mastra step per phase, which would show each phase in Mastra's snapshots and streams, because Mastra 1.80 runs every pass of a loop over a nested workflow under the enclosing workflow's run id (outside `foreach`, a nested workflow gets no run id of its own): from the second pass on, the stored run of that id is already `success`, so cancelling the Run leaves that pass's steps running and their vendor calls unaborted (`Run.cancel` returns early for a run that reached a terminal status). In `@mastra/core` 1.80's `dist/agent-*.js`: the nested run id is minted only under `foreach`, `createRun` adopts the stored status, and `Run.cancel` checks `hasReachedTerminalStatus()` first.

## Consequences

- Durability doesn't depend on the step boundary: every phase finds what an earlier, interrupted execution stored (Candidates, outcomes, judgements, the next Iteration's Prompt, the Lane's stop reason, numbered calls), so a call whose result was stored is never made again; one whose call ran but whose result was lost is made again, under the next attempt number, and billed again. The loop's state between passes is the small `LaneState` (ids, the Lane's model, Iteration number, stop reason).
- Cancelling is recorded by the Run workflow's `onFinish` hook, not by the step: it marks every Lane without a stop reason `cancelled`, so a cancel during preparation, between passes, or with Lanes still waiting their turn stops them too. Closing the application waits up to 5 s for those recordings; a report of a Run Mastra stored as cancelled shows Lanes whose recording was cut off as `cancelled`.
- Mastra's snapshots and streams show Iterations, not their phases; per-phase progress events, if wanted, are written from inside the step.
- Revisit when Mastra gives each pass of a nested-workflow loop its own run id, or cancels it through the parent's signal.
