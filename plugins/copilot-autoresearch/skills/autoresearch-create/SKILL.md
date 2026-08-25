---
name: autoresearch-create
description: Set up and run an autonomous optimization loop. Use when asked to run autoresearch, optimize something repeatedly, or start benchmark-driven experiments.
---

# Create an autoresearch session

Set up a durable experiment loop that can survive context resets and restarts.

1. Infer or gather the goal, benchmark command, primary metric and direction,
   files in scope, and correctness constraints.
2. Create a branch named `autoresearch/<goal>-<date>`.
3. Read and understand the relevant implementation before changing it.
4. Create `.auto/prompt.md` and `.auto/measure.sh`; make the measure script
   executable and commit the initial session files.
5. Call `init_experiment`, run and log a baseline, then iterate immediately.

## `.auto/prompt.md`

Write a self-contained playbook with:

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

Create `.auto/checks.sh` only when correctness constraints require it. It runs
after every successful benchmark and does not count toward benchmark time.

## Loop rules

- Always call `log_experiment` after `run_experiment`.
- Keep primary-metric improvements; discard regressions or equal results.
- Include useful `asi`, especially failure causes and the next hypothesis.
- Append deferred ideas to `.auto/ideas.md`.
- Update `.auto/prompt.md` as durable knowledge accumulates.
- Continue until interrupted, a configured limit is reached, or the repeated
  failure guard stops the loop.
- If the user sends feedback during a run, finish and log that run before
  incorporating the feedback.
