# Autoresearch session design

## Session files

Create new sessions under `.auto/`:

| File | Purpose |
| --- | --- |
| `.auto/prompt.md` | Durable experiment playbook |
| `.auto/measure.sh` | Benchmark that emits structured metrics |
| `.auto/log.jsonl` | Append-only result log written by the tools |
| `.auto/ideas.md` | Optional backlog of deferred hypotheses |
| `.auto/checks.sh` | Optional correctness gate |
| `.auto/config.json` | Optional working directory and iteration limits |
| `.auto/hooks/{before,after}.sh` | Optional iteration hooks |

Legacy flat `autoresearch.*` files remain readable, but never create new ones.

## Prompt template

```markdown
# Autoresearch: <goal>

## Objective
<Specific workload and optimization target.>

## Metrics
- **Primary**: <name> (<unit>, lower/higher is better)
- **Secondary**: <independent tradeoff monitors>

## How to Run
`./.auto/measure.sh` prints `METRIC name=number` lines.

## Files in Scope
<Every file that experiments may modify and what it controls.>

## Off Limits
<Files, APIs, behavior, and dependencies that must not change.>

## Constraints
<Tests, types, output equivalence, dependency policy, and resource limits.>

## What's Been Tried
<Wins, dead ends, measurements, and architectural conclusions.>
```

Update "What's Been Tried" when a result changes the search strategy. Record
durable conclusions, not a transcript of every command.

## Benchmark design

Use a Bash script with `set -euo pipefail`. Keep it fast because its cost is
multiplied across many runs.

1. Run cheap pre-checks that reject invalid experiments quickly.
2. Run the representative workload.
3. Print the primary metric and useful independent diagnostics:

   ```text
   METRIC total_ms=31.7
   METRIC peak_mb=412
   ```

4. For fast noisy workloads, collect several samples and report the median.
5. Keep benchmark inputs and environment stable across experiments.
6. Add phase timings, error categories, cache rates, or other diagnostics when
   they help choose the next hypothesis.

The benchmark can evolve as understanding improves, but never change it in a
way that makes old and new primary metrics incomparable without starting a new
segment through `init_experiment`.

## Correctness checks

Create `.auto/checks.sh` only when the constraints need a separate correctness
gate. It runs automatically after every passing benchmark and its time is not
included in the primary metric.

- Keep successful output quiet.
- Let failures print only actionable diagnostics.
- Log a passing benchmark with failing checks as `checks_failed`.
- Never force a `keep` around failed checks.

## Optional configuration

`.auto/config.json` supports:

```json
{
  "workingDir": "/path/to/project",
  "maxIterations": 50
}
```

`workingDir` may be absolute or relative to the Copilot session directory. The
config remains in the session directory; all other autoresearch artifacts,
commands, and Git operations use the resolved working directory.

## Actionable side information

Use `log_experiment.asi` for information that must survive context loss and
reverts. Do not duplicate the description or raw command output.

Useful fields include:

- `hypothesis`: why the change could improve the metric;
- `rollback_reason`: why a discarded or crashed attempt failed;
- `next_action_hint`: the best adjacent experiment;
- `bottleneck`: the measured limiting resource;
- `learned`: a durable architectural conclusion.

Discarded code is intentionally erased. If its lesson is not in `asi`,
`.auto/prompt.md`, or `.auto/ideas.md`, the next agent will repeat it.
