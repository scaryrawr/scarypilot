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

## ScaryPilot modification notice

Imported from `scaryrawr/agentic`, revision
`40bf12f0c206d31423733e3fcc54fd8220b69078`, path `skills/skill-creator`.
ScaryPilot adds plugin packaging and provenance; modifies `SKILL.md` and
`references/workflows.md` for uv, installed-path resolution, and explicit
evaluation approval and external isolation; and updates `evals/evals.json`
with runnable fixtures and adds trigger cases.

Local helper corrections:

- `eval-viewer/generate_review.py`: escape embedded JSON, display nested output
  paths, find eval-directory metadata, and choose a free port without
  terminating existing listeners.
- `eval-viewer/viewer.html`: preserve completed feedback on dialog dismissal
  and cancel pending autosaves on submission, handle failed HTTP writes, and
  escape benchmark labels and grading evidence attributes. Load current
  feedback independently of embedded previous-iteration context.
- `scripts/aggregate_benchmark.py`: recover token counts independently of duration.
- `scripts/run_loop.py`: reject holdout splits without training queries.
- `scripts/generate_report.py`: accept null test results with holdout disabled.
- `scripts/package_skill.py`: exclude the destination archive.
- `scripts/quick_validate.py` and `scripts/utils.py`: reject empty required
  values, non-string required plain scalars, incomplete closing delimiters,
  and invalid or unsupported frontmatter syntax.
- `scripts/harnesses.py`, `scripts/run_eval.py`, and
  `scripts/run_harness_eval.py`: isolate invocation working copies, count only
  the staged candidate as trigger evidence, and abort trigger scoring on
  execution failures. Refuse existing task iteration/run directories so stale
  outputs and grades cannot be reused. Terminate managed subprocess trees on
  timeout or interruption, re-raise interruption after cleanup, cancel pending
  trigger queries after failure, preserve same-name fixtures, and recognize
  both usage token key spellings.
- `references/workflows.md`: include shortening retries in optimization budgets.

Model-free regression tests are added under the plugin's `tests/` directory.
All other imported helpers and assets remain unchanged from that revision.
