"""
Iterative prompt optimization for AI profile photos.

Loop per iteration and per provider (Gemini, OpenAI):
  1. generate N candidates from the reference photos + current prompt
  2. score each candidate:
       - identity: ArcFace cosine similarity vs. reference photos (objective, cheap)
       - rubric:   LLM judge (third-party model, avoids self-preference bias)
  3. keep the best candidate, let an optimizer LLM rewrite the prompt from the judge feedback
  4. stop on target score or after PATIENCE iterations without improvement

Requirements:
  pip install google-genai openai anthropic insightface onnxruntime opencv-python numpy
  env: GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY
"""

import base64
import json
import re
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import anthropic
import cv2
import numpy as np
from google import genai
from insightface.app import FaceAnalysis
from openai import OpenAI

# ---------------------------------------------------------------- config

REF_DIR = Path("refs")
OUT_DIR = Path("runs") / time.strftime("%Y%m%d-%H%M%S")
MAX_ITERATIONS = 8
CANDIDATES_PER_ITERATION = 3
PATIENCE = 3
TARGET_SCORE = 9.0
IDENTITY_GATE = 0.45  # ArcFace cosine below this = different person, reject outright

GEMINI_MODEL = "gemini-nano-banana-2.1"
OPENAI_IMAGE_MODEL = "gpt-image-2.6-sunburst"
JUDGE_MODEL = "claude-opus-5-5"

# Target look; the judge scores against this, the optimizer may only refine wording, never change it
TARGET_SPEC = {
    "pose": "head and shoulders, torso turned ~20 degrees, face toward camera, slight natural smile",
    "background": "soft out-of-focus neutral grey studio background, no objects",
    "colors_lighting": "natural skin tones, soft key light from the left, gentle fill, no color cast",
    "hairstyle": "same hairstyle as in the reference photos, neatly groomed",
    "clothing": "dark navy blazer over a plain white shirt, no tie",
    "framing": "square 1:1, eyes at upper third, suitable for a LinkedIn circle crop",
}

# Weights for the final score; identity dominates
WEIGHTS = {
    "identity": 0.40,
    "pose": 0.10,
    "background": 0.10,
    "colors_lighting": 0.10,
    "hairstyle": 0.10,
    "clothing": 0.05,
    "realism": 0.15,
}

INITIAL_PROMPT = (
    "Create a professional corporate headshot of the person shown in the reference photos. "
    "Preserve their exact facial identity: face shape, eyes, nose, mouth, skin texture, "
    "moles, eyebrows and hairline must stay identical. Do not beautify or slim the face. "
    + " ".join(f"{k.replace('_', ' ').capitalize()}: {v}." for k, v in TARGET_SPEC.items())
    + " Photorealistic, shot on a full-frame camera with an 85mm lens at f/2.8."
)

# ---------------------------------------------------------------- clients

gemini_client = genai.Client()
openai_client = OpenAI()
judge_client = anthropic.Anthropic()

face_app = FaceAnalysis(name="buffalo_l", allowed_modules=["detection", "recognition"])
face_app.prepare(ctx_id=-1, det_size=(640, 640))  # ctx_id=0 for GPU


# ---------------------------------------------------------------- helpers

def mime_of(path: Path) -> str:
    return "image/png" if path.suffix.lower() == ".png" else "image/jpeg"


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("utf-8")


def face_embedding(image_bytes: bytes) -> np.ndarray | None:
    img = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR)
    faces = face_app.get(img)
    if not faces:
        return None
    largest = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
    return largest.normed_embedding


def extract_json(text: str) -> dict:
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        raise ValueError(f"No JSON found in: {text[:200]}")
    return json.loads(match.group(0))


# ---------------------------------------------------------------- generators

def generate_gemini(prompt: str, refs: list[Path]) -> bytes:
    # Nano Banana 2.1 keeps character consistency for up to 4 person references
    blocks = [{"type": "text", "text": prompt}]
    for ref in refs[:4]:
        blocks.append({"type": "image", "data": b64(ref.read_bytes()), "mime_type": mime_of(ref)})
    interaction = gemini_client.interactions.create(
        model=GEMINI_MODEL,
        input=blocks,
        response_format={"type": "image", "mime_type": "image/png", "aspect_ratio": "1:1", "image_size": "2K"},
        generation_config={"thinking_level": "high"},
    )
    return base64.b64decode(interaction.output_image.data)


def generate_openai(prompt: str, refs: list[Path]) -> bytes:
    files = [open(ref, "rb") for ref in refs[:16]]
    try:
        result = openai_client.images.edit(
            model=OPENAI_IMAGE_MODEL,
            image=files,
            prompt=prompt,
            size="2048x2048",
            quality="high",
            output_format="png",
        )
    finally:
        for f in files:
            f.close()
    return base64.b64decode(result.data[0].b64_json)


GENERATORS = {"gemini": generate_gemini, "openai": generate_openai}


# ---------------------------------------------------------------- scoring

JUDGE_INSTRUCTIONS = f"""You are a strict portrait photo reviewer.
The first images are REFERENCE photos of a real person. The LAST image is a generated CANDIDATE.

Target specification:
{json.dumps(TARGET_SPEC, indent=2)}

Score the candidate from 0 to 10 per criterion:
- identity: is it unmistakably the same person? Check face shape, eye spacing and shape, nose, lips,
  jawline, ears, skin features, apparent age. Any beautification or "AI face" drift costs heavily.
- pose, background, colors_lighting, hairstyle, clothing: match against the target specification
  (hairstyle must also match the references).
- realism: photographic realism, no plastic skin, no artifacts in hands, teeth, ears, glasses, hair edges.

Return ONLY JSON:
{{
  "scores": {{"identity": 0, "pose": 0, "background": 0, "colors_lighting": 0, "hairstyle": 0, "clothing": 0, "realism": 0}},
  "issues": ["concrete visible problem", "..."],
  "prompt_fixes": ["concrete instruction that would fix an issue", "..."]
}}"""


def judge(candidate: bytes, refs: list[Path]) -> dict:
    content = []
    for ref in refs:
        content.append({"type": "image", "source": {"type": "base64", "media_type": mime_of(ref), "data": b64(ref.read_bytes())}})
    content.append({"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": b64(candidate)}})
    content.append({"type": "text", "text": JUDGE_INSTRUCTIONS})
    response = judge_client.messages.create(
        model=JUDGE_MODEL,
        max_tokens=2000,
        messages=[{"role": "user", "content": content}],
    )
    return extract_json(response.content[0].text)


def score_candidate(candidate: bytes, refs: list[Path], ref_embeddings: list[np.ndarray]) -> dict:
    emb = face_embedding(candidate)
    arcface = float(np.mean([np.dot(emb, r) for r in ref_embeddings])) if emb is not None else 0.0

    if arcface < IDENTITY_GATE:
        return {"total": 0.0, "arcface": arcface, "rejected": "identity gate", "issues": ["face does not match"], "prompt_fixes": []}

    verdict = judge(candidate, refs)
    scores = verdict["scores"]
    # Blend objective and LLM identity: map cosine [gate..0.8] to [0..10]
    arcface_scaled = float(np.clip((arcface - IDENTITY_GATE) / (0.8 - IDENTITY_GATE) * 10, 0, 10))
    scores["identity"] = 0.6 * arcface_scaled + 0.4 * scores["identity"]
    total = sum(WEIGHTS[k] * scores[k] for k in WEIGHTS)
    return {"total": round(total, 2), "arcface": round(arcface, 3), "scores": scores, **verdict}


# ---------------------------------------------------------------- optimizer

def improve_prompt(provider: str, history: list[dict]) -> str:
    recent = history[-4:]
    summary = json.dumps(
        [{"prompt": h["prompt"], "best_total": h["best"]["total"], "scores": h["best"].get("scores"),
          "issues": h["best"].get("issues"), "prompt_fixes": h["best"].get("prompt_fixes")} for h in recent],
        indent=2,
    )
    instruction = f"""You optimize image-editing prompts for the model family "{provider}".
Goal: a headshot that preserves the identity of the reference person (most important) and matches:
{json.dumps(TARGET_SPEC, indent=2)}

Previous attempts (prompt, weighted score 0-10, per-criterion scores, judge issues and suggested fixes):
{summary}

Write ONE improved prompt. Rules:
- keep what worked in higher-scoring prompts, fix the recurring issues
- identity preservation instructions stay at the top
- do not change the target specification, only how it is expressed
- no more than 200 words
Return ONLY JSON: {{"prompt": "...", "rationale": "one sentence"}}"""
    response = judge_client.messages.create(
        model=JUDGE_MODEL,
        max_tokens=1500,
        messages=[{"role": "user", "content": instruction}],
    )
    return extract_json(response.content[0].text)["prompt"]


# ---------------------------------------------------------------- loop

def run_provider(provider: str, refs: list[Path], ref_embeddings: list[np.ndarray]) -> dict:
    generate = GENERATORS[provider]
    out = OUT_DIR / provider
    out.mkdir(parents=True, exist_ok=True)
    log_path = out / "log.jsonl"

    prompt = INITIAL_PROMPT
    history: list[dict] = []
    best_overall = {"total": -1.0}
    stale = 0

    for iteration in range(MAX_ITERATIONS):
        with ThreadPoolExecutor(max_workers=CANDIDATES_PER_ITERATION) as pool:
            images = list(pool.map(lambda _: generate(prompt, refs), range(CANDIDATES_PER_ITERATION)))

        results = []
        for idx, image in enumerate(images):
            path = out / f"it{iteration:02d}_c{idx}.png"
            path.write_bytes(image)
            result = score_candidate(image, refs, ref_embeddings)
            result["path"] = str(path)
            results.append(result)

        best = max(results, key=lambda r: r["total"])
        entry = {"iteration": iteration, "prompt": prompt, "best": best, "all_totals": [r["total"] for r in results]}
        history.append(entry)
        with log_path.open("a") as f:
            f.write(json.dumps(entry) + "\n")
        print(f"[{provider}] it {iteration}: best {best['total']} (arcface {best['arcface']}) -> {best['path']}")

        if best["total"] > best_overall["total"]:
            best_overall = {**best, "prompt": prompt}
            stale = 0
        else:
            stale += 1

        if best_overall["total"] >= TARGET_SCORE or stale >= PATIENCE:
            break
        prompt = improve_prompt(provider, history)

    return best_overall


def main() -> None:
    refs = sorted(p for p in REF_DIR.iterdir() if p.suffix.lower() in {".jpg", ".jpeg", ".png"})
    ref_embeddings = [e for e in (face_embedding(p.read_bytes()) for p in refs) if e is not None]
    if not ref_embeddings:
        raise SystemExit("No face found in reference photos")

    with ThreadPoolExecutor(max_workers=len(GENERATORS)) as pool:
        winners = dict(zip(GENERATORS, pool.map(lambda p: run_provider(p, refs, ref_embeddings), GENERATORS)))

    (OUT_DIR / "winners.json").write_text(json.dumps(winners, indent=2))
    for provider, w in winners.items():
        print(f"{provider}: {w['total']} | arcface {w['arcface']} | {w['path']}")


if __name__ == "__main__":
    main()
