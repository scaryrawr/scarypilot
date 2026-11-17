#!/usr/bin/env python3
"""Run Copilot trigger evaluation for a skill description.

Modified from Anthropic's skill-creator distribution to support GitHub
Copilot CLI as the primary trigger-eval harness. Legacy non-Copilot harnesses
remain available when explicitly selected. Original project copyright and
Apache-2.0 license are retained in ../LICENSE.txt.
"""

from __future__ import annotations

import argparse
import json
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.harnesses import (
    HARNESS_INFO,
    choose_harness,
    claude_command,
    copilot_command,
    pi_command,
    resolve_eval_root,
    run_command,
    staged_claude_command,
    staged_copilot_skill,
    temporary_skill_dir,
    triggered_from_output,
)
from scripts.utils import parse_skill_md


def run_single_query(
    query: str,
    skill_path: Path,
    skill_name: str,
    skill_description: str,
    timeout: int,
    project_root: Path,
    harness: str,
    model: str | None = None,
) -> bool:
    """Run one trigger query and return whether the skill triggered."""
    if harness == "copilot":
        unique_name = f"{skill_name}-skill-{uuid.uuid4().hex[:8]}"
        with staged_copilot_skill(skill_path, project_root, unique_name=unique_name, description=skill_description) as (staged_name, _):
            code, stdout, stderr, _ = run_command(
                copilot_command(query, model=model),
                cwd=project_root,
                timeout=timeout,
            )
            if code not in (0, 124) and stderr:
                print(f"Warning: copilot exited {code}: {stderr[:300]}", file=sys.stderr)
            return triggered_from_output("copilot", stdout, staged_name) or triggered_from_output("copilot", stdout, skill_name)

    if harness == "pi":
        unique_name = f"{skill_name}-skill-{uuid.uuid4().hex[:8]}"
        with temporary_skill_dir(unique_name, skill_description) as staged_skill:
            code, stdout, stderr, _ = run_command(
                pi_command(query, skill_path=staged_skill, model=model),
                cwd=project_root,
                timeout=timeout,
            )
            if code not in (0, 124) and stderr:
                print(f"Warning: pi exited {code}: {stderr[:300]}", file=sys.stderr)
            return triggered_from_output("pi", stdout, unique_name, staged_skill)

    if harness == "claude":
        with staged_claude_command(skill_name, skill_description, project_root) as unique_name:
            args, env = claude_command(query, model=model)
            code, stdout, stderr, _ = run_command(args, cwd=project_root, timeout=timeout, env=env)
            if code not in (0, 124) and stderr:
                print(f"Warning: claude exited {code}: {stderr[:300]}", file=sys.stderr)
            return triggered_from_output("claude", stdout, unique_name)

    raise RuntimeError(f"Harness '{harness}' does not support trigger evals: {HARNESS_INFO[harness].notes}")


def run_eval(
    eval_set: list[dict],
    skill_name: str,
    skill_path: Path,
    description: str,
    num_workers: int,
    timeout: int,
    project_root: Path,
    runs_per_query: int = 1,
    trigger_threshold: float = 0.5,
    model: str | None = None,
    harness: str = "copilot",
) -> dict:
    """Run the eval set and return results.

    If harness="all", results are grouped per harness and the top-level summary
    aggregates over harness/query pairs.
    """
    harnesses = choose_harness(harness, trigger_only=True)
    harness_outputs = []

    for selected_harness in harnesses:
        results = []
        with ThreadPoolExecutor(max_workers=num_workers) as executor:
            future_to_info = {}
            for item in eval_set:
                for run_idx in range(runs_per_query):
                    future = executor.submit(
                        run_single_query,
                        item["query"],
                        skill_path,
                        skill_name,
                        description,
                        timeout,
                        project_root,
                        selected_harness,
                        model,
                    )
                    future_to_info[future] = (item, run_idx)

            query_triggers: dict[str, list[bool]] = {}
            query_items: dict[str, dict] = {}
            for future in as_completed(future_to_info):
                item, _ = future_to_info[future]
                query = item["query"]
                query_items[query] = item
                query_triggers.setdefault(query, [])
                try:
                    query_triggers[query].append(future.result())
                except Exception as e:
                    print(f"Warning: query failed for harness={selected_harness}: {e}", file=sys.stderr)
                    query_triggers[query].append(False)

        for query, triggers in query_triggers.items():
            item = query_items[query]
            trigger_rate = sum(triggers) / len(triggers)
            should_trigger = item["should_trigger"]
            did_pass = trigger_rate >= trigger_threshold if should_trigger else trigger_rate < trigger_threshold
            results.append({
                "query": query,
                "should_trigger": should_trigger,
                "trigger_rate": trigger_rate,
                "triggers": sum(triggers),
                "runs": len(triggers),
                "pass": did_pass,
                "harness": selected_harness,
            })

        passed = sum(1 for r in results if r["pass"])
        total = len(results)
        harness_outputs.append({
            "harness": selected_harness,
            "results": results,
            "summary": {"total": total, "passed": passed, "failed": total - passed},
        })

    all_results = [r for h in harness_outputs for r in h["results"]]
    passed = sum(1 for r in all_results if r["pass"])
    total = len(all_results)
    return {
        "skill_name": skill_name,
        "description": description,
        "harness": harnesses[0] if len(harnesses) == 1 else "all",
        "harness_results": harness_outputs,
        "results": all_results,
        "summary": {"total": total, "passed": passed, "failed": total - passed},
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Run trigger evaluation for a skill description")
    parser.add_argument("--eval-set", required=True, help="Path to eval set JSON file")
    parser.add_argument("--skill-path", required=True, help="Path to skill directory")
    parser.add_argument("--description", default=None, help="Override description to test")
    parser.add_argument("--num-workers", type=int, default=5, help="Number of parallel workers")
    parser.add_argument("--timeout", type=int, default=45, help="Timeout per query in seconds")
    parser.add_argument("--runs-per-query", type=int, default=3, help="Number of runs per query")
    parser.add_argument("--trigger-threshold", type=float, default=0.5, help="Trigger rate threshold")
    parser.add_argument("--model", default=None, help="Model to use for the selected harness")
    parser.add_argument("--harness", default="copilot", help="Harness: copilot (default), or legacy: auto, all, pi, claude")
    parser.add_argument("--project-root", default=None,
                        help="Project root to run harness CLI from. If omitted, an isolated "
                             "throwaway git repo is created so the --allow-all agent cannot "
                             "mutate a real repository. Only pass this to intentionally target "
                             "a specific (ideally disposable) directory.")
    parser.add_argument("--verbose", action="store_true", help="Print progress to stderr")
    args = parser.parse_args()

    eval_set = json.loads(Path(args.eval_set).read_text())
    skill_path = Path(args.skill_path).resolve()

    if not (skill_path / "SKILL.md").exists():
        print(f"Error: No SKILL.md found at {skill_path}", file=sys.stderr)
        sys.exit(1)

    name, original_description, _ = parse_skill_md(skill_path)
    description = args.description or original_description

    with resolve_eval_root(args.project_root) as project_root:
        if args.verbose:
            root_note = project_root if args.project_root else f"{project_root} (isolated sandbox)"
            print(f"Evaluating ({args.harness}) from {root_note}: {description}", file=sys.stderr)

        output = run_eval(
            eval_set=eval_set,
            skill_name=name,
            skill_path=skill_path,
            description=description,
            num_workers=args.num_workers,
            timeout=args.timeout,
            project_root=project_root,
            runs_per_query=args.runs_per_query,
            trigger_threshold=args.trigger_threshold,
            model=args.model,
            harness=args.harness,
        )

    if args.verbose:
        for group in output["harness_results"]:
            summary = group["summary"]
            print(f"{group['harness']}: {summary['passed']}/{summary['total']} passed", file=sys.stderr)
            for r in group["results"]:
                status = "PASS" if r["pass"] else "FAIL"
                rate_str = f"{r['triggers']}/{r['runs']}"
                print(f"  [{status}] rate={rate_str} expected={r['should_trigger']}: {r['query'][:70]}", file=sys.stderr)

    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
