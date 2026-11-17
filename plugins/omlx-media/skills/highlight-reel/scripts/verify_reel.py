#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# ///
"""Verify a highlights JSON + takeaways markdown against the timestamped transcript.

Catches the two failure modes local models actually produce:
1. Clip bounds that drift outside the transcript chunk windows they cite.
2. "Verbatim" quotes that were quietly cleaned up (disfluencies dropped, words
   reordered) — every word must appear, in order, in the transcript; only
   punctuation/spacing/case may differ.

Usage:
  uv run scripts/verify_reel.py --transcript {transcript.md} --highlights {highlights.json}
      [--takeaways {takeaways.md}] [--fix] [--pad 15]

--fix snaps out-of-window clip bounds into the nearest containing chunk window
(rewrites the highlights file). Quotes are never auto-fixed: a flagged quote
means re-extract it from the transcript verbatim.

Exit code 0 when everything passes (after any --fix), 1 otherwise.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
import pathlib
from pathlib import Path

PLUGIN_ROOT = pathlib.Path(__file__).resolve().parents[3]

CHUNK_RE = re.compile(r"\[(\d+):(\d+)(?::(\d+))?[–-](\d+):(\d+)(?::(\d+))?\]")


def parse_windows(transcript_text: str) -> list[tuple[float, float]]:
    """Parse [mm:ss–mm:ss] and [h:mm:ss–h:mm:ss] chunk headers (mixed allowed)."""
    windows: list[tuple[float, float]] = []
    for m in CHUNK_RE.finditer(transcript_text):
        g = m.groups()
        start = (int(g[0]) * 3600 + int(g[1]) * 60 + int(g[2])
                 if g[2] is not None else int(g[0]) * 60 + int(g[1]))
        end = (int(g[3]) * 3600 + int(g[4]) * 60 + int(g[5])
               if g[5] is not None else int(g[3]) * 60 + int(g[4]))
        windows.append((float(start), float(end)))
    for m in re.finditer(r"^## (\d+(?:\.\d+)?)s - (\d+(?:\.\d+)?)s$", transcript_text, re.MULTILINE):
        windows.append((float(m[1]), float(m[2])))
    return windows


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def snap(start: float, end: float, windows: list[tuple[float, float]], pad: float):
    for a, b in windows:
        if start >= a - pad and end <= b + pad:
            return max(start, a), min(end, b), True
    # nearest window: clamp into it
    best = min(windows, key=lambda w: min(abs(start - w[0]), abs(end - w[1])))
    return best[0], best[1], False


def main() -> None:
    ap = argparse.ArgumentParser(description="Verify highlight reel metadata against transcript.")
    ap.add_argument("--transcript", required=True)
    ap.add_argument("--highlights", required=True)
    ap.add_argument("--takeaways", default="")
    ap.add_argument("--fix", action="store_true")
    ap.add_argument("--pad", type=float, default=15.0)
    args = ap.parse_args()

    hpath = Path(args.highlights).expanduser()
    if not hpath.is_absolute():
        sys.exit("error: --highlights must be absolute")
    if hpath.resolve() == PLUGIN_ROOT or PLUGIN_ROOT in hpath.resolve().parents:
        sys.exit("error: --highlights must be outside the plugin (it is rewritten with --fix)")
    tpath = Path(args.transcript).expanduser()
    transcript = tpath.read_text(encoding="utf-8")
    windows = parse_windows(transcript)
    cj = tpath.parent / "chunks.json"
    if windows and cj.is_file():
        try:
            metadata = json.loads(cj.read_text(encoding="utf-8"))
            rich = [(float(c["start_seconds"]), float(c["end_seconds"]))
                    for c in metadata["chunks"]] if isinstance(metadata, dict) else [
                        (float(c["start"]), float(c["end"])) for c in metadata]
            if len(rich) > len(windows):
                windows = rich
        except (ValueError, KeyError, TypeError):
            pass
    if not windows or any(not math.isfinite(a) or not math.isfinite(b) or a < 0 or b <= a for a, b in windows):
        sys.exit("error: no [start-end] chunk headers found in transcript")
    tn = norm(transcript)

    clips = json.loads(hpath.read_text(encoding="utf-8"))
    problems = 0

    for clip in clips:
        st, en = float(clip["start_sec"]), float(clip["end_sec"])
        if not math.isfinite(st) or not math.isfinite(en) or st < 0 or en <= st:
            clip["verified"] = False
            print(f"INVALID {clip.get('title', '')[:40]} requires finite 0 <= start < end")
            problems += 1
            continue
        if en - st > 240:
            print(f"LONG  {clip.get('title','')[:40]} ({en - st:.0f}s > 240s)")
            problems += 1
        if any(st >= a - args.pad and en <= b + args.pad for a, b in windows):
            clip["verified"] = True
        else:
            new_st, new_en, _ = snap(st, en, windows, args.pad)
            if args.fix:
                clip["start_sec"], clip["end_sec"] = round(new_st, 3), round(new_en, 3)
                clip["verified"] = True
                print(f"FIX   {clip.get('title','')[:40]} {st:.0f}-{en:.0f} -> {new_st:.0f}-{new_en:.0f}")
            else:
                clip["verified"] = False
                print(f"OUT   {clip.get('title','')[:40]} {st:.0f}-{en:.0f} outside every chunk window")
                problems += 1

    if args.fix:
        hpath.write_text(json.dumps(clips, indent=2) + "\n", encoding="utf-8")
        print(f"wrote verified highlights to {args.highlights}")

    if args.takeaways:
        md = Path(args.takeaways).expanduser().read_text(encoding="utf-8")
        quotes = [q for q in re.findall(r'[\u201c"]([^\u201c"\n`]{8,})[\u201d"]', md)]
        def verbatim(q: str) -> bool:
            nq = norm(q)
            if not nq:
                return False
            return re.search(rf"(?:^| )({re.escape(nq)})(?: |$)", tn) is not None

        bad = [q for q in quotes if not verbatim(q)]
        for q in bad:
            print(f"QUOTE not verbatim: {q[:80]}")
        print(f"quotes: {len(quotes) - len(bad)}/{len(quotes)} verbatim")
        problems += len(bad)

    ok = all(c.get("verified", True) for c in clips) and problems == 0
    print("PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
