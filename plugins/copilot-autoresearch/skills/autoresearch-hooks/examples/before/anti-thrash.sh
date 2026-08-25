#!/usr/bin/env bash
# Suggest a structural rethink after repeated discarded experiments.

set -euo pipefail

readonly WINDOW_SIZE=5
readonly STREAK_THRESHOLD=5

resolve_jsonl() {
  [ -f "$1/.auto/log.jsonl" ] && { echo "$1/.auto/log.jsonl"; return; }
  echo "$1/autoresearch.jsonl"
}

input="$(cat)"
jsonl="$(resolve_jsonl "$(jq -r '.cwd' <<<"$input")")"
[ -f "$jsonl" ] || exit 0
streak=$(
  jq -c 'select(.run != null and (.type // null) != "hook")' "$jsonl" 2>/dev/null \
    | tail -n "$WINDOW_SIZE" \
    | jq -r 'select(.status == "discard") | .run' \
    | wc -l | tr -d ' '
)
[ "$streak" -lt "$STREAK_THRESHOLD" ] || cat <<EOF
$streak consecutive discards. Re-read the prompt and benchmark, measure the
actual bottleneck, and try a structurally different hypothesis.
EOF
