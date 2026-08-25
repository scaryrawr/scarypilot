#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# ///
"""Extract one full-resolution frame from a video."""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parent.parent


def resolve_output_file(value: str) -> Path:
    """Resolve an absolute output path and reject writes inside the skill bundle."""
    path = Path(value).expanduser()
    if not path.is_absolute():
        sys.exit("error: --output must be an absolute path")
    resolved = path.resolve()
    if resolved == SKILL_ROOT or SKILL_ROOT in resolved.parents:
        sys.exit("error: --output must be outside the skill")
    return resolved


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--second", type=float, required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    src = Path(args.input).expanduser()
    if not src.is_file():
        sys.exit("error: --input file required")
    if args.second < 0:
        sys.exit("error: --second must be non-negative")

    output = resolve_output_file(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-ss", str(args.second), "-i", str(src), "-frames:v", "1", str(output)],
        check=True,
    )
    if not output.is_file() or output.stat().st_size == 0:
        sys.exit(f"error: no frame extracted at --second {args.second}")
    print(output, file=sys.stderr)


if __name__ == "__main__":
    main()
