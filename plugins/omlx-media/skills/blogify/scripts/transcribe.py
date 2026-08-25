#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["openai>=1.40"]
# ///
"""Transcribe a video/audio recording via an OMLX ASR model.

Pipeline: extract 16 kHz mono WAV -> map silence -> chunk on silence
boundaries -> transcribe chunks concurrently -> assemble a timestamped
transcript. Timestamps are reconstructed from chunk offsets because ASR models
like parakeet return text only (no word timings, no diarization).

Usage:
  uv run scripts/transcribe.py --input {absolute_path_to_talk.mp4} --output-dir {absolute_workspace_path}

Env: OMLX_BASE_URL (defaults to http://127.0.0.1:8000), OMLX_API_KEY (optional; defaults to empty)
Dependencies: uv, ffmpeg, ffprobe. Imports plan_chunks.py from this directory.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from openai import OpenAI

SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_ROOT = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))
import plan_chunks  # noqa: E402  (sibling helper, added to path above)


class TranscriptionError(RuntimeError):
    """Raised when a chunk cannot be transcribed after retries."""


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kw)


def ffprobe_duration(path: Path) -> float:
    out = run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)]
    ).stdout.strip()
    return float(out)


def discover_asr_model(client: OpenAI) -> str:
    ids = [m.id for m in client.models.list().data]
    for terms in (("parakeet",), ("asr", "whisper", "canary")):
        hit = next((i for i in ids if any(t in i.lower() for t in terms)), None)
        if hit:
            return hit
    return ""


def resolve_output_dir(value: str) -> Path:
    """Resolve an output directory and reject writes inside the skill bundle."""
    path = Path(value).expanduser()
    if not path.is_absolute():
        sys.exit("error: --output-dir must be an absolute path")
    resolved = path.resolve()
    if resolved == SKILL_ROOT or SKILL_ROOT in resolved.parents:
        sys.exit("error: --output-dir must be outside the skill")
    return resolved


def ts(sec: float) -> str:
    m, s = divmod(int(round(sec)), 60)
    h, m = divmod(m, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def transcribe_chunk(client, model, wav: Path, chunk_dir: Path, chunk: dict):
    idx, start, end = chunk["i"], chunk["start"], chunk["end"]
    piece = chunk_dir / f"chunk_{idx:03d}.wav"
    run(["ffmpeg", "-y", "-ss", str(start), "-t", str(end - start), "-i", str(wav),
         "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(piece)])
    try:
        with piece.open("rb") as fh:
            resp = client.audio.transcriptions.create(model=model, file=fh, response_format="json")
        text = (resp.text or "").strip()
    except Exception as exc:  # noqa: BLE001 - preserve chunk context for the caller
        raise TranscriptionError(f"chunk {idx:03d} failed: {exc}") from exc
    print(f"  chunk {idx:03d} done ({len(text)} chars)", file=sys.stderr)
    return idx, start, end, text


def main():
    ap = argparse.ArgumentParser(description="Transcribe a recording via OMLX ASR.")
    ap.add_argument("--input", required=True)
    ap.add_argument("--output-dir", required=True)
    ap.add_argument("--model", default="")
    ap.add_argument("--chunk-sec", type=float, default=120.0)
    ap.add_argument("--silence-db", type=float, default=-30.0)
    ap.add_argument("--silence-dur", type=float, default=1.5)
    ap.add_argument("--concurrency", type=int, default=3)
    args = ap.parse_args()

    base_url = os.environ.get("OMLX_BASE_URL", "http://127.0.0.1:8000")
    src = Path(args.input)
    if not src.is_file():
        sys.exit("error: --input file not found")

    out = resolve_output_dir(args.output_dir)
    out.mkdir(parents=True, exist_ok=True)
    chunk_dir = out / "chunks"
    chunk_dir.mkdir(exist_ok=True)
    for stale in chunk_dir.glob("chunk_*.wav"):
        stale.unlink()

    client = OpenAI(
        base_url=f"{base_url.rstrip('/')}/v1",
        api_key=os.environ.get("OMLX_API_KEY", ""),
        max_retries=4,
        timeout=300,
    )
    model = args.model or discover_asr_model(client)
    if not model:
        sys.exit("error: no ASR model found; pass --model")
    print(f"ASR model: {model}", file=sys.stderr)

    print("Extracting 16 kHz mono audio...", file=sys.stderr)
    wav = out / "audio_16k.wav"
    run(["ffmpeg", "-y", "-i", str(src), "-vn", "-ac", "1", "-ar", "16000",
         "-c:a", "pcm_s16le", str(wav)])
    duration = ffprobe_duration(wav)

    print("Detecting silence...", file=sys.stderr)
    proc = subprocess.run(
        ["ffmpeg", "-i", str(wav), "-af",
         f"silencedetect=noise={args.silence_db}dB:d={args.silence_dur}", "-f", "null", "-"],
        capture_output=True, text=True,
    )
    silence_log = out / "silence.log"
    silence_log.write_text(proc.stderr, encoding="utf-8")

    starts, ends = plan_chunks.parse_silences(silence_log)
    speech = plan_chunks.speech_intervals(starts, ends, duration)
    chunk_bounds = plan_chunks.build_chunks(speech, args.chunk_sec)
    chunks = [{"i": i, "start": round(a, 3), "end": round(b, 3)} for i, (a, b) in enumerate(chunk_bounds)]
    (out / "chunks_plan.json").write_text(json.dumps(chunks), encoding="utf-8")
    speech_secs = sum(b - a for a, b in chunk_bounds)
    print(f"{len(chunks)} chunks, ~{speech_secs:.0f}s speech of {duration:.0f}s", file=sys.stderr)

    print(f"Transcribing chunks ({args.concurrency}-way concurrent)...", file=sys.stderr)
    results = []
    with ThreadPoolExecutor(max_workers=max(1, args.concurrency)) as pool:
        futures = [pool.submit(transcribe_chunk, client, model, wav, chunk_dir, c) for c in chunks]
        for fut in futures:
            results.append(fut.result())
    results.sort(key=lambda row: row[0])

    print("Assembling transcript...", file=sys.stderr)
    rows, md = [], [
        "# Transcript", "",
        "_Auto-transcribed. Timestamps are chunk boundaries aligned to silence "
        "gaps; silent spans are omitted. No speaker diarization._", "",
    ]
    for idx, start, end, text in results:
        rows.append({"i": idx, "start": start, "end": end, "text": text})
        md += [f"## [{ts(start)}\u2013{ts(end)}]", "", text or "_(no speech)_", ""]
    (out / "transcript.md").write_text("\n".join(md), encoding="utf-8")
    (out / "chunks.json").write_text(json.dumps(rows, indent=2), encoding="utf-8")

    words = sum(len(r["text"].split()) for r in rows)
    print(f"transcript: {len(rows)} chunks, ~{words} words -> {out / 'transcript.md'}", file=sys.stderr)
    print(str(out / "transcript.md"))


if __name__ == "__main__":
    main()
