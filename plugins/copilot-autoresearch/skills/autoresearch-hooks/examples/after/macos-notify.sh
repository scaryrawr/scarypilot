#!/usr/bin/env bash
# Show a native macOS notification only when a kept run is the new best.

set -euo pipefail

readonly TITLE="autoresearch: new best"

input="$(cat)"
status=$(jq -r '.run_entry.status' <<<"$input")
metric=$(jq -r '.run_entry.metric' <<<"$input")
best=$(jq -r '.session.best_metric // empty' <<<"$input")
[ "$status" = "keep" ] && [ -n "$best" ] && [ "$metric" = "$best" ] || exit 0

name=$(jq -r '.session.metric_name' <<<"$input")
unit=$(jq -r '.session.metric_unit // ""' <<<"$input")
body="$name = $metric$unit"
osascript -e "display notification \"$body\" with title \"$TITLE\"" >/dev/null
echo "New best: $body"
