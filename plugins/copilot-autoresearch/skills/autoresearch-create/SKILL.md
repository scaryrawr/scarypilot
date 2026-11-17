---
name: autoresearch-create
description: Set up and run an autonomous experiment loop for any optimization target. Use when asked to run autoresearch, optimize something repeatedly, start benchmark-driven experiments, or resume an existing .auto session.
---

# Create an autoresearch session

Build a durable experiment loop that can survive context resets and restarts.

## Choose an execution interface

Discover the host's advertised capabilities by action description. Look for
experiment initialization, benchmark execution, result logging, and status.
Read the matching schemas before calling them. Do not invent tool names or
copy a protocol from another host.

If these actions are unavailable, use the bundled CLI. Resolve
`../../scripts/autoresearch.mjs` relative to this skill directory and invoke
it with Node. Run `node <resolved-script> --help` and
`node <resolved-script> schema` before constructing arguments.
Pass an explicit absolute `--workspace` on every experiment command.
Read the [CLI guide](../../docs/cli.md) for setup, Git policy, and recovery.
Do not install dependencies or load the Copilot SDK to run the CLI.

The CLI executes one requested action and exits. It does not wake agents,
schedule iterations, provide native UI, or supply session hooks. Continue only
within the current user's execution authority and iteration budget. Native
Copilot auto-resume and dashboard commands are not portable CLI capabilities.
Model confidence never grants permission to run a command or change Git state.

Use one interface at a time for an experiment directory. Native session mode
does not activate the CLI, and CLI initialization does not activate a host session.

## Set up the experiment

1. Infer or gather the goal, benchmark command, primary metric and direction,
   files in scope, and correctness constraints.
2. Create a branch named `autoresearch/<goal>-<date>`.
3. Read and understand the relevant implementation before changing it.
4. Read [references/session-design.md](references/session-design.md).
5. Create `.auto/prompt.md` and `.auto/measure.sh`. Add `.auto/checks.sh` only
   when correctness constraints need a separate gate.
6. Make scripts executable and commit the initial session files before the
   baseline so discard can safely restore the tree.
7. Initialize through the selected interface, run and log the baseline, then
   iterate within the approved budget.

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
the initialization schema's primary metric name. For fast noisy workloads, take multiple samples
and report the median.

## Loop rules

- Always log the result after running a benchmark.
- Keep primary-metric improvements; discard regressions or equal results.
- Include useful `asi` on every run. On discard or crash, preserve the failed
  hypothesis, rollback reason, and next action because the code will disappear.
  When retrying a discarded idea after its assumptions changed, set
  `asi.revisits_run` to the earlier run number and explain what changed —
  don't revive a discarded idea without a changed assumption.
- Append deferred ideas to `.auto/ideas.md`.
- Update `.auto/prompt.md` as durable knowledge accumulates.
- Treat confidence as advisory: re-run improvements inside the noise floor.
- Prefer simpler changes and structural hypotheses over repeated parameter
  tweaks.
- Continue until interrupted, a configured limit is reached, or the repeated
  failure guard stops the loop.
- If the user sends feedback during a run, finish and log that run before
  incorporating the feedback.
