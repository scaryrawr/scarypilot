#!/usr/bin/env bash
# Ask a cheap model to critique a discarded hypothesis.

set -euo pipefail

readonly MODEL="claude-haiku-4-5"

input="$(cat)"
[ "$(jq -r '.last_run.status // empty' <<<"$input")" = "discard" ] || exit 0

hypothesis=$(jq -r '.last_run.asi.hypothesis // "unknown"' <<<"$input")
reason=$(jq -r '.last_run.asi.rollback_reason // "unknown"' <<<"$input")
prompt="Hypothesis \"$hypothesis\" was discarded because: $reason.
Name two adjacent directions that might work instead. One sentence each."
# Replace llm-cli with a user-approved local or hosted model command.
llm-cli --model "$MODEL" --prompt "$prompt"
