"""Shared utilities for skill-creator scripts.

Modified from Anthropic's skill-creator distribution with stdlib-only YAML
frontmatter parsing helpers and slug utilities. Original project copyright and
Apache-2.0 license are retained in ../LICENSE.txt.

ScaryPilot modifications: reject invalid or unsupported frontmatter syntax
and non-string plain scalars for required string fields.
"""

from __future__ import annotations

import json
import re
from pathlib import Path


def parse_frontmatter_text(frontmatter_text: str) -> dict:
    """Parse the small YAML subset used by SKILL.md frontmatter.

    This avoids requiring PyYAML for validation/packaging. It supports simple
    scalar values and block scalars (|, >, |-, >-) for top-level keys.
    """
    result: dict[str, str] = {}
    lines = frontmatter_text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if not line.strip() or line.lstrip().startswith("#"):
            i += 1
            continue
        if line.startswith((" ", "\t")) or ":" not in line:
            raise ValueError(f"Expected a top-level key: {line!r}")
        key, value = line.split(":", 1)
        key = key.strip()
        if not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_-]*", key) or key in result:
            raise ValueError(f"Invalid or duplicate key: {key!r}")
        value = value.strip()
        if value in {"|", ">", "|-", ">-"}:
            block: list[str] = []
            i += 1
            while i < len(lines) and (lines[i].startswith("  ") or not lines[i].strip()):
                if not lines[i].strip():
                    block.append("")
                else:
                    block.append(lines[i].strip())
                i += 1
            result[key] = "\n".join(block) if value.startswith("|") else " ".join(x for x in block if x)
            continue
        if value.startswith('"'):
            value = json.loads(value)
        elif value.startswith("'"):
            if not re.fullmatch(r"'(?:[^']|'')*'", value):
                raise ValueError("Invalid single-quoted scalar")
            value = value[1:-1].replace("''", "'")
        elif value:
            if value[0] in "-?:,[]{}#&*!|>'\"%@`" or re.search(r":(?:\s|$)|\s#", value):
                raise ValueError(f"Quote this scalar or use a block scalar: {value!r}")
            if key in {"name", "description"} and (
                value.lower() in {"null", "~", "true", "false", "yes", "no", "on", "off", ".nan", ".inf", "+.inf", "-.inf"}
                or re.fullmatch(
                    r"[+]?(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|"
                    r"[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][+-]?[0-9_]+)?|"
                    r"\.[0-9_]+(?:[eE][+-]?[0-9_]+)?)",
                    value,
                )
            ):
                raise ValueError(f"{key} must be a string; quote the scalar {value!r}")
        result[key] = value
        i += 1
    return result


def parse_skill_md(skill_path: Path) -> tuple[str, str, str]:
    """Parse a SKILL.md file, returning (name, description, full_content)."""
    content = (skill_path / "SKILL.md").read_text()
    lines = content.split("\n")

    if not lines or lines[0].strip() != "---":
        raise ValueError("SKILL.md missing frontmatter (no opening ---)")

    end_idx = None
    for i, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            end_idx = i
            break

    if end_idx is None:
        raise ValueError("SKILL.md missing frontmatter (no closing ---)")

    frontmatter = parse_frontmatter_text("\n".join(lines[1:end_idx]))
    name = str(frontmatter.get("name", "")).strip()
    description = str(frontmatter.get("description", "")).strip()
    return name, description, content


def safe_slug(text: str, max_len: int = 48) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", text.strip().lower()).strip("-")
    slug = re.sub(r"-+", "-", slug)
    return (slug or "eval")[:max_len].strip("-") or "eval"
