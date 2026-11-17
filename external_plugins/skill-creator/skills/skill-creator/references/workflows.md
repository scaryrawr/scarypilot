# Skill Creator Workflows

This reference contains command details that are useful during skill evaluation and packaging but too long for `SKILL.md`.

ScaryPilot adaptation: commands use uv and installed helper paths; model-backed
execution requires explicit approval and external isolation.
Resolve `<skill-creator-dir>` to the directory containing this skill's
`SKILL.md` and check `uv --version` first. All helpers use the standard library.

## Copilot compatibility

| Harness | Native skill loading | Eval support |
| --- | --- | --- |
| Copilot CLI | Project skills in `.github/skills/`; personal skills from `~/.agents/skills/` | Trigger evals and task evals via `copilot -p ... --output-format json --allow-all` |

Focus new eval work on Copilot CLI. The scripts still have legacy `--harness pi`, `--harness claude`, `--harness codex`, and `--harness all` options for historical comparisons, but do not use them unless the user explicitly asks for non-Copilot data.

> **Safety: model-backed helpers execute prompts with broad permissions.**
> `run_eval.py`, `run_harness_eval.py`, `run_loop.py`, and
> `improve_description.py` launch real agents; Copilot uses `--allow-all`.
> Temporary working directories are **not security sandboxes** and do not
> prevent access to other files, credentials, or the network. The optimizer
> also uses the caller's working directory for description-improvement calls.
> Obtain explicit approval for prompts/fixtures, model/provider, maximum calls,
> repetitions, baseline arms, timeouts, spending, and broad tool access.
> Run only in a disposable, externally isolated environment without private
> files or unrelated credentials. Never use a real checkout as `--project-root`.
> The scripts do not enforce an approval or total-call budget flag; review
> their actual invocation count before execution. Use `--num-workers 1`.
> Personal skills and configuration can contaminate results. Treat failures,
> unrun cases, and missing grades explicitly, never as passing evidence.

## Task evals

Use task evals when you need actual outputs from Copilot:

```bash
uv run --no-project python "<skill-creator-dir>/scripts/run_harness_eval.py" \
  --evals /path/to/my-skill/evals/evals.json \
  --skill-path /path/to/my-skill \
  --workspace /path/to/my-skill-workspace \
  --iteration 1 \
  --model <approved-model> \
  --runs-per-config 1 --num-workers 1 --timeout 120
```

Useful options:

- `--harness copilot` (default)
- `--model <model-id>`
- `--runs-per-config 3`
- `--no-baseline`
- `--project-root <dir>` — override the disposable working directory. Use only a disposable directory inside the approved externally isolated environment, never a real checkout.

The default includes a with-skill and a baseline run for each case. With one
repetition and one harness, budget `2 * case count` CLI invocations, or
`case count` with `--no-baseline`. Each invocation may make multiple model calls.
Baseline results do not prove that personal skills were disabled.

The script writes:

```text
<workspace>/iteration-N/
└── eval-<id>-<name>/
    ├── eval_metadata.json
    ├── copilot_with_skill/run-1/
    │   ├── transcript.md
    │   ├── timing.json
    │   └── outputs/
    └── copilot_without_skill/run-1/
```

After task runs, grade each run against `eval_metadata.json` assertions, aggregate, then generate a review page:

```bash
uv run --no-project python "<skill-creator-dir>/scripts/aggregate_benchmark.py" /path/to/workspace/iteration-1 --skill-name my-skill
uv run --no-project python "<skill-creator-dir>/eval-viewer/generate_review.py" \
  /path/to/workspace/iteration-1 \
  --skill-name my-skill \
  --benchmark /path/to/workspace/iteration-1/benchmark.json \
  --static /path/to/workspace/iteration-1/review.html
```

If a desktop browser is available, omit `--static` to start a local server.

## Trigger-description evals

Trigger evals test whether the frontmatter description causes Copilot to load the skill for realistic prompts:

```json
[
  {"query": "realistic prompt that should use the skill", "should_trigger": true},
  {"query": "near-miss prompt that should not use it", "should_trigger": false}
]
```

Run:

```bash
uv run --no-project python "<skill-creator-dir>/scripts/run_eval.py" \
  --eval-set /path/to/trigger-evals.json \
  --skill-path /path/to/my-skill \
  --model <approved-model> \
  --runs-per-query 1 --num-workers 1 --timeout 120 \
  --verbose
```

For one harness, budget `query count * runs-per-query` CLI invocations.

## Description optimization

After approval of both the trigger eval set and the optimization execution
budget and isolation policy, run:

```bash
uv run --no-project python "<skill-creator-dir>/scripts/run_loop.py" \
  --eval-set /path/to/trigger-evals.json \
  --skill-path /path/to/my-skill \
  --model <approved-model> \
  --max-iterations 5 --runs-per-query 1 --num-workers 1 --timeout 120 \
  --verbose \
  --results-dir /path/to/my-skill-workspace/description-runs
```

The loop splits train/test, evaluates current and proposed descriptions, writes a live HTML report, and prints JSON containing `best_description`.
Budget up to `max-iterations * query count * runs-per-query` evaluation
invocations plus up to `max-iterations - 1` description-improvement invocations
for one harness. Improvement calls use their own 300-second timeout, not the
trigger `--timeout`. Do not apply a proposed description without checking its
accuracy. Repository contributors must use the separately hardened
`tools/skill-evals` pilot and its approval policy instead of these upstream
model-backed commands.
