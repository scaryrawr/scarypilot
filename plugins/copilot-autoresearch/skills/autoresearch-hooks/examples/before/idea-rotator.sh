#!/usr/bin/env bash
# Surface the first unchecked idea as a steer nudge.

set -euo pipefail

resolve_ideas() {
  [ -f "$1/.auto/ideas.md" ] && { echo "$1/.auto/ideas.md"; return; }
  [ -f "$1/autoresearch.ideas.md" ] && echo "$1/autoresearch.ideas.md"
  return 0
}

input="$(cat)"
ideas="$(resolve_ideas "$(jq -r '.cwd' <<<"$input")")"
[ -n "$ideas" ] && [ -f "$ideas" ] || exit 0

next=$(grep -m1 -E '^- \[ \]' "$ideas" | sed 's/^- \[ \] //' || true)
[ -n "$next" ] || exit 0
echo "Next idea from $ideas: $next"
