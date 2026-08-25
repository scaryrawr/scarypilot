#!/usr/bin/env bash
# Tag every new best so `git log --tags` becomes a progression record.

set -euo pipefail

readonly TAG_PREFIX="autoresearch/best-run"

is_new_best() {
  local status="$1" metric="$2" best="$3"
  [ "$status" = "keep" ] && [ -n "$best" ] && [ "$metric" = "$best" ]
}

tag_name_for() {
  local run="$1" metric="$2"
  printf '%s-%s-%s' "$TAG_PREFIX" "$run" "$(printf '%g' "$metric")"
}

input="$(cat)"
status=$(jq -r '.run_entry.status' <<<"$input")
metric=$(jq -r '.run_entry.metric' <<<"$input")
best=$(jq -r '.session.best_metric // empty' <<<"$input")
is_new_best "$status" "$metric" "$best" || exit 0

workdir=$(jq -r '.cwd' <<<"$input")
run=$(jq -r '.run_entry.run' <<<"$input")
git -C "$workdir" tag -f "$(tag_name_for "$run" "$metric")" >/dev/null
