---
title: "Natural professional retouching by default; Rubric v2"
status: accepted
date: 2026-11-05
---

# Natural professional retouching by default; Rubric v2

The first full live eval (PR #44) made the Subject look clearly older than in person, with real, somewhat yellow teeth: the initial Prompt forbade any retouching ("Do not idealise, beautify or change their face", "natural skin texture"), image models read that as "show every line", and the Optimizer amplified it. A professional photographer would retouch both lightly. A Prompt-only fix would not hold, because Rubric v1 punishes retouching: its Resemblance level 4 names "slightly idealised or smoothed" and its Realism asks for a real, unedited photograph, so lighter skin or brighter teeth would score lower and the Optimizer would steer back to the aged look.

We therefore add a Target Look facet, `retouching`, and a Rubric v2 that judges against it (issue #46):

- **Facet.** Its default (`DEFAULT_TARGET_LOOK.retouching` in `packages/domain/src/target-look.ts`) is natural professional retouching: the Subject at their real age as in the Reference Photos, never older and never younger (younger is what gives a retouched photo away), with skin and teeth lightly retouched. The operator can replace it, e.g. with `"none"`. Identity stays the hard limit: retouching never changes facial features, face shape, distinctive marks, or the beard and hair colour, including any grey (unless the Hairstyle facet asks otherwise). The initial Prompt states this and adds a `Retouching:` line.
- **Rubric v2.** Resemblance treats apparent age older or younger than in the Reference Photos as a difference, and so is retouching beyond what the facet allows (e.g. any smoothing or whitening when it says none); retouching within the facet is none. Changed features, a changed face shape or obviously younger skin still count. Realism asks for a real professional photograph, not an unedited one, and names visible over-editing (fake-white or uniform teeth, plastic or airbrushed skin, a younger-looking face) as an artefact. The facet criteria, the level-to-score mapping and the Disputed gap are v1's. Rubric v1 stays unchanged, so stored v1 judgements still read and are checked by v1's rules.
- **No new judged criterion.** The facet is judged through the Resemblance and Realism anchors rather than a `retouching` criterion with its own weight. A new criterion would change `JUDGED_CRITERIA` and `DEFAULT_WEIGHTS` and invalidate every explicit weights configuration (each must name every criterion); the anchors already cover what retouching gets wrong (age, identity, over-editing).

## Consequences

- A Run stored before the facet existed has no `retouching` key. The stored Target Look schema decodes it as `"none"`, not the new default, because those Runs were generated and judged without retouching; the same holds for the API, where a request without `retouching` gets `"none"`. Since a missing key is then valid, the API refuses a Target Look key that is no facet, so a misspelled `retouching` can't pass as a missing one. Operator input (`--look`, the eval's `look.json`) takes the natural-professional default and rejects unknown keys too.
- A Run keeps its Rubric. A Run started under `rubric-v1` that still has Iterations to run fails its next Iteration before any image is generated (naming the recorded and current versions); its stored scores still read and report. Judging old Runs with their recorded Rubric is out of scope.
- New Runs and the eval's Second Judge judge with `rubric-v2`, so their scores are not comparable with `rubric-v1` scores.
- Follow-up: the default `lighting` facet could be made explicitly flattering (soft, wrap-around light rather than light that brings out texture); decide by the live before/after eval, which is its own issue.
