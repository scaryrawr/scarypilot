---
name: skill-creator
description: Use this skill to create, revise, package, evaluate, or optimize GitHub Copilot skills and reusable SKILL.md-based agent instructions. Use it whenever the user wants a new Copilot skill, edits to an existing skill, eval/test prompts, skill benchmarking, skill packaging, trigger-description optimization, or reusable agent instructions.
license: Apache-2.0
---

# Skill Creator

Use this file as the operating checklist after the skill has loaded. Attribution and modification notes are in `LICENSE.txt` and `NOTICE.md`.

ScaryPilot adaptation: use uv, resolve installed helper paths, and require
explicit approval and external isolation for model-backed evaluations.

## Running bundled helpers

Resolve `<skill-creator-dir>` to the directory containing this `SKILL.md`.
Keep the target repository as the working directory; do not copy helpers into it.
Check `uv --version` before relying on uv. These standalone helpers need no
third-party Python dependencies; invoke them with
`uv run --no-project python "<skill-creator-dir>/scripts/<helper>.py" ...`.
For target-project Python work, use its environment through `uv run python ...`
or `uv run pytest`, preserving its dependency conventions. Ask before installing
missing tools or downloading Python/dependencies when approval is required.

## First principles

A skill is a folder with a required `SKILL.md` file and optional bundled resources:

```text
skill-name/
├── SKILL.md
├── scripts/
├── references/
├── assets/
└── evals/
```

Frontmatter must include `name` and `description`. Keep `name` lowercase kebab-case and matching the folder. Keep `description` specific because Copilot uses it for trigger decisions, but do not repeat that description in the body. Quote or block-scalar descriptions that contain YAML-sensitive punctuation such as `: `.

Keep `SKILL.md` lean. Move long explanations to `references/`, deterministic helpers to `scripts/`, templates or examples to `assets/`, and objective eval prompts or fixtures to `evals/`. Body and reference files should assume they are already loaded or intentionally opened: explain how to proceed, not why the skill or reference should be used.

## Workflow

1. Capture intent from the conversation before asking questions: task, trigger conditions, expected output, dependencies, near misses, and whether objective evals are useful.
2. Draft or revise `SKILL.md` with clear imperatives, concise workflow steps, and only the context the agent needs after the skill has loaded.
3. Add or maintain `evals/evals.json` for objective behaviors such as file transforms, fixed workflows, code generation, benchmark comparisons, and trigger-sensitive descriptions.
4. Prefer bundled scripts when repeated deterministic work appears in eval transcripts. Do not grant automatic tool approvals; use the host's normal permission flow and discover available capabilities before invoking host tools.
5. Validate, run the smallest useful eval set, review failures across cases, then revise for general behavior rather than overfitting one prompt.
6. Package only after validation and eval review are satisfactory.

## Evals and optimization

- Use `scripts/run_harness_eval.py` for Copilot task-output evals.
- Use `scripts/run_eval.py` for Copilot trigger-description evals.
- Use `scripts/run_loop.py` only after the trigger eval set is approved; apply a proposed description only after checking that it remains accurate.
- Grade task runs against `eval_metadata.json` assertions. Programmatic checks are best when practical; otherwise use `agents/grader.md`.
- If an eval prompt says a file is provided, include that fixture in `evals/files/` and list it in `evals/evals.json`; otherwise write the prompt so it is runnable without input files.

Read `references/workflows.md` for exact Copilot eval commands, output layout, aggregation, and review-page generation.

## Safety and quality

- Avoid surprising behavior, credential collection, data exfiltration, exploit code, or anything inconsistent with the user's stated intent.
- Do not hard-code machine-specific install paths or copy bundled scripts elsewhere.
- Keep baselines honest: Copilot cannot fully disable personal skills via a public flag, so prefer unique working-copy skill names when strict baselines matter.
- Before any model-backed helper, obtain approval for prompts/fixtures, model/provider, maximum calls, repetitions, baseline arms, timeouts, spending, and broad agent permissions. Approval of a trigger set is not execution approval.
- Eval and optimization helpers launch real agents with broad permissions (`--allow-all` for Copilot). A temporary Git working directory is not a security sandbox. Run only in a disposable, externally isolated environment without private files or unrelated credentials; never use a real checkout as `--project-root`. Use `--num-workers 1`. Report unrun or ungraded behavior as `not_run`.
- When a generated skill instructs agents to publish agent-authored text to external systems, require the visible suffix `- Generated with AI 🤖` once at the end of that text. Put it at the controlled write/payload boundary when one exists; do not attribute user/third-party text or alter non-text mutations.

## Packaging

```bash
uv run --no-project python "<skill-creator-dir>/scripts/quick_validate.py" /path/to/my-skill
uv run --no-project python "<skill-creator-dir>/scripts/package_skill.py" /path/to/my-skill /path/to/dist
```

The packager creates a `.skill` zip archive and excludes root `evals/`, `__pycache__`, `node_modules`, `.DS_Store`, and `*.pyc`.

## Reference files

- `references/workflows.md` — commands for task evals, trigger evals, description optimization, aggregation, and reports.
- `references/schemas.md` — JSON schemas.
- `agents/grader.md` — grade assertions against outputs.
- `agents/comparator.md` — blind A/B comparison instructions.
- `agents/analyzer.md` — benchmark pattern analysis and post-hoc comparison analysis.
- `eval-viewer/generate_review.py` — static/server review page generator.
