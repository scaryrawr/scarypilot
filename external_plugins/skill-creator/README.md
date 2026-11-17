# Skill Creator

Create and revise reusable Copilot skills, validate and package `.skill` archives,
and prepare task-output and trigger-description evaluations.

## Prerequisites

- GitHub Copilot with skill support.
- [uv](https://docs.astral.sh/uv/) and Python 3.10 or later for bundled helpers.
  Check `uv --version` first; ask before installing missing prerequisites.
- An authenticated Copilot CLI and Git for optional model-backed evaluations.
  Validation, packaging, aggregation, and static review generation use only the
  Python standard library and do not require model calls.

## Installation

```sh
copilot plugin marketplace add scaryrawr/scarypilot
copilot plugin install skill-creator@scarypilot
```

This publication targets Copilot. Legacy harness adapters are retained from the
source for explicitly requested comparisons; they are not a Codex publication
or a claim of current compatibility with other clients.

## Usage

Ask Copilot to create a skill, revise an existing `SKILL.md`, prepare evaluation
cases, or validate and package a skill. The `skill-creator` skill supplies the
workflow and resolves helpers relative to its installed directory, not the
working repository.

For manual, model-free use, replace `<skill-creator-dir>` with the installed
`skills/skill-creator` directory:

```sh
uv run --no-project python "<skill-creator-dir>/scripts/quick_validate.py" /path/to/my-skill
uv run --no-project python "<skill-creator-dir>/scripts/package_skill.py" /path/to/my-skill /path/to/dist
```

Packaging excludes root `evals/`, `__pycache__`, `node_modules`, `.DS_Store`,
and `*.pyc`, and never includes the archive currently being written.
Validation supports top-level scalar frontmatter, including quoted strings
and `|`/`>` blocks; unsupported YAML structures are rejected rather than
silently accepted. Required `name` and `description` values must be strings;
quote scalar values that would otherwise be YAML nulls, booleans, or numbers.

## Evaluation safety

Model-backed helpers launch real agents with broad permissions (Copilot uses
`--allow-all`) and can spend inference credits, run commands, access credentials
or the network, and change files outside their working directory. Their default
temporary Git working directory is **not a security sandbox**. Personal skills,
plugins, and configuration may also affect results.

Each trigger invocation and task configuration uses a fresh Git working
directory. `--project-root` supplies seed context copied without `.git`;
it is not the directory the agent modifies. Dependencies are retained and
symlinks are copied as their target contents rather than shared writable links.
Failed trigger executions abort the batch instead of counting as non-triggers.
Queued queries are cancelled after a worker failure; active queries finish
before the error is returned. Timeout cleanup targets the agent's POSIX process
group or Windows task tree, not processes that escape that managed tree.
Only the uniquely staged candidate counts as trigger evidence.
Task outputs require a new iteration directory: reruns must increment
`--iteration` or choose a new workspace rather than reuse old outputs or grades.

Obtain explicit approval for prompts, fixtures, model/provider, calls,
repetitions, baselines, timeouts, spending, and broad tool access before
execution. Use a disposable, externally isolated environment without private
files or unrelated credentials. Do not pass a real checkout as `--project-root`.
Run one worker at a time. Optimization helpers also launch agents; approval of
an eval set alone does not approve their execution. See
[the workflow reference](skills/skill-creator/references/workflows.md).

Repository contributors must continue using the separately hardened runner in
[`tools/skill-evals`](../../tools/skill-evals/README.md) for this marketplace's
approved pilot. The bundled upstream helpers do not replace that policy or
grant execution approval.

## Attribution and resources

Imported from
[`scaryrawr/agentic` at `40bf12f`](https://github.com/scaryrawr/agentic/tree/40bf12f0c206d31423733e3fcc54fd8220b69078/skills/skill-creator),
which adapts [Anthropic's skill-creator](https://github.com/anthropics/skills/tree/main/skills/skill-creator)
for Copilot. Copyright 2026 Anthropic, PBC.; distributed under Apache-2.0.
The complete [license](skills/skill-creator/LICENSE.txt) and
[modification notice](skills/skill-creator/NOTICE.md) are preserved.

- [Skill workflow](skills/skill-creator/SKILL.md)
- [Data schemas](skills/skill-creator/references/schemas.md)
- [Import provenance](provenance.json)

ScaryPilot adds plugin registration, uv invocation guidance, explicit evaluation
approval and isolation requirements, and runnable evaluation fixtures. Local
helper fixes cover invocation isolation, trigger scoring, validation,
packaging, benchmark accounting, optimizer inputs and budgets, and viewer data
safety and feedback preservation; see the notice and provenance manifest for
modified files.

Model-free regression checks use the repository's unittest flow:

```sh
PYTHONDONTWRITEBYTECODE=1 uv run --no-project python -m unittest discover -s external_plugins/skill-creator/tests -v
```

Run this command from the marketplace root with Node.js available for the
viewer feedback lifecycle check. It uses a fake agent CLI, not inference.
