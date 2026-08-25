#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# ///
"""Generate images from text prompts via an OpenAI-compatible endpoint."""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_ROOT = SCRIPT_DIR.parent


def resolve_output_path(value: str) -> Path:
    """Resolve an output path and reject writes inside the skill bundle."""
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = Path.cwd() / path
    resolved = path.resolve()
    if resolved == SKILL_ROOT or SKILL_ROOT in resolved.parents:
        sys.exit(
            "error: refusing to write generated images inside the skill directory; "
            "pass --output outside the skill"
        )
    return resolved


def request_json(url: str, body: dict[str, Any]) -> dict[str, Any]:
    """POST JSON and return the decoded JSON response, surfacing server errors."""
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            payload = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        details = exc.read().decode("utf-8", errors="replace")
        sys.exit(f"error: image generation API failed ({exc.code}): {details}")
    except urllib.error.URLError as exc:
        sys.exit(f"error: image generation API request failed: {exc.reason}")

    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError as exc:
        sys.exit(f"error: image generation API returned invalid JSON: {exc}")
    if parsed.get("error"):
        error = parsed["error"]
        message = error.get("message") if isinstance(error, dict) else error
        sys.exit(f"error from image generation API: {message}")
    return parsed


def download(url: str, output: Path) -> None:
    """Download a URL to an output file."""
    try:
        with urllib.request.urlopen(url, timeout=300) as response:
            output.write_bytes(response.read())
    except urllib.error.URLError as exc:
        sys.exit(f"error: image download failed: {exc.reason}")


def output_for_index(output: Path, index: int, count: int) -> Path:
    """Return the output path for one generated image."""
    if count <= 1:
        return output
    return output.with_name(f"{output.stem}_{index}{output.suffix or '.png'}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--n", type=int, default=1)
    parser.add_argument("--size", default="1024x1024")
    parser.add_argument("--response_format", default="b64_json", choices=("b64_json", "url"))
    parser.add_argument("--quality", default="standard")
    parser.add_argument("--style", default="vivid")
    parser.add_argument("--output", default="")
    args = parser.parse_args()

    base_url = os.environ.get("OMLX_BASE_URL", "").rstrip("/")
    if not base_url:
        sys.exit("error: OMLX_BASE_URL environment variable must be set")
    if args.n < 1:
        sys.exit("error: --n must be a positive integer")

    output = resolve_output_path(args.output or f"generated_{args.model}_{args.n}.png")
    output.parent.mkdir(parents=True, exist_ok=True)

    response = request_json(
        f"{base_url}/v1/images/generations",
        {
            "prompt": args.prompt,
            "model": args.model,
            "n": args.n,
            "size": args.size,
            "response_format": args.response_format,
            "quality": args.quality,
            "style": args.style,
        },
    )
    data = response.get("data") or []
    if not data:
        sys.exit(f"error: image generation API response did not contain any data: {response}")

    for index, item in enumerate(data):
        out_file = output_for_index(output, index, len(data))
        if out_file == SKILL_ROOT or SKILL_ROOT in out_file.parents:
            sys.exit(f"error: refusing to write generated image inside the skill directory: {out_file}")

        if args.response_format == "b64_json":
            b64 = item.get("b64_json")
            if not b64:
                sys.exit(f"error: response data[{index}] did not include b64_json")
            out_file.write_bytes(base64.b64decode(b64))
        else:
            url = item.get("url")
            if not url:
                sys.exit(f"error: response data[{index}] did not include url")
            download(url, out_file)
        print(f"Saved: {out_file}", file=sys.stderr)


if __name__ == "__main__":
    main()
