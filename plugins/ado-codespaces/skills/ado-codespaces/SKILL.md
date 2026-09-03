---
name: ado-codespaces
description: "Supervise Azure DevOps coding agents running in GitHub Codespaces. Use when asked to list, start, stop, inspect, or message these Codespaces or agents."
---

# ADO Codespaces supervisor

Use the native `codespaces_*` and `agent_*` tools. Do not use SSH, Azure CLI
commands, browser automation, MCP tools, task agents, session history, or
sidebar APIs for this workflow.

## Check prerequisites

Call `codespaces_list` before managing a Codespace. The call starts the
supervisor. If it returns a startup error, stop and report it. Read
[prerequisites](references/prerequisites.md) for installation and authentication
requirements.

## Run an agent

1. Call `codespaces_list` and `codespaces_status` to select a ready Codespace.
2. Call `codespaces_start` when the selected Codespace is stopped. Check status
   again before starting an agent.
3. Call `agent_start` with the Codespace name and agent ID. Add a working
   directory only when the task needs one.
4. Call `agent_send` with the agent ID and task prompt.
5. Call `agent_events` after each send. Use `after_sequence` from the last
   delivered event and a bounded `wait_ms` while the agent is active.
6. Call `agent_status` until the agent is idle. Drain remaining events before
   calling `agent_stop`.
7. Call `codespaces_stop` only when the user wants to stop the Codespace.

Read [orchestration](references/orchestration.md) before supervising multiple
agents. Read [recovery](references/recovery.md) when a request, supervisor, or
agent fails.

## Permission choice

`approve_all_permissions` is an `agent_start` option. It defaults to false.
Set it to true only when the user explicitly asks for an agent to approve all of
its own permission prompts. Tell the user that the agent can then act without
individual approval. Read [security](references/security.md) before using it.

## Troubleshoot

Read [troubleshooting](references/troubleshooting.md) for failed startup,
unresponsive requests, and stale agent state. Return supervisor errors without
rewriting them into guesses.
