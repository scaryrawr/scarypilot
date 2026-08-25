---
name: autoresearch-hooks
description: Create before/after hooks for an autoresearch session. Use for research fetching, notifications, learnings, tagging, anti-thrash logic, or iteration side effects.
---

# Author autoresearch hooks

Hooks are optional executable scripts:

```text
.auto/hooks/before.sh
.auto/hooks/after.sh
```

They receive one JSON object on stdin and have a 30-second timeout. Stdout up
to 8 KB becomes guidance for the next iteration. Empty stdout is silent.
Non-zero exit, stderr, and timeout details are surfaced to the agent.

`before.sh` receives `event`, `cwd`, `next_run`, `last_run`, and `session`.
`after.sh` receives `event`, `cwd`, `run_entry`, and `session`. The session
contains `metric_name`, `metric_unit`, `direction`, `baseline_metric`,
`best_metric`, `run_count`, and `goal`.

Keep each hook focused. Parse stdin with `jq`, use guard clauses, avoid hidden
environment-variable contracts, and print only actionable guidance. Mark the
script executable and test it with a representative JSON payload before use.
Everything under `.auto/` survives experiment reverts.
