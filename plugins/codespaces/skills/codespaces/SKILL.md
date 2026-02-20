---
name: codespaces
description: Connect to and interact with GitHub Codespaces. Manages connections via gh ado-codespaces (port forwarding, Azure auth), runs commands via gh cs ssh, invokes Copilot CLI remotely, and supports multiple codespaces.
---

# Codespaces Skill

Use `gh ado-codespaces` and `gh cs ssh` to connect to and work inside GitHub Codespaces. One persistent background connection per codespace handles port forwarding and Azure auth; all command execution goes through `gh cs ssh`.

## Discovering Codespaces

```bash
gh cs list
```

The output includes codespace name, repository, branch, and state. Only `Running` codespaces can be connected to. To start a stopped codespace:

```bash
gh cs start -c {codespace-name}
```

## Connection Lifecycle

### First connection to a codespace

Use the helper script to start `gh ado-codespaces` in a background local tmux session. The script is a no-op if the session already exists (enforcing the one-connection-per-codespace rule).

```bash
./scripts/ensure-connection.sh {codespace-name}
```

The script creates a local tmux session named `cs-{codespace-name}` on the agent socket (`${CLAUDE_TMUX_SOCKET_DIR:-${TMPDIR:-/tmp}/claude-tmux-sockets}/claude.sock`).

After starting a connection, always tell the user how to monitor it:

```
To monitor the connection session yourself:
  SOCKET="${CLAUDE_TMUX_SOCKET_DIR:-${TMPDIR:-/tmp}/claude-tmux-sockets}/claude.sock"
  tmux -S "$SOCKET" attach -t cs-{codespace-name}
```

### Subsequent commands

Use `gh cs ssh` directly — no new background process needed:

```bash
gh cs ssh -c {codespace-name} -- {command}
```

For multi-step pipelines, compose inline:

```bash
gh cs ssh -c {codespace-name} -- bash -c 'cd /workspaces/myrepo && npm test 2>&1'
```

## Running Copilot CLI on the Codespace

Each codespace has Copilot CLI installed. Invoke it remotely via `gh cs ssh`:

```bash
gh cs ssh -c {codespace-name} -- copilot {args}
```

Examples:

```bash
# Ask a question
gh cs ssh -c {codespace-name} -- copilot ask "explain the auth module"

# Explain a specific file
gh cs ssh -c {codespace-name} -- bash -c 'cd /workspaces/myrepo && copilot explain src/auth.ts'
```

## Working with Multiple Codespaces

Each codespace is independent. Call `ensure-connection.sh` for each before issuing commands, then aggregate results locally.

```bash
# Connect to both codespaces
./scripts/ensure-connection.sh my-api-main
./scripts/ensure-connection.sh my-ui-main

# Query both
gh cs ssh -c my-api-main -- cat /workspaces/api/src/types.ts
gh cs ssh -c my-ui-main  -- cat /workspaces/ui/src/types.ts
```

Then compare or synthesize the results locally.

## Accessing Codespace-Internal tmux

The codespace itself may have tmux sessions running (e.g., a dev server). Access them via `gh cs ssh`:

```bash
# List internal tmux sessions
gh cs ssh -c {codespace-name} -- tmux list-sessions

# Capture output from an internal pane
gh cs ssh -c {codespace-name} -- tmux capture-pane -p -J -t {session}:0.0 -S -200

# Send a command to an internal tmux session
gh cs ssh -c {codespace-name} -- tmux send-keys -t {session}:0.0 'npm run dev' Enter
```

Note: this interacts with tmux *inside* the codespace, not the local agent tmux managing the connection.

## Cleanup

Kill a codespace connection (stops port forwarding and services):

```bash
SOCKET="${CLAUDE_TMUX_SOCKET_DIR:-${TMPDIR:-/tmp}/claude-tmux-sockets}/claude.sock"
tmux -S "$SOCKET" kill-session -t cs-{codespace-name}
```

Kill all codespace connection sessions:

```bash
SOCKET="${CLAUDE_TMUX_SOCKET_DIR:-${TMPDIR:-/tmp}/claude-tmux-sockets}/claude.sock"
tmux -S "$SOCKET" list-sessions -F '#{session_name}' \
  | grep '^cs-' \
  | xargs -r -n1 tmux -S "$SOCKET" kill-session -t
```

## Troubleshooting

| Symptom | Likely Cause | Action |
|---------|-------------|--------|
| `gh cs ssh` times out | Codespace is stopped | `gh cs start -c {name}`, then retry |
| `gh ado-codespaces` already running message | Session exists | No action needed; `ensure-connection.sh` is idempotent |
| Auth errors on the codespace | Azure auth not refreshed | Kill the session and re-run `ensure-connection.sh` |
| `gh cs list` shows no codespaces | Not authenticated | `gh auth login` |
