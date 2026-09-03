# Troubleshooting

If `codespaces_list` returns a supervisor startup error, install or update the
`ado-codespaces` GitHub CLI extension and authenticate before retrying.

If a tool reports that the supervisor exited, inspect the error, run the
prerequisite command, and call a read-only tool such as `codespaces_list`.

If a Codespace cannot start, call `codespaces_status` and report the returned
state. Do not invent lifecycle commands outside the extension tools.

If an agent cannot start or respond, call `agent_status`. If it remains active
but cannot proceed, stop it only when the user wants the task cancelled.
