#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# ///
"""Rank sampled frames by visual change using ffmpeg PSNR; flag uniform videos.

Reads frames named by timestamp (t_00NN.jpg etc, sorted by name), computes the
PSNR of each frame against its predecessor, and prints them ranked from biggest
change to smallest. Low PSNR = big visual change (scene cut, screen-share start,
layout flip) -> key-frame candidates. A high median PSNR across the whole video
means the footage is visually uniform (e.g. a static split-screen podcast), in
which case frame mining is low value and the audio transcript should carry the
highlights instead.

Usage:
  uv run scripts/scene_diff.py --frames-dir {absolute_dir_of_jpgs} [--top 12]

Prints a JSON report to stdout:
  {"uniform": bool, "median_psnr": float, "candidates": [{"frame","psnr","est_second"}...]}

Dependencies: ffmpeg, ffprobe (uv is optional if python3 is on PATH).
"""
from __future__ import annotations

import argparse
import json
import re
import statistics
import subprocess
import sys
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parent.parent


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=False, capture_output=True, text=True)


def ts_from_name(path: Path) -> float | None:
    """Timestamp from sample_frames.py names (t_001m23s_f0001) or plain numbers (seconds)."""
    stem = path.stem
    m = re.search(r"0*(\d+)m0*(\d+)s", stem)
    if m:
        return float(m.group(1)) * 60.0 + float(m.group(2))
    m = re.search(r"_?0*(\d+)(?:_f\d+)?$", stem)
    return float(m.group(1)) if m else None


def psnr_pair(a: Path, b: Path) -> float | None:
    p = run(["ffmpeg", "-i", str(a), "-i", str(b), "-lavfi", "psnr", "-f", "null", "-"])
    m = re.search(r"average:([0-9.inf]+)", p.stderr)
    if not m:
        return None
    val = m.group(1)
    return float("inf") if val == "inf" else float(val)


def main() -> None:
    ap = argparse.ArgumentParser(description="PSNR scene-diff over timestamped frames.")
    ap.add_argument("--frames-dir", required=True)
    ap.add_argument("--top", type=int, default=12)
    ap.add_argument("--uniform-median", type=float, default=20.0,
                    help="median PSNR at/above this marks the video visually uniform")
    args = ap.parse_args()

    frames_dir = Path(args.frames_dir).expanduser()
    if not frames_dir.is_absolute():
        sys.exit("error: --frames-dir must be an absolute path")
    resolved = frames_dir.resolve()
    if resolved == SKILL_ROOT or SKILL_ROOT in resolved.parents:
        sys.exit("error: --frames-dir must be outside the skill")

    frames = sorted(frames_dir.glob("*.jpg")) + sorted(frames_dir.glob("*.png"))
    frames = sorted(set(frames))
    if len(frames) < 2:
        sys.exit("error: need at least two frames in --frames-dir")

    scores: list[dict] = []
    failed = 0
    for a, b in zip(frames, frames[1:]):
        v = psnr_pair(a, b)
        if v is None:
            failed += 1
            continue
        scores.append({"frame": b.name,
                   "psnr": "inf" if v == float("inf") else round(v, 2),
                   "est_second": ts_from_name(b)})

    if not scores:
        sys.exit(f"error: ffmpeg compared 0 of {len(frames) - 1} frame pairs "
                 f"({failed} failed); refusing to report uniform=true on broken input")
    finite = [s["psnr"] for s in scores if s["psnr"] != "inf"]
    median = statistics.median(finite) if finite else float("inf")
    candidates = sorted(scores, key=lambda s: float("inf") if s["psnr"] == "inf" else s["psnr"])[: args.top]
    report = {
        "frames_compared": len(scores),
        "median_psnr": round(median, 2) if median != float("inf") else "inf",
        "uniform": median >= args.uniform_median,
        "candidates": candidates,
        "note": ("uniform footage: rely on transcript-driven highlights; key frames add little"
                if median >= args.uniform_median
                else "layout changes detected: inspect top candidates as key frames"),
    }
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
