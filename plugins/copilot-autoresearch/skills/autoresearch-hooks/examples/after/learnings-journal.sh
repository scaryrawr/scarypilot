#!/usr/bin/env bash
# Append one human-readable line per run to a file that survives discard.

set -euo pipefail

readonly LEARNINGS_FILE=".auto/learnings.md"

input="$(cat)"
file="$(jq -r '.cwd' <<<"$input")/$LEARNINGS_FILE"
mkdir -p "$(dirname "$file")"
printf 'run=%s status=%s metric=%s hyp=%s\n' \
  "$(jq -r '.run_entry.run' <<<"$input")" \
  "$(jq -r '.run_entry.status' <<<"$input")" \
  "$(jq -r '.run_entry.metric' <<<"$input")" \
  "$(jq -r '.run_entry.asi.hypothesis // "-"' <<<"$input")" >> "$file"
