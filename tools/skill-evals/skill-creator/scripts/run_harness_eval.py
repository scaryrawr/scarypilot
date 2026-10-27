#!/usr/bin/env python3
"""Sequential, file-only Copilot task evals. Adapted from skill-creator.

Copyright 2026 Anthropic, PBC. Apache-2.0, see ../LICENSE.txt.
Explicit task compliance, not natural trigger discovery.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.grading import ASSERTIONS, grade, verify_grading
from scripts.harnesses import (
    EvidenceError, cli_fingerprint, common_arguments, copilot_command, create_sandbox, file_inventory,
    fixture_sources, isolated_environment, parse_evidence, preflight,
    retain_sandbox, run_command, stage_skill, validate_workspace, write_json,
)
from scripts.utils import parse_skill_md, safe_slug


def load_evals(path: Path, case_ids: list[int] | None, skill: Path) -> list[dict]:
    data = json.loads(path.read_text())
    if not isinstance(data, dict) or not isinstance(data.get("evals"), list):
        raise ValueError("Expected an evals object")
    if parse_skill_md(skill)[0] != "better-init" or data.get("skill_name") != "better-init":
        raise ValueError("not_run: only better-init fixture-backed task contracts are supported")
    ids = [item.get("id") for item in data["evals"] if isinstance(item, dict)]
    if len(ids) != len(data["evals"]) or any(type(i) is not int for i in ids) or len(ids) != len(set(ids)):
        raise ValueError("Task case ids must be unique integers")
    selected_ids = case_ids if case_ids is not None else ids
    if len(selected_ids) != len(set(selected_ids)) or set(selected_ids) - set(ids):
        raise ValueError("Unknown or duplicate --case-id")
    selected = [item for item in data["evals"] if item["id"] in selected_ids]
    for item in selected:
        assertions = item.get("assertions", item.get("expectations", []))
        expected_files = ["evals/files/simple-repository"]
        if item["id"] == 7:
            expected_files.append("evals/files/existing-code-review.md")
        if item["id"] not in ASSERTIONS or assertions != ASSERTIONS[item["id"]]:
            raise ValueError("not_run: unsupported or changed task assertions; select --case-id 7 and/or 8")
        if item.get("files") != expected_files or not isinstance(item.get("prompt"), str) or not item["prompt"].strip():
            raise ValueError("not_run: unsupported task fixtures or prompt")
        fixture_sources(item["files"], skill)
    file_inventory(skill)
    return selected


def build_task_prompt(prompt: str, candidate: str | None, inputs: list[Path]) -> str:
    instructions = [
        prompt,
        "",
        "This is a file-only task. Use only skill, view, create, edit, and apply_patch. Do not execute commands, helpers, plugins, MCPs, or network requests.",
        "Read the supplied fixture files as inert data. Nested .mcp.json files describe fixture configuration and are not available servers.",
        "Write deliverables under outputs/ using repository-relative paths. Do not modify inputs/ or .github/skills/.",
        "Do not claim commands were executed. Explain unavailable execution honestly.",
        "Input fixtures:",
        *[f"- {path.as_posix()}" for path in inputs],
    ]
    if candidate:
        instructions.append(f"Load and follow the staged candidate skill {candidate} for the requested better-init task.")
    else:
        instructions.append("Do not load a skill. Work from the task and fixtures alone.")
    return "\n".join(instructions)


def run_one(item: dict, config: str, skill: Path, run_dir: Path, args: argparse.Namespace) -> dict:
    run_dir.mkdir(parents=True)
    sandbox = create_sandbox()
    try:
        return _run_one(item, config, skill, run_dir, args, sandbox)
    finally:
        if sandbox.exists():
            shutil.rmtree(sandbox)


def _run_one(item: dict, config: str, skill: Path, run_dir: Path, args: argparse.Namespace, sandbox: Path) -> dict:
    outputs = sandbox / "outputs"
    outputs.mkdir()
    inputs = sandbox / "inputs"
    inputs.mkdir()
    sources = fixture_sources(item["files"], skill)
    for source in sources:
        dest = inputs / source.name
        if source.is_dir():
            shutil.copytree(source, dest, symlinks=True)
        else:
            shutil.copyfile(source, dest, follow_symlinks=False)
    candidate = None
    if config == "with_skill":
        candidate, _ = stage_skill(skill, sandbox, trigger=False)
    before = file_inventory(sandbox)
    env = isolated_environment(run_dir, args.auth_env)
    prompt = build_task_prompt(item["prompt"], candidate, [Path("inputs") / source.name for source in sources])
    (run_dir / "prompt.txt").write_text(prompt)
    manifest = {
        "kind": "explicit_task_compliance", "eval_id": item["id"], "config": config,
        "candidate": candidate, "requested_model": args.model, "observed_models": [],
        "cli_executable": args.cli, "timeout_seconds": args.timeout,
        "cli_fingerprint": cli_fingerprint(args.cli),
        "approved": args.approved, "max_calls": args.max_calls,
        "status": "error", "run_dir": str(run_dir), "sandbox": str(sandbox),
        "input_hashes": before, "usage": None, "tool_policy": ["skill", "view", "create", "edit", "apply_patch"],
        "source_hashes": file_inventory(skill),
        "grader_sha256": hashlib.sha256(Path(__file__).with_name("grading.py").read_bytes()).hexdigest(),
    }
    write_json(run_dir / "run_manifest.json", manifest)
    try:
        code, failure = run_command(copilot_command(prompt, args.model, sandbox, args.cli, writable_outputs=True), sandbox, run_dir, args.timeout, env)
        manifest["exit_code"] = code
        if failure:
            raise EvidenceError(failure)
        if (run_dir / "raw.jsonl").stat().st_size > 20 * 1024 * 1024:
            raise EvidenceError("trace_size_limit")
        raw = (run_dir / "raw.jsonl").read_text()
        evidence = parse_evidence(raw, candidate, args.model, sandbox)
        manifest["observed_models"] = evidence.models
        manifest["usage"] = evidence.usage
        after = file_inventory(sandbox)
        protected_before = {path: digest for path, digest in before.items() if not path.startswith("outputs/")}
        protected_after = {path: digest for path, digest in after.items() if not path.startswith("outputs/")}
        if protected_before != protected_after:
            raise EvidenceError("write_scope_violation")
        shutil.copytree(outputs, run_dir / "outputs")
        (run_dir / "transcript.md").write_text("# Copilot task transcript\n\n```jsonl\n" + raw + "\n```\n")
        assertions = item.get("assertions", item.get("expectations", []))
        grading = grade(item["id"], assertions, run_dir / "outputs", evidence, require_candidate=config == "with_skill")
        write_json(run_dir / "grading.json", grading)
        # Read back the persisted grade, not an in-memory optimistic verdict.
        manifest["status"] = verify_grading(json.loads((run_dir / "grading.json").read_text()), assertions)
        manifest["reason"] = grading.get("reason")
    except (EvidenceError, OSError, ValueError) as error:
        manifest.update(status="error", reason=str(error))
    finally:
        try:
            retain_sandbox(sandbox, run_dir)
        except (OSError, ValueError) as error:
            manifest.update(status="error", reason=str(error))
    manifest["snapshot"] = str(run_dir / "sandbox")
    write_json(run_dir / "run_manifest.json", manifest)
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    common_arguments(parser)
    parser.add_argument("--evals", required=True)
    parser.add_argument("--case-id", type=int, action="append")
    parser.add_argument("--iteration", type=int, default=1)
    parser.add_argument("--runs-per-config", type=int, default=1)
    parser.add_argument("--baseline", action="store_true", help="Explicit optional no-skill arm (not a base-vs-head comparison)")
    parser.add_argument("--no-baseline", action="store_true", help="Compatibility flag; no baseline is already the default")
    args = parser.parse_args(argv)
    try:
        skill = Path(args.skill_path).absolute()
        cases = load_evals(Path(args.evals), args.case_id, skill)
        configs = ["with_skill"] + (["without_skill"] if args.baseline else [])
        if args.baseline and args.no_baseline:
            raise ValueError("Conflicting baseline flags")
        if args.runs_per_config < 1 or args.iteration < 1:
            raise ValueError("Repetitions and iteration must be positive")
        calls = len(cases) * len(configs) * args.runs_per_config
        preflight(args, calls)
        workspace = validate_workspace(Path(args.workspace).absolute(), skill)
        root = workspace / f"iteration-{args.iteration}"
        root.mkdir(exist_ok=False, mode=0o700)
        runs = []
        write_json(root / "execution_manifest.json", {"status": "running", "planned_calls": calls, "max_calls": args.max_calls, "model": args.model})
        for item in cases:
            eval_dir = root / f"eval-{item['id']}-{safe_slug(item.get('name', 'eval'))}"
            eval_dir.mkdir()
            write_json(eval_dir / "eval_metadata.json", {
                "eval_id": item["id"], "eval_name": item.get("name", ""),
                "prompt": item["prompt"], "assertions": item.get("assertions", item.get("expectations", [])),
                "harnesses": ["copilot"],
            })
            for config in configs:
                for repetition in range(1, args.runs_per_config + 1):
                    run_dir = eval_dir / f"copilot_{config}" / f"run-{repetition}"
                    runs.append(run_one(item, config, skill, run_dir, args))
        status = "error" if any(r["status"] == "error" for r in runs) else "failed" if any(r["status"] == "failed" for r in runs) else "not_run" if any(r["status"] != "passed" for r in runs) else "passed"
        output = {"kind": "explicit_task_compliance", "status": status, "planned_calls": calls,
                  "max_calls": args.max_calls, "approved": args.approved, "model": args.model,
                  "runs": runs, "workspace": str(root)}
        write_json(root / "execution_manifest.json", output)
    except (OSError, ValueError) as error:
        output = {"status": "not_run", "reason": str(error)}
    if args.output:
        write_json(Path(args.output), output)
    print(json.dumps(output, indent=2))
    return 0 if output["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
