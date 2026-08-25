#!/usr/bin/env bash
# Infer a query from agent notes and fetch external material.

set -euo pipefail

readonly RESEARCH_FILE=".auto/research.md"
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
mkdir -p "$(dirname "$workdir/$RESEARCH_FILE")"
# Replace search-cli with the user-approved search tool for this environment.
search-cli "$query" -n "$RESULT_LIMIT" > "$workdir/$RESEARCH_FILE"
echo "Research saved to $RESEARCH_FILE for query: $query"
