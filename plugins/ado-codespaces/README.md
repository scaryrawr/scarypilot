# ADO Codespaces

`ado-codespaces` lets a Copilot session supervise Azure DevOps coding agents in
GitHub Codespaces. The extension starts one local supervisor process and exposes
tools to manage Codespaces and the agents running inside them.

## Prerequisites

- A current GitHub Copilot CLI release with plugin extension support.
- Node.js 22.18 or later.
- GitHub CLI with the `ado-codespaces` extension installed and authenticated.
- `gh ado-codespaces agent serve` must be available in the shell where Copilot
  starts.

After installing, call `codespaces_list` to start the supervisor and verify it.
The tool returns the startup error when GitHub CLI, its extension, or
authentication is unavailable.

The supervisor handles Azure authentication, Codespaces lifecycle, agent
execution, and transport to a Codespace. This plugin does not implement those
operations.

## Install

```sh
copilot plugin marketplace add scaryrawr/scarypilot
copilot plugin install ado-codespaces@scarypilot
```

Restart Copilot or run `/clear` after installing or updating the plugin.

## Usage

Ask Copilot to list or inspect Codespaces, start one when needed, then start an
agent with a task. The extension registers these tools:

| Tool | Operation |
| --- | --- |
| `codespaces_list` | List available Codespaces. |
| `codespaces_status` | Read one Codespace's status. |
| `codespaces_start` | Start one Codespace. |
| `codespaces_stop` | Stop one Codespace. |
| `agent_start` | Start an agent in a Codespace. |
| `agent_send` | Send a follow-up prompt to an agent. |
| `agent_status` | Read one agent's status. |
| `agent_stop` | Stop one agent. |
| `agent_events` | Drain ordered output events for an agent. |

Start an agent with its `agent_id` and Codespace name. Send its task with
`agent_send`. `agent_start` does not grant broad permissions by default. Set
`approve_all_permissions` to `true` only when you want the agent to act without
individual permission prompts. State that choice in the request. Keep it false
or omit it for normal work.

The tools return concise JSON. `agent_events` returns remote agent output in
sequence order. It reports dropped-event metadata when the bounded local buffer
overflows. The extension never puts event content in the Copilot session log.
When the Copilot session ends, it asks the supervisor to shut down and then
terminates the child process if it remains alive.

## Develop and test

```sh
cd plugins/ado-codespaces/extensions/ado-codespaces
npm install
npm run format:check
npm run lint
npm run typecheck
npm test
```

Copilot CLI injects its bundled `@github/copilot-sdk` when it loads the
extension. The package dependency pins the SDK for local development and tests.

## Resources

- [GitHub Copilot CLI plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference)
- [GitHub CLI extension documentation](https://docs.github.com/github-cli/github-cli/creating-github-cli-extensions)
