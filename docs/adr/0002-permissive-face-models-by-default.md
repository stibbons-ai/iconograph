---
title: "Permissively licensed face models by default; InsightFace is opt-in"
status: accepted
date: 2026-10-30
---

# Permissively licensed face models by default; InsightFace is opt-in

The default face backend is OpenCV's YuNet detector (MIT) and SFace recognizer (Apache-2.0), downloaded on first use into the data volume, verified against a lock manifest. InsightFace's `buffalo_l` weights, used by the original prototype, are licensed for non-commercial research only (the code is MIT, the weights are not), so they are an opt-in backend that the operator downloads themselves after a licence notice. A self-hoster using Iconograph commercially must never be put in breach of a licence without knowing it.

## Consequences

SFace is weaker than `buffalo_l` (LFW 99.40% vs ~99.8%) and its similarity scale differs (same-person threshold ~0.36–0.41 vs ~0.45), so the Identity Gate and identity scaling are configured per face backend, never hard-coded.
