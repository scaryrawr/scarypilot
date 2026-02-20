# Codespaces Plugin

Connect to and interact with GitHub Codespaces via `gh ado-codespaces` and `gh cs ssh`. Enables the agent to run commands, invoke Copilot CLI, and reason across multiple codespaces simultaneously.

## What This Plugin Does

- Connects to codespaces using `gh ado-codespaces` (port forwarding, Azure auth, and enriched remote development services)
- Enforces one `gh ado-codespaces` connection per codespace, tracked as a local tmux session
- Runs commands on codespaces via `gh cs ssh`
- Invokes Copilot CLI installed on the codespace remotely
- Supports working across multiple codespaces in the same session
- Provides access to any tmux sessions running inside the codespace

## Prerequisites

- [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated
- [`gh ado-codespaces`](https://github.com/scaryrawr/gh-ado-codespaces) extension installed:
  ```bash
  gh extension install scaryrawr/gh-ado-codespaces
  ```
- [tmux](https://github.com/tmux/tmux) installed locally:
  - macOS: `brew install tmux`
  - Linux: `apt-get install tmux`
- The **tmux** plugin is also recommended for advanced session management:
  ```bash
  copilot plugin install tmux@scarypilot
  ```

## Installation

```bash
copilot plugin marketplace add scaryrawr/scarypilot
copilot plugin install codespaces@scarypilot
```

## Usage Examples

**Connect to a codespace and run a command:**

```text
"Connect to my codespace my-repo-main and run the tests"
```

**Run Copilot CLI on a codespace:**

```text
"On my codespace my-repo-main, ask copilot to explain the auth module"
```

**Work across multiple codespaces:**

```text
"Check the API codespace my-api-main and the frontend codespace my-ui-main — do the interface types match?"
```

**Access a tmux session inside the codespace:**

```text
"Connect to my codespace and attach to the tmux session running the dev server"
```

## Notes

- `gh ado-codespaces` sets up port forwarding, Azure auth, and additional services — only one instance runs per codespace. The `ensure-connection.sh` helper manages this automatically.
- Additional commands are sent over `gh cs ssh`, so the background connection stays alive without interference.
- Codespaces must be running (not stopped) before connecting. Use `gh cs list` to check status.

## Resources

- [GitHub CLI Codespaces docs](https://cli.github.com/manual/gh_codespace)
- [gh-ado-codespaces](https://github.com/scaryrawr/gh-ado-codespaces)
