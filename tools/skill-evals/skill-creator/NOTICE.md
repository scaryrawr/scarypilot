# Notices

This `skill-creator` skill is adapted from Anthropic's `skill-creator` skill in the `anthropics/skills` repository:

- Source: https://github.com/anthropics/skills/tree/main/skills/skill-creator
- License: Apache License, Version 2.0
- Upstream copyright notice: Copyright 2026 Anthropic, PBC.

The Apache-2.0 license text is preserved in `LICENSE.txt`.

## Modification notice

This copy has been modified for GitHub Copilot CLI compatibility. Notable changes include:

- Rewrote `SKILL.md` to describe Copilot-focused skill workflows.
- Added `scripts/harnesses.py` for harness detection, command construction, Copilot project-skill staging, and trigger detection.
- Reworked `scripts/run_eval.py` to run trigger evals against Copilot by default, with legacy non-Copilot harnesses available only when explicitly selected.
- Reworked `scripts/improve_description.py` and `scripts/run_loop.py` to use Copilot by default instead of requiring `claude -p`.
- Added `scripts/run_harness_eval.py` to run Copilot task-output evals and produce the workspace layout expected by the viewer/benchmark tools.
- Modified `scripts/utils.py` and `scripts/quick_validate.py` to remove the PyYAML dependency for basic skill validation.

Files copied from the upstream project but not substantively modified remain under the upstream Apache-2.0 license.

## ScaryPilot repository-only helper adaptation

This subset pins the locally installed Copilot adaptation by source SHA-256 in
`provenance.json`. Its adapted source has no known immutable Git revision.
`scripts/utils.py` and `LICENSE.txt` retain the captured bytes.

The Copilot paths in `scripts/harnesses.py`, `scripts/run_eval.py`, and
`scripts/run_harness_eval.py` were reduced and hardened for sequential,
approved, file-only experiments. Legacy harnesses, optimization loops,
packaging, unused review pages, and aggregate helpers are not included.
Per-run metadata, output, timing, and grading conventions retain the original
lineage. `scripts/grading.py` and the contract tests are repository additions.

This directory is development tooling, not a published skill or plugin.
