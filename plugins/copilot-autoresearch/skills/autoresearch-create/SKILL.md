---
name: autoresearch-create
description: Set up and run an autonomous experiment loop for any optimization target. Use when asked to run autoresearch, optimize something repeatedly, start benchmark-driven experiments, or resume an existing .auto session.
---

# Create an autoresearch session

Build a durable experiment loop that can survive context resets and restarts.

1. Infer or gather the goal, benchmark command, primary metric and direction,
   files in scope, and correctness constraints.
2. Create a branch named `autoresearch/<goal>-<date>`.
3. Read and understand the relevant implementation before changing it.
4. Read [references/session-design.md](references/session-design.md).
5. Create `.auto/prompt.md` and `.auto/measure.sh`. Add `.auto/checks.sh` only
   when correctness constraints need a separate gate.
6. Make scripts executable and commit the initial session files before the
   baseline so discard can safely restore the tree.
7. Call `init_experiment`, run and log the baseline, then iterate immediately.

## `.auto/prompt.md`

Write a self-contained playbook that a fresh agent can use without conversation
history. Include:

- objective;
- primary and secondary metrics;
- `./.auto/measure.sh` usage;
- files in scope and off limits;
- correctness and dependency constraints;
- a “What’s Been Tried” section that is maintained during the loop.

## `.auto/measure.sh`

Use `set -euo pipefail`. Run fast pre-checks, then the benchmark, and print one
or more `METRIC name=value` lines. The primary name must exactly match
`init_experiment.metric_name`. For fast noisy workloads, take multiple samples
and report the median.

## Loop rules

- Always call `log_experiment` after `run_experiment`.
- Keep primary-metric improvements; discard regressions or equal results.
- Include useful `asi` on every run. On discard or crash, preserve the failed
  hypothesis, rollback reason, and next action because the code will disappear.
- Append deferred ideas to `.auto/ideas.md`.
- Update `.auto/prompt.md` as durable knowledge accumulates.
- Treat confidence as advisory: re-run improvements inside the noise floor.
- Prefer simpler changes and structural hypotheses over repeated parameter
  tweaks.
- Continue until interrupted, a configured limit is reached, or the repeated
  failure guard stops the loop.
- If the user sends feedback during a run, finish and log that run before
  incorporating the feedback.
