# Orchestration

Start with `codespaces_list`. Choose a Codespace by its reported name and check
it with `codespaces_status`. Start only a stopped Codespace. Check status again
before `agent_start`.

Give each agent one bounded task. Start it with its known agent ID, then send
the task with `agent_send`. Call `agent_events` after each send. Pass the last
delivered sequence as `after_sequence` to avoid duplicate output. Use a bounded
`wait_ms` only while the agent remains active.

Use `agent_status` as the authoritative request-response state. Drain remaining
events before stopping an agent. Stop an agent before reusing its Codespace for
unrelated work when its status shows it is still active.
