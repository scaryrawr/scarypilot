#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# ///
"""Cut verified highlight clips from a source video with ffmpeg.

Tries a fast stream-copy first (keyframe-snapped, no re-encode); if the copy
produces a file whose duration is wrong (missing leading keyframe), re-encodes
that clip with libx264/aac (or vp9/opus for webm sources).

Usage:
  uv run scripts/cut_clips.py --input {video} --highlights {highlights.json}
      --output-dir {dir} [--reencode]

Writes {output-dir}/{index:02d}-{slugified-title}.mp4|webm and prints a JSON
manifest of {file, start_sec, end_sec, method}.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
import sys
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parents[3]


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=False, capture_output=True, text=True)


def slugify(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return s[:60] or "clip"


def duration(path: Path) -> float:
    p = run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)])
    try:
        return float(p.stdout.strip())
    except ValueError:
        return -1.0


def resolve_output_dir(value: str) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        sys.exit("error: --output-dir must be absolute")
    resolved = path.resolve()
    if resolved == PLUGIN_ROOT or PLUGIN_ROOT in resolved.parents:
        sys.exit("error: --output-dir must be outside the plugin")
    if path.exists() or path.is_symlink():
        sys.exit("error: --output-dir must be fresh")
    resolved.mkdir(parents=False, exist_ok=False)
    return resolved


def main() -> None:
    ap = argparse.ArgumentParser(description="Cut highlight clips from a video.")
    ap.add_argument("--input", required=True)
    ap.add_argument("--highlights", required=True)
    ap.add_argument("--output-dir", required=True)
    ap.add_argument("--reencode", action="store_true", help="always re-encode (exact cuts)")
    args = ap.parse_args()

    src = Path(args.input).expanduser().resolve()
    if not src.is_file():
        sys.exit("error: --input not found")
    clips = json.loads(Path(args.highlights).expanduser().read_text(encoding="utf-8"))
    if not isinstance(clips, list) or not clips:
        sys.exit("error: highlights must be a nonempty verified list")
    for clip in clips:
        st, en = float(clip["start_sec"]), float(clip["end_sec"])
        if clip.get("verified") is not True or not math.isfinite(st) or not math.isfinite(en) or st < 0 or en <= st:
            sys.exit("error: highlights require verified finite bounds with 0 <= start < end")
    out_dir = resolve_output_dir(args.output_dir)
    webm = src.suffix.lower() == ".webm"
    ext = "webm" if webm else "mp4"

    manifest = []
    for i, clip in enumerate(clips):
        st, en = float(clip["start_sec"]), float(clip["end_sec"])
        if en <= st:
            print(f"skip {i}: end<=start", file=sys.stderr)
            continue
        out = out_dir / f"{i:02d}-{slugify(clip.get('title', ''))}.{ext}"
        method = "copy"
        dur = f"{en - st:.3f}"
        codecs = ("-c:v", "libvpx-vp9", "-b:v", "2M", "-deadline", "realtime",
                  "-cpu-used", "8", "-c:a", "libopus") if webm \
            else ("-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac")
        want = en - st
        ok = False
        if args.reencode:
            proc = run(["ffmpeg", "-n", "-v", "error", "-ss", str(st), "-i", str(src),
                        "-t", dur, *codecs, str(out)])
            method = "reencode"
            got = duration(out)
            ok = proc.returncode == 0 and got >= 0 and abs(got - want) <= 2.5
        else:
            # explicit -t duration after -i: -to/-ss combos mis-copy webm segments
            proc = run(["ffmpeg", "-n", "-v", "error", "-ss", str(st), "-i", str(src),
                 "-t", dur, "-c", "copy", str(out)])
            got = duration(out)
            if proc.returncode == 0 and got >= 0 and abs(got - want) <= 2.5:
                method, ok = "copy", True
            else:
                out.unlink(missing_ok=True)
                proc = run(["ffmpeg", "-n", "-v", "error", "-ss", str(st), "-i", str(src),
                            "-t", dur, *codecs, str(out)])
                method = "reencode(fallback)"
                got = duration(out)
                ok = proc.returncode == 0 and got >= 0 and abs(got - want) <= 2.5
        entry = {"file": str(out), "start_sec": round(st, 3), "end_sec": round(en, 3),
                 "title": clip.get("title", ""), "method": method, "ok": ok,
                 "actual_duration": round(got, 3) if got >= 0 else None}
        manifest.append(entry)
        print(f"{'cut' if ok else 'FAIL'} {out.name} [{method}]")

    (out_dir / "clips-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    failed = [m["file"] for m in manifest if not m["ok"]]
    print(json.dumps({"clips": len(manifest), "failed": len(failed),
                      "manifest": str(out_dir / "clips-manifest.json")}))
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
