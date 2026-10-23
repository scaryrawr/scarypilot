#!/usr/bin/env python3
"""Sequential Copilot description-trigger evals, adapted from skill-creator.

Copyright 2026 Anthropic, PBC. Apache-2.0, see ../LICENSE.txt.
Infrastructure errors never count as successful negative cases.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import uuid
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.harnesses import (
    EvidenceError, cli_fingerprint, common_arguments, copilot_command, create_sandbox, file_inventory,
    fixture_sources, isolated_environment, parse_evidence, preflight, run_command,
    retain_sandbox, stage_skill, validate_workspace, write_json,
)
from scripts.utils import parse_skill_md


def load_queries(path: Path, indexes: list[int] | None) -> list[tuple[int, dict]]:
    data = json.loads(path.read_text())
    if not isinstance(data, list):
        raise ValueError("Trigger evals must be an array")
    for item in data:
        if not isinstance(item, dict) or not isinstance(item.get("query"), str) or not item["query"].strip() or type(item.get("should_trigger")) is not bool:
            raise ValueError("Each query needs text and a boolean should_trigger")
        files = item.get("files", [])
        if not isinstance(files, list) or any(not isinstance(path, str) for path in files):
            raise ValueError("Trigger files must be an array of fixture paths")
    selected = indexes if indexes is not None else list(range(len(data)))
    if len(selected) != len(set(selected)) or any(index < 0 or index >= len(data) for index in selected):
        raise ValueError("Unknown or duplicate --query-index")
    return [(index, data[index]) for index in selected]


def query_fixtures(item: dict, skill: Path) -> list[Path]:
    sources = fixture_sources(item.get("files", []), skill)
    if any(not source.is_file() or source.suffix != ".md" or source.name.startswith(".") for source in sources):
        raise ValueError("Trigger fixtures must be visible Markdown files")
    return sources


def run_single_query(item: dict, skill: Path, run_dir: Path, args: argparse.Namespace) -> dict:
    run_dir.mkdir(parents=True)
    sandbox = create_sandbox()
    try:
        return _run_single_query(item, skill, run_dir, args, sandbox)
    finally:
        if sandbox.exists():
            shutil.rmtree(sandbox)


def _run_single_query(item: dict, skill: Path, run_dir: Path, args: argparse.Namespace, sandbox: Path) -> dict:
    for source in query_fixtures(item, skill):
        shutil.copyfile(source, sandbox / source.name, follow_symlinks=False)
    candidate, _ = stage_skill(skill, sandbox, trigger=True)
    before = file_inventory(sandbox)
    env = isolated_environment(run_dir, args.auth_env)
    manifest = {
        "kind": "description_trigger", "candidate": candidate,
        "requested_model": args.model, "observed_models": [], "usage": None,
        "cli_executable": args.cli, "timeout_seconds": args.timeout,
        "cli_fingerprint": cli_fingerprint(args.cli),
        "approved": args.approved, "max_calls": args.max_calls,
        "status": "error", "triggered": None, "pass": False, "run_dir": str(run_dir),
        "sandbox": str(sandbox), "input_hashes": before,
        "source_hashes": file_inventory(skill),
    }
    write_json(run_dir / "run_manifest.json", manifest)
    (run_dir / "prompt.txt").write_text(item["query"])
    try:
        code, failure = run_command(copilot_command(item["query"], args.model, sandbox, args.cli), sandbox, run_dir, args.timeout, env)
        manifest["exit_code"] = code
        if failure:
            raise EvidenceError(failure)
        if (run_dir / "raw.jsonl").stat().st_size > 20 * 1024 * 1024:
            raise EvidenceError("trace_size_limit")
        evidence = parse_evidence((run_dir / "raw.jsonl").read_text(), candidate, args.model, sandbox, tools=("skill", "view"))
        manifest["observed_models"] = evidence.models
        manifest["usage"] = evidence.usage
        # Trigger arms never need output edits; staged description files are immutable.
        if file_inventory(sandbox) != before:
            raise EvidenceError("write_scope_violation")
        passed = evidence.candidate_loaded == item["should_trigger"]
        manifest.update(triggered=evidence.candidate_loaded, status="passed" if passed else "failed", **{"pass": passed})
    except (EvidenceError, OSError, ValueError) as error:
        manifest.update(status="error", reason=str(error))
    finally:
        try:
            retain_sandbox(sandbox, run_dir)
        except (OSError, ValueError) as error:
            manifest.update(status="error", reason=str(error), **{"pass": False, "triggered": None})
    manifest["snapshot"] = str(run_dir / "sandbox")
    write_json(run_dir / "run_manifest.json", manifest)
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    common_arguments(parser)
    parser.add_argument("--eval-set", required=True)
    parser.add_argument("--query-index", type=int, action="append")
    parser.add_argument("--runs-per-query", type=int, default=1)
    args = parser.parse_args(argv)
    try:
        skill = Path(args.skill_path).absolute()
        name, description, _ = parse_skill_md(skill)
        queries = load_queries(Path(args.eval_set), args.query_index)
        calls = len(queries) * args.runs_per_query
        if args.runs_per_query < 1:
            raise ValueError("Repetitions must be positive")
        preflight(args, calls)
        file_inventory(skill)
        for _, item in queries:
            query_fixtures(item, skill)
        workspace = validate_workspace(Path(args.workspace).absolute(), skill)
        root = workspace / f"trigger-{uuid.uuid4().hex}"
        root.mkdir(mode=0o700)
        write_json(root / "execution_manifest.json", {"status": "running", "planned_calls": calls, "max_calls": args.max_calls, "model": args.model})
        results = []
        for index, item in queries:
            runs = [run_single_query(item, skill, root / f"query-{index}" / "copilot_with_skill" / f"run-{n}", args)
                    for n in range(1, args.runs_per_query + 1)]
            errors = any(run["status"] == "error" for run in runs)
            triggers = sum(run["triggered"] is True for run in runs)
            passed = not errors and all(run["pass"] for run in runs)
            results.append({
                "query_index": index, "query": item["query"], "should_trigger": item["should_trigger"],
                "triggers": triggers, "runs": len(runs), "trigger_rate": None if errors else triggers / len(runs),
                "pass": passed, "status": "error" if errors else "passed" if passed else "failed",
                "harness": "copilot", "attempts": runs,
            })
        status = "error" if any(result["status"] == "error" for result in results) else "passed" if all(result["pass"] for result in results) else "failed"
        passed = sum(result["pass"] for result in results)
        summary = {"total": len(results), "passed": passed, "failed": sum(result["status"] == "failed" for result in results), "errors": sum(result["status"] == "error" for result in results)}
        output = {
            "skill_name": name, "description": description, "kind": "description_trigger",
            "status": status, "harness": "copilot", "results": results, "summary": summary,
            "harness_results": [{"harness": "copilot", "results": results, "summary": summary}],
            "workspace": str(root), "planned_calls": calls,
            "max_calls": args.max_calls, "approved": args.approved, "model": args.model,
        }
        write_json(root / "execution_manifest.json", output)
    except (OSError, ValueError) as error:
        output = {"status": "not_run", "reason": str(error)}
    if args.output:
        write_json(Path(args.output), output)
    print(json.dumps(output, indent=2))
    return 0 if output["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
