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
- Thresholds differ per model (SFace Identity Gate 0.40; FaceNet starts at 0.70) and are recalibrated on real pairs.

Amended by [ADR-0011](0011-facenet-weights-built-locally.md), which corrects "weights MIT by inheritance" and records the local build.
