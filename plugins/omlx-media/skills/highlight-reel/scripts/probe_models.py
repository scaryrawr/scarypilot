#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# ///
"""Probe an OMLX endpoint for which models accept image / audio / video input.

Sends the smallest possible probe of each modality (tiny image, 2s tone, 1s
video) to every VLM and answers 500/400/507 refusals without crashing. Reports
per-model per-modality support plus latency, and emits a routing suggestion:
batch STT -> dedicated audio_stt model via /v1/audio/transcriptions;
audio QA / images -> whichever VLM accepted the modality; video_url -> VLMs
that accepted native video. If a text-only contract task leaks chain-of-thought,
add chat_template_kwargs enable_thinking=false (Qwen-family builds).

Usage:
  uv run --no-project python <installed-skill>/scripts/probe_models.py
      --output <new-absolute-report.json> [--models id1,id2] [--include-stt]

Env: OMLX_BASE_URL (defaults to http://127.0.0.1:8000), OMLX_API_KEY (optional).
Writes a new report to --output and prints each model's observed results.
"""
from __future__ import annotations

import argparse
import base64
import json
import ipaddress
import os
import subprocess
import sys
import time
import tempfile
import urllib.request
from urllib.parse import urlsplit
from pathlib import Path

BASE = os.environ.get("OMLX_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
KEY = os.environ.get("OMLX_API_KEY", "")

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def make_fixtures(tmp: str) -> tuple[str, str, str]:
    img = f"{tmp}/probe_img.png"
    wav = f"{tmp}/probe_tone.wav"
    vid = f"{tmp}/probe_vid.mp4"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i",
                   "color=c=navy:s=320x180:d=0.1", "-frames:v", "1", img], check=True)
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i",
                   "sine=frequency=440:duration=2", "-ac", "1", "-ar", "16000", wav], check=True)
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-t", "1", "-i",
                   "testsrc=size=320x180:rate=10", "-c:v", "libx264", "-preset", "veryfast",
                   "-an", vid], check=True)
    return img, wav, vid


def b64(path: str) -> str:
    return base64.b64encode(open(path, "rb").read()).decode()


def req_json(path: str, body: dict | None = None, timeout: int = 300):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"}
    if KEY:
        headers["Authorization"] = f"Bearer {KEY}"
    r = urllib.request.Request(url, data=data, headers=headers)
    with OPENER.open(r, timeout=timeout) as resp:
        return json.loads(resp.read())


def chat_probe(model: str, part: dict, label: str) -> dict:
    body = {"model": model, "max_tokens": 24, "temperature": 0.0,
            "messages": [{"role": "user", "content": [
                part, {"type": "text", "text": "Reply in <=10 words."}]}]}
    t0 = time.time()
    try:
        d = req_json("/v1/chat/completions", body)
        content = d["choices"][0]["message"]["content"] or ""
        return {"modality": label, "ok": True, "secs": round(time.time() - t0, 1),
                "sample": content[:80]}
    except urllib.error.HTTPError as e:
        return {"modality": label, "ok": False, "status": e.code,
                "hint": {507: "server cannot accept this modality or is out of memory",
                       500: "model build rejects this content type",
                       400: "wrong endpoint or content schema"}.get(e.code, "")}
    except Exception as e:
        return {"modality": label, "ok": False, "error": str(e)[:120]}


def main() -> None:
    ap = argparse.ArgumentParser(description="Probe OMLX modality support.")
    ap.add_argument("--models", default="")
    ap.add_argument("--include-stt", action="store_true",
                    help="also test the batch /v1/audio/transcriptions route on audio_stt models")
    ap.add_argument("--force", action="store_true",
                    help="probe models above --max-gb too (they may thrash RAM when loaded)")
    ap.add_argument("--max-gb", type=float, default=12.0,
                    help="skip models whose estimated size exceeds this (protects the memory guard)")
    ap.add_argument("--tmp", help="existing parent for private temporary probe fixtures")
    ap.add_argument("--output", required=True, help="new absolute workspace report path")
    ap.add_argument("--allow-remote", action="store_true", help="explicit consent to a non-loopback endpoint")
    args = ap.parse_args()

    out = Path(args.output).expanduser()
    plugin_root = Path(__file__).resolve().parents[3]
    if not out.is_absolute() or out.resolve() == plugin_root or plugin_root in out.resolve().parents:
        sys.exit("error: --output must be an absolute path outside the plugin")
    if out.exists() or out.is_symlink() or not out.parent.is_dir():
        sys.exit("error: --output must be new with an existing parent")
    if args.tmp:
        parent = Path(args.tmp).expanduser().resolve()
        if parent == plugin_root or plugin_root in parent.parents:
            sys.exit("error: --tmp must be outside the plugin")
        args.tmp = str(parent)
    endpoint = urlsplit(BASE)
    if endpoint.scheme not in ("http", "https") or not endpoint.hostname or endpoint.username or endpoint.password:
        sys.exit("error: invalid OMLX_BASE_URL")
    try:
        local = ipaddress.ip_address(endpoint.hostname).is_loopback
    except ValueError:
        local = False
    if not local and not args.allow_remote:
        sys.exit("error: non-loopback probing requires explicit --allow-remote consent")

    forced = set(t.strip() for t in args.models.split(",") if t.strip())
    catalog = req_json("/v1/models/status")["models"]
    by_id = {m["id"]: m for m in catalog}
    if args.models:
        targets = [t for t in args.models.split(",") if t in by_id]
    else:
        targets = []
        for m in catalog:
            if m.get("engine_type") == "audio_stt":
                if not args.include_stt:
                    continue
            elif m.get("engine_type") != "vlm":
                continue
            size_gb = (m.get("estimated_size") or 0) / 1e9
            if m["id"] not in forced and not args.force and size_gb > args.max_gb \
                    and m.get("engine_type") != "audio_stt":
                print(f"skip {m['id']} (~{size_gb:.0f} GB > --max-gb; pass --force to probe)")
                continue
            targets.append(m["id"])

    temporary = tempfile.TemporaryDirectory(prefix="omlx-probe-", dir=args.tmp)
    img, wav, vid = make_fixtures(temporary.name)
    report = []
    for mid in targets:
        engine = by_id[mid].get("engine_type", "")
        row = {"model": mid, "engine": engine, "probes": []}
        if engine == "audio_stt":
            # batch ASR route only; do not flood chat completions with audio
            boundary = "----omlxprobe70f3"
            with open(wav, "rb") as fh:
                audio = fh.read()
            body = (
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\n{mid}\r\n"
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
                f"filename=\"probe.wav\"\r\nContent-Type: audio/wav\r\n\r\n"
            ).encode() + audio + f"\r\n--{boundary}--\r\n".encode()
            headers = {"Content-Type": f"multipart/form-data; boundary={boundary}"}
            if KEY:
                headers["Authorization"] = f"Bearer {KEY}"
            t0 = time.time()
            try:
                r = urllib.request.Request(BASE + "/v1/audio/transcriptions", data=body, headers=headers)
                with OPENER.open(r, timeout=300) as resp:
                    ok = resp.status == 200
                row["probes"].append({"modality": "audio/transcriptions", "ok": ok,
                                      "secs": round(time.time() - t0, 1)})
            except urllib.error.HTTPError as e:
                row["probes"].append({"modality": "audio/transcriptions", "ok": False,
                                      "status": e.code})
        else:
            row["probes"].append(chat_probe(mid, {"type": "image_url", "image_url":
                {"url": "data:image/png;base64," + b64(img)}}, "image"))
            row["probes"].append(chat_probe(mid, {"type": "input_audio", "input_audio":
                {"data": b64(wav), "format": "wav"}}, "audio"))
            row["probes"].append(chat_probe(mid, {"type": "video_url", "video_url":
                {"url": "data:video/mp4;base64," + b64(vid)}}, "video"))
        report.append(row)
        marks = {p["modality"]: "OK" if p["ok"] else f"NO({p.get('status', '?')})"
                 for p in row["probes"]}
        print(f"{mid:38s} {marks}")

    with open(out, "x", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    temporary.cleanup()
    print(f"\nwrote {out}")


if __name__ == "__main__":
    main()
