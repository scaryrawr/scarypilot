#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# ///
"""Crop overlays such as meeting filmstrips or taskbars off frames."""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parent.parent


def magick_command() -> list[str]:
    """Return the ImageMagick command for this host."""
    if shutil.which("magick"):
        return ["magick"]
    convert = shutil.which("convert")
    if convert:
        if sys.platform != "win32":
            return [convert]
        version = subprocess.run([convert, "-version"], capture_output=True, text=True)
        if "imagemagick" in f"{version.stdout}\n{version.stderr}".lower():
            return [convert]
    sys.exit("error: ImageMagick not found (expected magick or convert)")


def ensure_outside_skill(path: Path, flag: str) -> Path:
    """Resolve an absolute output path and reject writes inside the skill."""
    if not path.is_absolute():
        sys.exit(f"error: {flag} must be an absolute path")
    resolved = path.resolve()
    if resolved == SKILL_ROOT or SKILL_ROOT in resolved.parents:
        sys.exit(f"error: {flag} must be outside the skill")
    return resolved


def crop_one(command: list[str], src: Path, crop: str, output: Path) -> None:
    """Crop one image using ImageMagick."""
    output.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([*command, str(src), "-crop", crop, "+repage", str(output)], check=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--frames-dir", default="")
    parser.add_argument("--output-dir", default="")
    parser.add_argument("--input", default="")
    parser.add_argument("--output", default="")
    parser.add_argument("--crop", required=True)
    args = parser.parse_args()

    command = magick_command()
    if args.input:
        src = Path(args.input).expanduser()
        if not src.is_file():
            sys.exit("error: --input not found")
        if not args.output:
            sys.exit("error: --output required with --input")
        output = ensure_outside_skill(Path(args.output).expanduser(), "--output")
        crop_one(command, src, args.crop, output)
        print(output, file=sys.stderr)
        return

    frames_dir = Path(args.frames_dir).expanduser() if args.frames_dir else Path()
    if not frames_dir.is_dir():
        sys.exit("error: --frames-dir or --input required")
    if not args.output_dir:
        sys.exit("error: --output-dir required in batch mode")
    outdir = ensure_outside_skill(Path(args.output_dir).expanduser(), "--output-dir")
    outdir.mkdir(parents=True, exist_ok=True)

    frames = [
        path
        for suffix in ("*.png", "*.jpg", "*.jpeg", "*.PNG", "*.JPG", "*.JPEG")
        for path in frames_dir.glob(suffix)
    ]
    count = 0
    for frame in sorted(set(frames), key=str):
        crop_one(command, frame, args.crop, outdir / frame.name)
        count += 1
    print(f"cropped {count} images -> {outdir}", file=sys.stderr)


if __name__ == "__main__":
    main()
