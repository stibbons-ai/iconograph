# /// script
# requires-python = "==3.12.*"
# dependencies = [
#   "facenet-pytorch==2.6.0",
#   "torch==2.2.2",
#   "torchvision==0.17.2",
#   "numpy==1.26.4",
#   "pillow==10.2.0",
#   "onnx==1.16.2",
#   "onnxruntime==1.19.2",
# ]
# [tool.uv]
# exclude-newer = "2026-10-01T00:00:00Z"
# # Linux x64 resolves CUDA builds from PyPI (torch plus ~12 nvidia-* wheels, several GB);
# # the export runs on CPU, so take the CPU-only builds there. macOS and Linux arm64 PyPI
# # wheels are CPU-only already.
# [tool.uv.sources]
# torch = [{ index = "pytorch-cpu", marker = "sys_platform == 'linux' and platform_machine == 'x86_64'" }]
# torchvision = [{ index = "pytorch-cpu", marker = "sys_platform == 'linux' and platform_machine == 'x86_64'" }]
# [[tool.uv.index]]
# name = "pytorch-cpu"
# url = "https://download.pytorch.org/whl/cpu"
# explicit = true
# ///
"""Export the held-out FaceNet model (ADR-0008, ADR-0011) to ONNX, reproducibly.

Model: facenet-pytorch's InceptionResnetV1(pretrained="vggface2"), the PyTorch port of
davidsandberg/facenet 20180402-114759 (Inception-ResNet-v1 trained on VGGFace2).

Graph contract (what `@iconograph/adapters` feeds and reads):
  input  "input"     float32 [N, 3, 160, 160], RGB, already normalised as (x - 127.5) / 128
  output "embedding" float32 [N, 512], L2-normalised in-graph (with classify=False,
                     facenet-pytorch's forward ends in F.normalize)

Operators don't run this directly: `bun run models:export-facenet` runs it into the models
folder and installs the file only if its SHA-256 matches the `facenet` entry of
packages/adapters/models.lock.json. By hand (needs uv; Python and every dependency are pinned
above, transitive ones frozen by exclude-newer):

  uv run scripts/export-facenet.py OUTPUT.onnx

We choose not to redistribute the weights or the export (ADR-0011), so every operator and CI
builds it here; never commit it (.gitignore has *.onnx). The upstream .pt URL, SHA-256 and size
come from the lock entry's `build.source`. The .pt is downloaded once into
~/.cache/iconograph/facenet-export/checkpoints/ (override the parent folder with
FACENET_EXPORT_CACHE) and verified before PyTorch loads it. The export is byte-identical on
macOS arm64 and Linux x64/arm64, which is what lets the lock pin its SHA-256.

The script checks parity (ONNX Runtime vs PyTorch on fixed seeded inputs in [-127.5/128,
127.5/128]), fails when the max absolute difference exceeds PARITY_TOLERANCE (or is NaN) or an
output is not unit length, and prints the ONNX file's SHA-256 and size.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import urllib.request
from pathlib import Path

LOCK = Path(__file__).resolve().parent.parent / "packages" / "adapters" / "models.lock.json"
# The file name facenet-pytorch's load_weights looks for in TORCH_HOME/checkpoints.
CHECKPOINT_NAME = "20180402-114759-vggface2.pt"
OPSET = 17
INPUT_SIZE = 160
EMBEDDING_SIZE = 512
PARITY_TOLERANCE = 1e-4
DOWNLOAD_TIMEOUT_SECONDS = 60


def sha256_of(path: Path) -> str:
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def fetch_weights(torch_home: Path) -> None:
    """Place verified weights where facenet-pytorch's load_weights looks (TORCH_HOME/checkpoints)."""
    lock = json.loads(LOCK.read_text())
    (entry,) = (model for model in lock["models"] if model["id"] == "facenet")
    source = entry["build"]["source"]
    if Path(source["url"]).name != CHECKPOINT_NAME:
        sys.exit(f"the lock's source must be {CHECKPOINT_NAME}, or facenet-pytorch downloads its own")
    target = torch_home / "checkpoints" / CHECKPOINT_NAME
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        partial = target.with_suffix(".part")
        print(f"downloading {source['url']}", file=sys.stderr)
        with urllib.request.urlopen(source["url"], timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
            with partial.open("wb") as file:
                shutil.copyfileobj(response, file)
        partial.rename(target)
    actual = sha256_of(target)
    size = target.stat().st_size
    if actual != source["sha256"] or size != source["size"]:
        target.unlink()
        sys.exit(
            f"weights checksum mismatch: expected {source['sha256']} ({source['size']} bytes), "
            f"got {actual} ({size} bytes); deleted {target}"
        )


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("usage: uv run scripts/export-facenet.py OUTPUT.onnx")
    output = Path(sys.argv[1]).resolve()
    torch_home = Path(
        os.environ.get("FACENET_EXPORT_CACHE", "~/.cache/iconograph/facenet-export")
    ).expanduser().resolve()
    fetch_weights(torch_home)
    # facenet-pytorch resolves its checkpoint directory from TORCH_HOME; the file is already there
    # and verified, so InceptionResnetV1 never downloads anything itself.
    os.environ["TORCH_HOME"] = str(torch_home)

    import numpy as np
    import onnx
    import onnxruntime as ort
    import torch
    from facenet_pytorch import InceptionResnetV1

    torch.manual_seed(0)
    torch.use_deterministic_algorithms(True)
    model = InceptionResnetV1(pretrained="vggface2", classify=False).eval()

    dummy = torch.zeros(1, 3, INPUT_SIZE, INPUT_SIZE, dtype=torch.float32)
    output.parent.mkdir(parents=True, exist_ok=True)
    with torch.no_grad():
        torch.onnx.export(
            model,
            dummy,
            str(output),
            export_params=True,
            opset_version=OPSET,
            do_constant_folding=True,
            # PRESERVE keeps the BatchNormalization nodes (the model is in eval mode, so they
            # export with training_mode=0 and constant folding leaves their parameters alone).
            # EVAL would fold them into the convolutions in float32, whose rounding differs
            # between macOS arm64 and Linux x64 and breaks the byte-identical, hash-locked export.
            training=torch.onnx.TrainingMode.PRESERVE,
            input_names=["input"],
            output_names=["embedding"],
            dynamic_axes={"input": {0: "batch"}, "embedding": {0: "batch"}},
        )
    onnx.checker.check_model(str(output), full_check=True)

    # Parity on fixed inputs spanning the normalised range plus its two extremes.
    rng = np.random.default_rng(20180402)
    inputs = np.concatenate(
        [
            rng.uniform(-127.5 / 128, 127.5 / 128, size=(4, 3, INPUT_SIZE, INPUT_SIZE)),
            np.full((1, 3, INPUT_SIZE, INPUT_SIZE), -127.5 / 128),
            np.full((1, 3, INPUT_SIZE, INPUT_SIZE), 127.5 / 128),
        ]
    ).astype(np.float32)
    with torch.no_grad():
        expected = model(torch.from_numpy(inputs)).numpy()
    session = ort.InferenceSession(str(output), providers=["CPUExecutionProvider"])
    (actual,) = session.run(["embedding"], {"input": inputs})
    if actual.shape != (len(inputs), EMBEDDING_SIZE):
        sys.exit(f"unexpected output shape {actual.shape}")
    norms = np.linalg.norm(actual, axis=1)
    max_diff = float(np.max(np.abs(actual - expected)))
    print(f"parity: max abs diff {max_diff:.3e} over {len(inputs)} inputs (bound {PARITY_TOLERANCE:.0e})")
    print(f"output norms: min {norms.min():.6f} max {norms.max():.6f}")
    if not (max_diff <= PARITY_TOLERANCE) or not np.allclose(norms, 1.0, atol=1e-5):
        sys.exit("parity check failed")

    print(f"file: {output}")
    print(f"sha256: {sha256_of(output)}")
    print(f"size: {output.stat().st_size}")


if __name__ == "__main__":
    main()
