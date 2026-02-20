#!/usr/bin/env bash
set -euo pipefail

# ensure-connection.sh — Start gh ado-codespaces for a codespace in a local tmux
# session if not already running. Enforces one connection per codespace.
#
# Usage: ./ensure-connection.sh <codespace-name>

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <codespace-name>" >&2
  exit 1
fi

CODESPACE_NAME="$1"

# Validate: GitHub codespace names are lowercase alphanumeric + hyphens only.
if [[ ! "$CODESPACE_NAME" =~ ^[a-zA-Z0-9-]+$ ]]; then
  echo "Error: invalid codespace name '$CODESPACE_NAME'" >&2
  exit 1
fi

SESSION_NAME="cs-${CODESPACE_NAME}"

SOCKET_DIR="${CLAUDE_TMUX_SOCKET_DIR:-${TMPDIR:-/tmp}/claude-tmux-sockets}"
mkdir -p "$SOCKET_DIR"
SOCKET="$SOCKET_DIR/claude.sock"

# Check if the session already exists.
if tmux -S "$SOCKET" has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "Connection session '$SESSION_NAME' already running." >&2
  echo "$SOCKET"
  exit 0
fi

# Start gh ado-codespaces in a detached tmux session.
tmux -S "$SOCKET" new-session -d -s "$SESSION_NAME" -n connection \
  "gh ado-codespaces $(printf '%q' "$CODESPACE_NAME"); echo '[gh ado-codespaces exited]'"

echo "Started connection session '$SESSION_NAME'." >&2
echo "Monitor with:" >&2
echo "  tmux -S $SOCKET attach -t $SESSION_NAME" >&2
echo ""
echo "$SOCKET"
