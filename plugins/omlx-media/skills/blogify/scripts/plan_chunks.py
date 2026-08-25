#!/usr/bin/env python3
"""Turn an ffmpeg silencedetect log into transcription chunk boundaries.

Reads a silencedetect log, derives speech intervals (the gaps between
silences), then greedily merges speech into chunks up to MAX_LEN seconds,
cutting only at silence boundaries so words are never split mid-utterance.
Pure-silence spans are skipped entirely, which both speeds up transcription
and avoids empty/hallucinated chunks.

Usage:
    plan_chunks.py <silence_log> <total_duration_sec> [max_len_sec]

Prints a JSON array of {"i", "start", "end"} to stdout and a one-line
summary to stderr.
"""
import json
import re
import sys

DEFAULT_MAX_LEN = 120.0  # max chunk length in seconds


def parse_silences(path):
    starts, ends = [], []
    for line in open(path, encoding="utf-8", errors="ignore"):
        match = re.search(r"silence_start:\s*([0-9.]+)", line)
        if match:
            starts.append(float(match.group(1)))
        match = re.search(r"silence_end:\s*([0-9.]+)", line)
        if match:
            ends.append(float(match.group(1)))
    return starts, ends


def speech_intervals(starts, ends, total):
    """Invert silence intervals into speech intervals over [0, total]."""
    silences = []
    end_index = 0
    for start in starts:
        end = ends[end_index] if end_index < len(ends) else total
        silences.append((start, end))
        end_index += 1
    silences.sort()
    speech = []
    cursor = 0.0
    for start, end in silences:
        if start > cursor:
            speech.append((cursor, start))
        cursor = max(cursor, end)
    if cursor < total:
        speech.append((cursor, total))
    return [(a, b) for a, b in speech if b - a > 0.05]


def build_chunks(speech, max_len):
    chunks = []
    chunk_start = chunk_end = None
    for start, end in speech:
        if chunk_start is None:
            chunk_start, chunk_end = start, end
            continue
        # Extend the current chunk across the silence gap while it fits.
        if end - chunk_start <= max_len:
            chunk_end = end
        else:
            chunks.append((chunk_start, chunk_end))
            chunk_start, chunk_end = start, end
    if chunk_start is not None:
        chunks.append((chunk_start, chunk_end))
    return chunks


def main():
    if len(sys.argv) < 3:
        sys.exit("usage: plan_chunks.py <silence_log> <total_duration_sec> [max_len_sec]")
    log_path = sys.argv[1]
    total = float(sys.argv[2])
    max_len = float(sys.argv[3]) if len(sys.argv) > 3 else DEFAULT_MAX_LEN

    starts, ends = parse_silences(log_path)
    speech = speech_intervals(starts, ends, total)
    chunks = build_chunks(speech, max_len)
    out = [{"i": i, "start": round(a, 3), "end": round(b, 3)} for i, (a, b) in enumerate(chunks)]
    print(json.dumps(out))

    speech_secs = sum(b - a for a, b in chunks)
    sys.stderr.write(
        f"{len(out)} chunks, ~{speech_secs:.0f}s speech of {total:.0f}s "
        f"({total - speech_secs:.0f}s silence skipped)\n"
    )


if __name__ == "__main__":
    main()
