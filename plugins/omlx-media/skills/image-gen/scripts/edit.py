#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# ///
"""Edit images through an OpenAI-compatible endpoint."""

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
        sys.exit("error: --output must be outside the skill")
    return resolved


def image_mime_type(path: Path) -> str:
    """Return a MIME type for supported image extensions."""
    return {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
    }.get(path.suffix.lower(), "image/png")


def data_uri(path: Path) -> str:
    """Encode an image file as a data URI."""
    if not path.is_file():
        sys.exit(f"error: input file not found: {path}")
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{image_mime_type(path)};base64,{encoded}"


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
        sys.exit(f"error: image edit API failed ({exc.code}): {details}")
    except urllib.error.URLError as exc:
        sys.exit(f"error: image edit API request failed: {exc.reason}")

    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError as exc:
        sys.exit(f"error: image edit API returned invalid JSON: {exc}")
    if parsed.get("error"):
        error = parsed["error"]
        message = error.get("message") if isinstance(error, dict) else error
        sys.exit(f"error from image edit API: {message}")
    return parsed


def download(url: str, output: Path) -> None:
    """Download a URL to an output file."""
    try:
        with urllib.request.urlopen(url, timeout=300) as response:
            output.write_bytes(response.read())
    except urllib.error.URLError as exc:
        sys.exit(f"error: image download failed: {exc.reason}")


def output_for_index(output: Path, index: int, count: int) -> Path:
    """Return the output path for one edited image."""
    if count <= 1:
        return output
    return output.with_name(f"{output.stem}_{index}{output.suffix or '.png'}")


def optional_number(value: str, flag: str) -> float | int | None:
    """Parse an optional numeric CLI value."""
    if not value:
        return None
    try:
        parsed = float(value)
    except ValueError:
        sys.exit(f"error: {flag} must be numeric")
    return int(parsed) if parsed.is_integer() else parsed


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", default="")
    parser.add_argument("--inputs", nargs="+", default=[])
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--mask", default="")
    parser.add_argument("--n", type=int, default=1)
    parser.add_argument("--size", default="")
    parser.add_argument("--steps", default="")
    parser.add_argument("--guidance", default="")
    parser.add_argument("--image_strength", default="")
    parser.add_argument("--response_format", default="b64_json", choices=("b64_json", "url"))
    parser.add_argument("--output", default="")
    args = parser.parse_args()

    base_url = os.environ.get("OMLX_BASE_URL", "").rstrip("/")
    if not base_url:
        sys.exit("error: OMLX_BASE_URL environment variable must be set")
    if args.n < 1:
        sys.exit("error: --n must be a positive integer")

    input_files = [Path(p).expanduser() for p in (args.inputs or ([args.input] if args.input else []))]
    if not input_files:
        sys.exit("error: --input or --inputs is required")

    output = resolve_output_path(args.output or f"edited_{args.model}.png")
    output.parent.mkdir(parents=True, exist_ok=True)

    body: dict[str, Any] = {
        "prompt": args.prompt,
        "model": args.model,
        "images": [{"image_url": data_uri(path)} for path in input_files],
        "n": args.n,
        "size": args.size,
        "response_format": args.response_format,
    }
    if args.mask:
        mask = Path(args.mask).expanduser()
        body["mask"] = {"image_url": data_uri(mask)}
    for field, flag in (("steps", "--steps"), ("guidance", "--guidance"), ("image_strength", "--image_strength")):
        parsed = optional_number(getattr(args, field), flag)
        if parsed is not None:
            body[field] = parsed

    response = request_json(f"{base_url}/v1/images/edits", body)
    data = response.get("data") or []
    if not data:
        sys.exit(f"error: image edit API response did not contain any data: {response}")

    for index, item in enumerate(data):
        out_file = output_for_index(output, index, len(data))
        if out_file == SKILL_ROOT or SKILL_ROOT in out_file.parents:
            sys.exit(f"error: refusing to write edited image inside the skill directory: {out_file}")
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
