#!/usr/bin/env bash
# Keep the prompt preamble and archive its tail when it grows too large.

set -euo pipefail

readonly MAX_BYTES=$((20 * 1024))
readonly KEEP_LINES=80

resolve_prompt() {
  [ -f "$1/.auto/prompt.md" ] && { echo "$1/.auto/prompt.md"; return; }
  echo "$1/autoresearch.md"
}

input="$(cat)"
prompt="$(resolve_prompt "$(jq -r '.cwd' <<<"$input")")"
[ -f "$prompt" ] && [ "$(wc -c < "$prompt")" -gt "$MAX_BYTES" ] || exit 0

archive="${prompt%.md}.archive.md"
tail -n +$((KEEP_LINES + 1)) "$prompt" >> "$archive"
head -n "$KEEP_LINES" "$prompt" > "$prompt.tmp"
mv "$prompt.tmp" "$prompt"
echo "Rotated $prompt; kept the first $KEEP_LINES lines and archived the rest."
