#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["openai>=1.40"]
# ///
"""Classify frames with an OMLX vision model, using constrained JSON output.

The winning technique from practice: don't ask for open-ended captions. Give
the model a SHORT fixed set of enum categories plus one line of context, and
force a structured `{"label": ..., "reason": ...}` reply via JSON mode
(response_format=json_object). This turns the model into a reliable router that
pinpoints specific UIs across a dense frame sample.

Note: the OMLX endpoint honors `response_format={"type":"json_object"}` (JSON
mode) but NOT strict `json_schema`, so we validate the label against the enum
ourselves (falling back to OTHER on anything unexpected).

This endpoint charges a large fixed cost per request (prompt prefill/warmup,
serialized because the server runs one request at a time) that dwarfs the actual
per-image inference and is the same whether or not the model is already resident.
The single lever that helps is `--batch-size`: classify several frames in one
request so that fixed cost is paid once per batch instead of once per frame.

Usage:
  uv run scripts/classify_frames.py \
    --frames-dir /abs/frames_dedup --output /abs/manifest.json \
    --context "screen recording of a talk about CLI tools" \
    --categories "TERMINAL,SLIDE,BROWSER,TALKING_HEAD,OTHER" \
    --batch-size 4 --select-dir /abs/selected

Env: OMLX_BASE_URL (defaults to http://127.0.0.1:8000), OMLX_API_KEY (optional; defaults to empty)
Dependencies: uv, ffmpeg not needed here.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from openai import OpenAI
from pydantic import BaseModel, ValidationError

SKILL_ROOT = Path(__file__).resolve().parent.parent


def resolve_output_path(value: str, flag: str, *, is_dir: bool = False) -> Path:
    """Resolve an output path and reject writes inside the skill bundle."""
    path = Path(value).expanduser()
    if not path.is_absolute():
        sys.exit(f"error: {flag} must be an absolute path")
    resolved = path.resolve()
    if resolved == SKILL_ROOT or SKILL_ROOT in resolved.parents:
        sys.exit(f"error: {flag} must be outside the skill")
    return resolved


class Classification(BaseModel):
    label: str
    reason: str = ""


class BatchItem(BaseModel):
    """One frame's result inside a batched reply, keyed by its 0-based position."""
    i: int
    label: str
    reason: str = ""


class BatchResult(BaseModel):
    results: list[BatchItem]


class ClassificationError(RuntimeError):
    """Raised when a frame cannot be classified after model retries."""


def discover_vision_model(client: OpenAI) -> str:
    """Pick a vision model. All Gemma variants accept images; prefer the
    efficient multimodal ones (12B/E4B/E2B), then any Gemma, then other VLMs.
    The larger Gemma models (26B+) only lack video/audio, not image, input."""
    ids = [m.id for m in client.models.list().data]
    non_assistant = [i for i in ids if "assistant" not in i.lower()]

    def first_with(terms, pool):
        return next((i for i in pool if any(t in i.lower() for t in terms)), None)

    gemmas = [i for i in non_assistant if "gemma" in i.lower()]
    return (
        first_with(("12b", "e4b", "e2b"), gemmas)
        or (gemmas[0] if gemmas else None)
        or first_with(("vl", "vision", "llava", "pixtral", "internvl"), non_assistant)
        or ""
    )


def build_prompt(context: str, categories: list[str]) -> str:
    cats = ", ".join(categories)
    ctx = f" Context: {context}." if context else ""
    return (
        "You are classifying a single frame from a screen recording."
        f"{ctx} Choose the single best label from this fixed set: {cats}. "
        "Use the OTHER/NONE bucket for blurry, transition, talking-head, or "
        "otherwise non-useful frames. Respond ONLY as JSON of the form "
        '{"label": "<one label>", "reason": "<short reason>"}.'
    )


def build_batch_prompt(context: str, categories: list[str], n: int) -> str:
    cats = ", ".join(categories)
    ctx = f" Context: {context}." if context else ""
    return (
        f"You are classifying {n} frames from a screen recording, provided in "
        f"order and prefixed with 'Image 0:' through 'Image {n - 1}:'."
        f"{ctx} For EACH image independently, choose the single best label from "
        f"this fixed set: {cats}. Use the OTHER/NONE bucket for blurry, "
        "transition, talking-head, or otherwise non-useful frames. Respond ONLY "
        'as JSON of the form {"results": [{"i": <index>, "label": "<one '
        'label>", "reason": "<short reason>"}, ...]} with exactly one entry per '
        f"image (indices 0 through {n - 1}), in order."
    )


def fallback_label(categories: list[str]) -> str:
    """Return the enum bucket for unusable frames, or exit if none is configured."""
    for preferred in ("OTHER", "NONE"):
        match = next((c for c in categories if c.lower() == preferred.lower()), None)
        if match:
            return match
    sys.exit("error: --categories must include OTHER or NONE")


def match_label(raw: str, categories: list[str], fallback: str) -> str:
    """Return the enum member matching `raw` case-insensitively, else `fallback`."""
    match = next((c for c in categories if c.lower() == raw.strip().lower()), None)
    return match or fallback


def classify_one(client, model, prompt, categories, fallback, frame: Path):
    data_uri = "data:image/jpeg;base64," + base64.b64encode(frame.read_bytes()).decode()
    label, reason = fallback, ""
    try:
        resp = client.chat.completions.create(
            model=model,
            max_tokens=200,
            temperature=0,
            response_format={"type": "json_object"},
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": data_uri}},
                    ],
                }
            ],
        )
        content = resp.choices[0].message.content or "{}"
        parsed = Classification.model_validate_json(content)
        # Validate the label against the enum (case-insensitive); else fallback.
        label = match_label(parsed.label, categories, fallback)
        reason = parsed.reason
    except (ValidationError, json.JSONDecodeError):
        reason = "unparseable response"
    except Exception as exc:  # network / server errors after retries
        raise ClassificationError(f"{frame.name}: {exc}") from exc
    return frame, label, reason


def classify_batch(client, model, context, categories, fallback, frames: list[Path]):
    """Classify several frames in a single request to amortize the endpoint's
    fixed per-request cost. Falls back to per-frame classification when the
    batched reply is malformed or returns the wrong number of entries, so one bad
    batch never silently drops or misaligns frames. Returns a list of
    (frame, label, reason) tuples."""
    single = build_prompt(context, categories)
    if len(frames) == 1:
        return [classify_one(client, model, single, categories, fallback, frames[0])]

    prompt = build_batch_prompt(context, categories, len(frames))
    content = [{"type": "text", "text": prompt}]
    for idx, frame in enumerate(frames):
        data_uri = "data:image/jpeg;base64," + base64.b64encode(frame.read_bytes()).decode()
        content.append({"type": "text", "text": f"Image {idx}:"})
        content.append({"type": "image_url", "image_url": {"url": data_uri}})

    try:
        resp = client.chat.completions.create(
            model=model,
            max_tokens=max(200, 60 * len(frames)),
            temperature=0,
            response_format={"type": "json_object"},
            messages=[{"role": "user", "content": content}],
        )
        parsed = BatchResult.model_validate_json(resp.choices[0].message.content or "{}")
    except (ValidationError, json.JSONDecodeError):
        # Unparseable batch: retry each frame on its own rather than lose them.
        return [classify_one(client, model, single, categories, fallback, f) for f in frames]
    except Exception as exc:  # network / server errors after retries
        raise ClassificationError(f"batch of {len(frames)} frames: {exc}") from exc

    # Wrong count means the model lost track of the batch; retry per-frame so we
    # never silently drop or misalign frames.
    if len(parsed.results) != len(frames):
        return [classify_one(client, model, single, categories, fallback, f) for f in frames]

    # We asked for entries "in order" with 0-based indices. Trust the explicit
    # indices only when they form exactly {0..N-1}; otherwise (e.g. 1-based or
    # arbitrary indices) fall back to positional order, which avoids silently
    # shifting labels onto the wrong frames.
    if sorted(item.i for item in parsed.results) == list(range(len(frames))):
        by_index = {item.i: item for item in parsed.results}
        ordered = [by_index[i] for i in range(len(frames))]
    else:
        ordered = parsed.results

    return [
        (frame, match_label(item.label, categories, fallback), item.reason)
        for frame, item in zip(frames, ordered)
    ]


def parse_ts(name: str) -> str:
    # frames from sample_frames.py are named t_<MMmSSs>_f####.jpg
    stem = name
    if stem.startswith("t_") and "_f" in stem:
        return stem[2:].split("_f", 1)[0]
    return ""


def main():
    ap = argparse.ArgumentParser(description="Classify frames via OMLX vision model.")
    ap.add_argument("--frames-dir", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--model", default="")
    ap.add_argument("--context", default="")
    ap.add_argument("--categories", default="USEFUL,OTHER")
    ap.add_argument("--select-dir", default="")
    # This endpoint charges a large fixed cost per request (prefill/warmup) that
    # is the same whether the model is resident or not and dwarfs per-image
    # inference. Batching several frames into one request pays that cost once per
    # batch instead of once per frame. Larger batches are faster per frame but can
    # cost accuracy on dense, similar screen frames; 4 is a safe default.
    ap.add_argument("--batch-size", type=int, default=4)
    # Default 1: the OMLX endpoint serializes requests (scheduler
    # max_concurrent_requests=1), so concurrent calls collide with HTTP 409
    # ("cannot reload runtime settings variant"). Prefer raising --batch-size over
    # --concurrency; only raise this against an endpoint you know runs requests in
    # parallel.
    ap.add_argument("--concurrency", type=int, default=1)
    args = ap.parse_args()

    base_url = os.environ.get("OMLX_BASE_URL", "http://127.0.0.1:8000")
    frames_dir = Path(args.frames_dir)
    if not frames_dir.is_dir():
        sys.exit("error: --frames-dir not found")
    frames_dir = frames_dir.resolve()
    output = resolve_output_path(args.output, "--output")
    select_dir = resolve_output_path(args.select_dir, "--select-dir", is_dir=True) if args.select_dir else None
    if select_dir and select_dir == frames_dir:
        sys.exit("error: --select-dir must differ from --frames-dir")

    categories = [c.strip() for c in args.categories.split(",") if c.strip()]
    fallback = fallback_label(categories)
    client = OpenAI(
        base_url=f"{base_url.rstrip('/')}/v1",
        api_key=os.environ.get("OMLX_API_KEY", ""),
        max_retries=4,
        timeout=120,
    )
    model = args.model or discover_vision_model(client)
    if not model:
        sys.exit("error: no vision model found; pass --model")
    print(f"vision model: {model} | categories: {', '.join(categories)}", file=sys.stderr)

    frames = sorted(frames_dir.glob("*.jpg"))
    if not frames:
        sys.exit("error: no .jpg frames in --frames-dir")

    batch_size = max(1, args.batch_size)
    batches = [frames[i:i + batch_size] for i in range(0, len(frames), batch_size)]
    print(
        f"{len(frames)} frames in {len(batches)} batch(es) of up to {batch_size}",
        file=sys.stderr,
    )

    output.parent.mkdir(parents=True, exist_ok=True)
    if select_dir:
        select_dir.mkdir(parents=True, exist_ok=True)
        for stale in select_dir.glob("*.jpg"):
            stale.unlink()

    manifest = []
    with ThreadPoolExecutor(max_workers=max(1, args.concurrency)) as pool:
        futures = [
            pool.submit(classify_batch, client, model, args.context, categories, fallback, batch)
            for batch in batches
        ]
        for fut in futures:
            for frame, label, reason in fut.result():
                manifest.append({"file": frame.name, "ts": parse_ts(frame.name), "label": label, "reason": reason})
                print(f"  {frame.name} -> {label}", file=sys.stderr)
                if select_dir and label.upper() not in ("OTHER", "NONE"):
                    shutil.copy(frame, select_dir / frame.name)

    manifest.sort(key=lambda row: row["file"])
    output.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    counts: dict[str, int] = {}
    for row in manifest:
        counts[row["label"]] = counts.get(row["label"], 0) + 1
    print(f"classified {len(manifest)} frames -> {output}", file=sys.stderr)
    for label, n in sorted(counts.items()):
        print(f"  {n:4d} {label}", file=sys.stderr)


if __name__ == "__main__":
    main()
