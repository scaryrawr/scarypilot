#!/usr/bin/env bash
# Query a local qmd documentation collection using agent notes.

set -euo pipefail

readonly DOCS_FILE=".auto/docs.md"
readonly RESULT_LIMIT=5

input="$(cat)"
query=$(
  jq -r '
    .last_run.asi.next_action_hint //
    .last_run.asi.hypothesis //
    .last_run.description //
    .session.goal //
    empty
  ' <<<"$input"
)
[ -n "$query" ] || exit 0

workdir="$(jq -r '.cwd' <<<"$input")"
mkdir -p "$(dirname "$workdir/$DOCS_FILE")"
qmd query "$query" -n "$RESULT_LIMIT" > "$workdir/$DOCS_FILE"
echo "Docs saved to $DOCS_FILE for query: $query"
