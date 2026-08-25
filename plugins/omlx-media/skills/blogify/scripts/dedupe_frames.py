#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# ///
"""Drop near-identical consecutive frames before classifying."""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parent.parent


def resolve_output_dir(value: str, frames_dir: Path) -> Path:
    """Resolve an output directory and reject unsafe destinations."""
    path = Path(value).expanduser()
    if not path.is_absolute():
        sys.exit("error: --output-dir must be an absolute path")
    resolved = path.resolve()
    if resolved == SKILL_ROOT or SKILL_ROOT in resolved.parents:
        sys.exit("error: --output-dir must be outside the skill")
    if resolved == frames_dir:
        sys.exit("error: --output-dir must differ from --frames-dir")
    return resolved


def compare_command() -> list[str]:
    """Return the ImageMagick compare command for this host."""
    if shutil.which("magick"):
        return ["magick", "compare"]
    compare = shutil.which("compare")
    if compare:
        if sys.platform != "win32":
            return [compare]
        version = subprocess.run([compare, "-version"], capture_output=True, text=True)
        if "imagemagick" in f"{version.stdout}\n{version.stderr}".lower():
            return [compare]
    sys.exit("error: ImageMagick compare not found (expected magick or compare)")


def rmse_distance(command: list[str], previous: Path, current: Path) -> float:
    """Return ImageMagick normalized RMSE between two images."""
    proc = subprocess.run(
        [*command, "-metric", "RMSE", str(previous), str(current), "null:"],
        capture_output=True,
        text=True,
    )
    combined = f"{proc.stdout}\n{proc.stderr}"
    match = re.search(r"\(([0-9.]+)\)", combined)
    return float(match.group(1)) if match else 1.0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--frames-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--threshold", type=float, default=0.06)
    args = parser.parse_args()

    frames_dir = Path(args.frames_dir).expanduser()
    if not frames_dir.is_dir():
        sys.exit("error: --frames-dir required")
    frames_dir = frames_dir.resolve()
    if not 0 <= args.threshold <= 1:
        sys.exit("error: --threshold must be a number between 0 and 1")

    outdir = resolve_output_dir(args.output_dir, frames_dir)
    outdir.mkdir(parents=True, exist_ok=True)
    for stale in outdir.glob("*.jpg"):
        stale.unlink()

    command = compare_command()
    previous: Path | None = None
    kept = 0
    frames = sorted(frames_dir.glob("*.jpg"))
    for frame in frames:
        if previous is None or rmse_distance(command, previous, frame) > args.threshold:
            shutil.copy2(frame, outdir / frame.name)
            previous = frame
            kept += 1
    print(f"kept {kept} of {len(frames)} -> {outdir}", file=sys.stderr)


if __name__ == "__main__":
    main()
