#!/usr/bin/env python3
"""Run task evals through Copilot CLI by default.

This Copilot-focused companion to Anthropic's skill-creator runs eval prompts
with a skill and baseline runs, then writes the workspace layout expected by
the bundled viewer and aggregation scripts. Legacy non-Copilot harnesses remain
available only when explicitly selected. Original project copyright and
Apache-2.0 license are retained in ../LICENSE.txt.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.harnesses import (
    build_task_prompt,
    choose_harness,
    claude_command,
    codex_command,
    copilot_command,
    extract_final_text,
    pi_command,
    resolve_eval_root,
    run_command,
    staged_copilot_skill,
)
from scripts.utils import parse_skill_md, safe_slug


def load_evals(path: Path) -> tuple[str | None, list[dict]]:
    data = json.loads(path.read_text())
    if isinstance(data, list):
        return None, data
    return data.get("skill_name"), data.get("evals", [])


def copy_input_files(files: list[str], skill_path: Path, run_dir: Path) -> list[str]:
    copied: list[str] = []
    inputs_dir = run_dir / "inputs"
    for file_ref in files or []:
        src = Path(file_ref)
        if not src.is_absolute():
            src = (skill_path / src).resolve()
        if not src.exists():
            copied.append(f"MISSING: {src}")
            continue
        inputs_dir.mkdir(parents=True, exist_ok=True)
        dest = inputs_dir / src.name
        if src.is_dir():
            if dest.exists():
                shutil.rmtree(dest)
            shutil.copytree(src, dest)
        else:
            shutil.copy2(src, dest)
        copied.append(str(dest.resolve()))
    return copied


def run_one(
    harness: str,
    eval_item: dict,
    config: str,
    skill_path: Path,
    project_root: Path,
    run_dir: Path,
    model: str | None,
    timeout: int,
) -> dict:
    run_dir.mkdir(parents=True, exist_ok=True)
    outputs_dir = run_dir / "outputs"
    outputs_dir.mkdir(parents=True, exist_ok=True)
    input_files = copy_input_files(eval_item.get("files", []), skill_path, run_dir)

    use_skill = config == "with_skill"
    prompt = build_task_prompt(
        eval_item["prompt"],
        outputs_dir=outputs_dir,
        input_files=input_files,
        skill_path=skill_path if use_skill else None,
        harness=harness,
    )

    start_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    stage_context = None
    try:
        if harness == "copilot":
            if use_skill:
                stage_context = staged_copilot_skill(skill_path, project_root)
                stage_context.__enter__()
            args = copilot_command(prompt, model=model)
            code, stdout, stderr, elapsed = run_command(args, cwd=project_root, timeout=timeout)
        elif harness == "pi":
            args = pi_command(prompt, skill_path=skill_path if use_skill else None, model=model, no_skills=not use_skill)
            code, stdout, stderr, elapsed = run_command(args, cwd=project_root, timeout=timeout)
        elif harness == "claude":
            if use_skill:
                prompt = build_task_prompt(
                    eval_item["prompt"], outputs_dir=outputs_dir, input_files=input_files,
                    skill_path=skill_path, harness=harness,
                )
            args, env = claude_command(prompt, model=model)
            code, stdout, stderr, elapsed = run_command(args, cwd=project_root, timeout=timeout, env=env)
        elif harness == "codex":
            args = codex_command(prompt, model=model, cwd=project_root)
            code, stdout, stderr, elapsed = run_command(args, cwd=project_root, timeout=timeout)
        else:
            raise RuntimeError(f"Unsupported harness: {harness}")
    finally:
        if stage_context is not None:
            stage_context.__exit__(None, None, None)

    final_text = extract_final_text(harness, stdout)
    if not any(outputs_dir.iterdir()) and final_text:
        (outputs_dir / "final_answer.md").write_text(final_text + "\n")

    end_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    transcript = (
        f"# Harness Eval Transcript\n\n"
        f"## Harness\n\n{harness}\n\n"
        f"## Configuration\n\n{config}\n\n"
        f"## Eval Prompt\n\n{eval_item['prompt']}\n\n"
        f"## Command Exit Code\n\n{code}\n\n"
        f"## STDOUT\n\n```\n{stdout}\n```\n\n"
        f"## STDERR\n\n```\n{stderr}\n```\n"
    )
    (run_dir / "transcript.md").write_text(transcript)
    (outputs_dir / "transcript.md").write_text(transcript)

    total_tokens = 0
    # Best-effort token/usage extraction from JSONL events.
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        blob = json.dumps(event)
        if "totalTokens" in blob:
            def walk(obj):
                nonlocal total_tokens
                if isinstance(obj, dict):
                    for k, v in obj.items():
                        if k in {"totalTokens", "total_tokens"} and isinstance(v, int):
                            total_tokens = max(total_tokens, v)
                        else:
                            walk(v)
                elif isinstance(obj, list):
                    for x in obj:
                        walk(x)
            walk(event)

    timing = {
        "executor_start": start_iso,
        "executor_end": end_iso,
        "executor_duration_seconds": round(elapsed, 3),
        "total_duration_seconds": round(elapsed, 3),
        "duration_ms": int(elapsed * 1000),
        "total_tokens": total_tokens,
        "harness": harness,
        "exit_code": code,
    }
    (run_dir / "timing.json").write_text(json.dumps(timing, indent=2) + "\n")

    output_chars = sum(len(p.read_text(errors="replace")) for p in outputs_dir.rglob("*") if p.is_file() and p.stat().st_size < 2_000_000)
    metrics = {
        "tool_calls": {},
        "total_tool_calls": 0,
        "total_steps": 0,
        "files_created": [str(p.relative_to(outputs_dir)) for p in outputs_dir.rglob("*") if p.is_file()],
        "errors_encountered": 0 if code == 0 else 1,
        "output_chars": output_chars,
        "transcript_chars": len(transcript),
        "harness": harness,
    }
    (outputs_dir / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n")

    return {"harness": harness, "config": config, "run_dir": str(run_dir), "exit_code": code, "elapsed": elapsed}


def main() -> None:
    parser = argparse.ArgumentParser(description="Run Copilot task evals with/baseline")
    parser.add_argument("--evals", required=True, help="Path to evals/evals.json")
    parser.add_argument("--skill-path", required=True, help="Path to skill directory under test")
    parser.add_argument("--workspace", default=None, help="Workspace root (default: <skill-name>-workspace)")
    parser.add_argument("--iteration", type=int, default=1, help="Iteration number")
    parser.add_argument("--harness", default="copilot", help="Harness: copilot (default), or legacy: auto, all, pi, claude, codex")
    parser.add_argument("--model", default=None, help="Model to pass to harness")
    parser.add_argument("--timeout", type=int, default=900, help="Timeout per run in seconds")
    parser.add_argument("--num-workers", type=int, default=2, help="Parallel runs")
    parser.add_argument("--runs-per-config", type=int, default=1, help="Repetitions per eval/config/harness")
    parser.add_argument("--no-baseline", action="store_true", help="Only run with_skill")
    parser.add_argument("--project-root", default=None, help="Project root to run harness CLI from. Default: an isolated throwaway git sandbox (safe for --allow-all agent runs). Pass an explicit path only if you intend the eval to act on that directory.")
    args = parser.parse_args()

    skill_path = Path(args.skill_path).resolve()
    name, _, _ = parse_skill_md(skill_path)
    eval_skill_name, evals = load_evals(Path(args.evals))
    if not evals:
        print("No evals found", file=sys.stderr)
        sys.exit(1)

    harnesses = choose_harness(args.harness, trigger_only=False)
    workspace = Path(args.workspace or f"{name}-workspace").resolve()
    iteration_dir = workspace / f"iteration-{args.iteration}"

    with resolve_eval_root(args.project_root) as project_root:
        futures = []
        with ThreadPoolExecutor(max_workers=args.num_workers) as executor:
            for eval_idx, item in enumerate(evals):
                eval_id = item.get("id", eval_idx)
                eval_name = safe_slug(item.get("name") or item.get("eval_name") or f"eval-{eval_id}")
                eval_dir = iteration_dir / f"eval-{eval_id}-{eval_name}"
                eval_dir.mkdir(parents=True, exist_ok=True)
                assertions = item.get("assertions", item.get("expectations", []))
                metadata = {
                    "eval_id": eval_id,
                    "eval_name": eval_name,
                    "prompt": item["prompt"],
                    "assertions": assertions,
                    "harnesses": harnesses,
                }
                (eval_dir / "eval_metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")

                configs = ["with_skill"] + ([] if args.no_baseline else ["without_skill"])
                for harness in harnesses:
                    for config in configs:
                        for run_n in range(1, args.runs_per_config + 1):
                            run_dir = eval_dir / f"{harness}_{config}" / f"run-{run_n}"
                            futures.append(executor.submit(
                                run_one, harness, item, config, skill_path, project_root, run_dir, args.model, args.timeout
                            ))

            for future in as_completed(futures):
                result = future.result()
                print(f"{result['harness']} {result['config']} -> {result['run_dir']} ({result['elapsed']:.1f}s, exit={result['exit_code']})")

    print(f"\nWorkspace: {iteration_dir}")
    print("Next steps:")
    print(f"  1. Grade runs and write grading.json files under each run directory.")
    print(f"  2. Aggregate: python3 -m scripts.aggregate_benchmark {iteration_dir} --skill-name {name}")
    print(f"  3. Review: python3 eval-viewer/generate_review.py {iteration_dir} --skill-name {name} --static {iteration_dir / 'review.html'}")


if __name__ == "__main__":
    main()
