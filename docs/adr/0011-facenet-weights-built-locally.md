---
title: "FaceNet weights are built locally, never redistributed"
status: accepted
date: 2026-11-01
amends:
  - 0008-held-out-face-model.md
---

# FaceNet weights are built locally, never redistributed

ADR-0008 described the held-out FaceNet weights as "MIT by inheritance". The code is MIT (facenet-pytorch, © 2019 Timothy Esler; davidsandberg/facenet, © 2016 David Sandberg). Both repositories are MIT and state no separate terms for the 20180402-114759 weights they publish. The weights were trained on VGGFace2, whose terms we checked on 2026-11-01 (archived copies; the live page no longer offers the data):

- The 2019 dataset page: "available to download for commercial/research purposes under a Creative Commons Attribution-ShareAlike 4.0 International License. The copyright remains with the original owners of the image."
- Its licence file: "covered under a Creative Commons Attribution 4.0 International license" and "Downloading this dataset implies agreement to follow the same conditions for any modification and/or re-distribution of the dataset in any form", with a request to cite Cao et al., arXiv 1710.08092.
- Oxford VGG has since withdrawn the download links.

Nothing we found restricts commercial use. But the two statements disagree, the images were scraped from the web and "the copyright remains with the original owners of the image", and whether attribution or share-alike terms reach trained weights is unsettled. So we choose never to redistribute the FaceNet weights or our ONNX export: no release asset, no model hub, no mirror.

## Consequences

- Each operator, and CI, builds the ONNX locally with `bun run models:export-facenet`, which runs `scripts/export-facenet.py` (uv, pinned Python and PyTorch; CPU-only PyTorch on Linux x64) from the upstream facenet-pytorch weights, verified by SHA-256.
- The model lock gains a "built" entry kind: no download URL, the upstream source and build command instead, and the SHA-256 and size of the expected export. `models:fetch` skips it; using the model without the file fails with the build command, and a changed file fails verification.
- Pinning the export's SHA-256 relies on a byte-identical export across platforms. It is on macOS arm64 and Linux x64 and arm64, because BatchNorm stays unfused (folding it into the convolutions in float32 rounds differently per platform).
- Operators need uv once. Measured on 2026-11-01: on macOS arm64 the Python packages download about 110 MB and take about 540 MB installed; on Linux x64 (CPU-only PyTorch) about 280 MB to download and 1.8 GB in uv's cache; plus the 112 MB upstream weights and the 94 MB export. CI caches the built file keyed on the lock and the export script. `bun run check` itself never runs Python.
- THIRD_PARTY_NOTICES records the code and weight licences, the VGGFace2 terms as quoted, and that the weights are not redistributed.
