# Recovery

When a tool returns an error, preserve the supervisor message. Do not retry a
mutating request until `codespaces_status` or `agent_status` shows the current
state.

If the supervisor process exits, restart the Copilot session before retrying.
Recheck Codespace and agent state after reconnecting because the new process
does not restore a previous request map.

If an agent becomes unresponsive, call `agent_status`. Call `agent_stop` only
when the task must end. Starting a replacement agent without checking the first
agent can produce duplicate work.
