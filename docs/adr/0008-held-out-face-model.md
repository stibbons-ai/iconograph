---
title: "Two face models: one the loop optimizes against, one held out"
status: accepted
date: 2026-10-30
---

# Two face models: one the loop optimizes against, one held out

Likeness inside the loop is measured with SFace; finalists are additionally scored with FaceNet (Inception-ResNet-v1 trained on VGGFace2, MIT code, weights MIT by inheritance), which the Optimizer never sees. An optimization loop drifts toward whatever its scorer rewards, so a second model with a different architecture, training set and loss is the cheapest check that a high Likeness is real identity rather than scorer overfitting; disagreement marks a finalist "Likeness Unconfirmed".

## Consequences

- FaceNet needs a different crop than SFace (square margin crop at 160×160, no 5-point template); the two pipelines share only detection.
- No official ONNX export exists; we export it ourselves and never commit weights to git.
- Thresholds differ per model and are recalibrated on real pairs with `faces:calibrate`. Calibrated in issue #11 on 5 Subjects (8 photos each, 39 same and 156 different anchor pairs): SFace Identity Gate 0.40 (no errors; different ≤ 0.38, same ≥ 0.43), single-photo Ceiling 0.66 (median of per-Subject Ceilings 0.47–0.70), FaceNet 0.52 (no errors; different ≤ 0.50, same ≥ 0.55; 0.70 rejected 7.7% of real matches). Margins are about 0.03 on each side, and no labelled Candidates were included yet.

Amended by [ADR-0011](0011-facenet-weights-built-locally.md), which corrects "weights MIT by inheritance" and records the local build.
