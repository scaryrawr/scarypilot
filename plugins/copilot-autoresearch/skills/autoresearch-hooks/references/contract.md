# Hook contract

Both hooks receive one JSON object on stdin. Files without the executable bit
are ignored.

## Before hook

`.auto/hooks/before.sh` runs before an iteration:

```json
{
  "event": "before",
  "cwd": "/path/to/workdir",
  "next_run": 6,
  "last_run": {
    "run": 5,
    "status": "discard",
    "metric": 42.1,
    "description": "Copy cost dominates",
    "asi": {
      "hypothesis": "Built-in sort avoids interpreter overhead",
      "next_action_hint": "Avoid the input copy"
    }
  },
  "session": {
    "metric_name": "total_ms",
    "metric_unit": "ms",
    "direction": "lower",
    "baseline_metric": 40.7,
    "best_metric": 33.5,
    "run_count": 5,
    "goal": "optimize sort speed"
  }
}
```

`last_run` is `null` before the first run.

## After hook

`.auto/hooks/after.sh` runs after `log_experiment`:

```json
{
  "event": "after",
  "cwd": "/path/to/workdir",
  "run_entry": {
    "run": 6,
    "status": "discard",
    "metric": 38.9,
    "description": "Hybrid slower on random input",
    "asi": {
      "hypothesis": "Exploit partially sorted input",
      "learned": "Dispatch overhead dominates on random arrays"
    }
  },
  "session": {
    "metric_name": "total_ms",
    "metric_unit": "ms",
    "direction": "lower",
    "baseline_metric": 40.7,
    "best_metric": 33.5,
    "run_count": 6,
    "goal": "optimize sort speed"
  }
}
```

## Session fields

| Field | Meaning |
| --- | --- |
| `direction` | `lower` or `higher` |
| `baseline_metric` | First run in the current segment, or `null` |
| `best_metric` | Best kept metric, or `null` |
| `run_count` | Total logged runs |
| `goal` | Name passed to `init_experiment` |

## Output and failures

- Stdout up to 8 KB becomes guidance for the agent.
- Empty stdout is silent.
- Non-zero exit and stderr are surfaced as an error steer.
- The extension terminates the hook after 30 seconds.
- Hook execution is appended to `.auto/log.jsonl` for observability.

## Smoke test

```bash
jq -n '
  {
    event: "before",
    cwd: ".",
    next_run: 1,
    last_run: null,
    session: {
      metric_name: "total_ms",
      metric_unit: "ms",
      direction: "lower",
      baseline_metric: null,
      best_metric: null,
      run_count: 0,
      goal: "test"
    }
  }
' | ./.auto/hooks/before.sh
```

For `after.sh`, replace `last_run` with a representative `run_entry`.
