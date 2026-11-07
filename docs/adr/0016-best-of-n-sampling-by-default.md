---
title: "Best-of-N sampling with a good Judge by default; the Optimizer is experimental"
status: accepted
date: 2026-11-07
---

# Best-of-N sampling with a good Judge by default; the Optimizer is experimental

The MVP spec (#1) built the product around the Optimizer loop: each Lane's Optimizer rewrites the Prompt between Iterations from that Lane's own Prompt history and the operator's Steering. Milestone 0 (#14) had to show first that this loop beats resampling the starting Prompt at the same Budget; if it didn't, the product would simplify to best-of-N sampling with a good Judge. The eval harness (#12, PR #44) answered it with live vendors: per Subject and Image Model, an Optimizer Arm and a Resample Arm with the same Budget, scored by the held-out face model (FaceNet) and a Second Judge.

We decided no-go for the Optimizer loop as the product default (maintainer, 2026-11-07, #14). The default Lane is a Resample Lane: it sends the Prompt built from the Target Look every Iteration and the Judge picks among the Candidates, so a Run is best-of-N sampling with a good Judge. The Optimizer (the Optimizer loop, Steering into Prompts, and the per-Lane Prompt history it learns from) stays as an experimental option the operator turns on per Lane; it is not deleted.

## Evidence

Three runs on two consenting Subjects (`daniel`, `nelia`), all `--target-score 10 --max-iterations 8`, so the Budget or the Iteration limit, not the target, ended the Runs:

- **Run A**, both Image Models, Budget $1.50, Second Judge `openai/gpt-5.5`: on Gemini no gain on either measure (`daniel` best per Run 9.46 vs 9.46 on the Second Judge, mean 9.12 vs 9.12).
- **Run B**, Sunburst, Budget $3: the Optimizer won the Second Judge (mean 8.85 vs 8.41, best per Run 9.46 vs 8.82), but that Judge came from Sunburst's vendor, and `daniel`'s Reference Photos mixed two looks; the Optimizer committed to one, and its mean FaceNet similarity on `daniel` fell to 0.868 vs 0.941.
- **Decision run**, Sunburst, Budget $3, Second Judge `google/gemini-3.1-pro-preview`, `daniel` with only the 3 photos of his current look. The rule, fixed before the run: go only if, for both Subjects, the Optimizer's best image per Run scores at least 0.3 higher on the Second Judge and its mean FaceNet similarity is at most 0.03 lower. `daniel` passed (+1.42, −0.014); `nelia` failed (+0.00). No-go.

Across the three runs:

- FaceNet, which doesn't depend on any Judge: Resample's best similarity per Run was equal or higher in all eight Optimizer/Resample pairs, its mean in seven (the exception: `daniel` on Gemini in Run A, 0.800 vs 0.789).
- The Optimizer's quality gains appeared only with a confounder: the same-vendor Second Judge, or `gemini-3.1-pro-preview`, which barely discriminates. In the decision run it gave 66 of 68 images exactly 7.50 (level 4 on every criterion); #50 re-ran the same set and confirmed it flat (54 of 67 at 7.50).
- The loop's own Judge favoured the Optimizer more than either independent measure (best per Run 9.35 vs 8.99 in Run B), consistent with the loop fitting its own Judge.
- Newer model versions (#52) don't change this: the FaceNet evidence is Judge-independent, and an OpenAI Second Judge stays same-vendor for Sunburst.

## Consequences

- The MVP builds best-of-N by default: per Lane, Candidates from the Target Look's Prompt every Iteration, the Identity Gate, Likeness and the Judge, the Playoff and the Pick. Iterations only add Candidates, so a Lane normally ends on the Budget, the target score or the Iteration limit; patience is off for Resample Lanes, as it was for the Resample Arm, because a fixed Prompt never tries to improve.
- Without the Optimizer, Likeness and the Judge's scores are all that choose among Candidates, so the Judge's quality decides the product's: a flat Judge (the eval harness warns about one since #50) leaves best-of-N choosing by Likeness alone, and Judge Calibration matters more.
- Experimental, opt-in per Lane: the Optimizer and its reasoning effort, Steering into Prompts (stars, vetoes and notes the Optimizer considers), Prompt diffs between Iterations, and refusals fed to the Optimizer. A Run without an optimizing Lane needs no Optimizer key or price, as today.
- The code still defaults to an optimizing Lane (a Lane request opts into a Resample Lane with `resample: true`); flipping the default is implementation work under #1. The eval harness keeps both Arms; it is how the experimental Optimizer is measured.
- Reopen when a blind human pairwise rating of Optimizer vs Resample images clearly prefers the Optimizer's.
