#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# ///
"""Extract candidate frames from a video, named by timestamp."""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parent.parent


def resolve_output_dir(value: str) -> Path:
    """Resolve an absolute output directory and reject writes inside the skill."""
    path = Path(value).expanduser()
    if not path.is_absolute():
        sys.exit("error: --output-dir must be an absolute path")
    resolved = path.resolve()
    if resolved == SKILL_ROOT or SKILL_ROOT in resolved.parents:
        sys.exit("error: --output-dir must be outside the skill")
    return resolved


def run_text(command: list[str]) -> str:
    """Run a command and return stdout text."""
    return subprocess.run(command, check=True, capture_output=True, text=True).stdout.strip()


def ffprobe_fps(path: Path) -> float:
    """Return the video's nominal frame rate, defaulting when metadata is absent."""
    raw = run_text(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=r_frame_rate",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ]
    )
    try:
        if "/" in raw:
            numerator, denominator = raw.split("/", 1)
            return float(numerator) / float(denominator)
        return float(raw)
    except (ValueError, ZeroDivisionError):
        return 25.0


def clean_outputs(outdir: Path) -> None:
    """Remove files owned by this helper from a prior run."""
    for stale in outdir.glob("t_*m*s_f*.jpg"):
        stale.unlink()
    raw = outdir / "_raw"
    if raw.exists():
        shutil.rmtree(raw)


def rename_sampled_frames(raw: Path, outdir: Path, log: Path, offset: float) -> int:
    """Rename ffmpeg frame outputs using showinfo timestamps."""
    times = [float(match) for match in re.findall(r"pts_time:([0-9.]+)", log.read_text(errors="ignore"))]
    files = sorted(raw.glob("*.jpg"))
    if not files:
        raw.rmdir()
        return 0

    for index, frame in enumerate(files):
        secs = (times[index] if index < len(times) else index) + offset
        minutes, seconds = divmod(int(round(secs)), 60)
        target = outdir / f"t_{minutes:03d}m{seconds:02d}s_f{index:04d}.jpg"
        frame.replace(target)
    raw.rmdir()
    return len(files)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--scene", type=float, default=0.06)
    parser.add_argument("--every", type=float, default=4.0)
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--start", type=float, default=0.0)
    parser.add_argument("--end", type=float, default=None)
    args = parser.parse_args()

    src = Path(args.input).expanduser()
    if not src.is_file():
        sys.exit("error: --input file required")
    if not 0 <= args.scene <= 1:
        sys.exit("error: --scene must be a number between 0 and 1")
    if args.every < 0:
        sys.exit("error: --every must be non-negative")
    if args.width < 1:
        sys.exit("error: --width must be a positive integer")
    if args.start < 0:
        sys.exit("error: --start must be non-negative")
    if args.end is not None and args.end <= args.start:
        sys.exit("error: --end must be greater than --start")

    outdir = resolve_output_dir(args.output_dir)
    outdir.mkdir(parents=True, exist_ok=True)
    clean_outputs(outdir)
    raw = outdir / "_raw"
    raw.mkdir()
    log = outdir / "showinfo.log"

    fps = ffprobe_fps(src)
    selector = f"gt(scene,{args.scene})"
    if args.every != 0:
        modulo = max(1, int(args.every * fps))
        selector = f"{selector}+not(mod(n,{modulo}))"

    command = ["ffmpeg", "-y"]
    if args.start != 0:
        command.extend(["-ss", str(args.start)])
    if args.end is not None:
        command.extend(["-to", str(args.end)])
    command.extend(
        [
            "-i",
            str(src),
            "-vf",
            f"select='{selector}',showinfo,scale={args.width}:-1",
            "-vsync",
            "vfr",
            str(raw / "f_%05d.jpg"),
        ]
    )

    print(f"Sampling frames (scene>{args.scene}, every {args.every}s, fps~{fps:g})...", file=sys.stderr)
    with log.open("w", encoding="utf-8", errors="replace") as stderr:
        proc = subprocess.run(command, stderr=stderr)
    if proc.returncode != 0:
        if not any(raw.glob("*.jpg")) and re.search(
            r"Nothing was written|Output file is empty",
            log.read_text(errors="ignore"),
        ):
            shutil.rmtree(raw)
            print(f"0 frames matched -> {outdir} (lower --scene or enable --every)", file=sys.stderr)
            return
        sys.exit(f"error: ffmpeg failed while sampling frames; see {log}")

    count = rename_sampled_frames(raw, outdir, log, args.start)
    if count == 0:
        print(f"0 frames matched -> {outdir} (lower --scene or enable --every)", file=sys.stderr)
    else:
        print(f"{count} frames -> {outdir}", file=sys.stderr)


if __name__ == "__main__":
    main()
