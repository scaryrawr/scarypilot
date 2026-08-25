#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# ///
"""Inspect Azure DevOps PR context and build thread payloads."""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from shared.ado import build_thread_payload, resolve_out_file, run_json, scope_args, strip_refs_heads


def context(args: argparse.Namespace) -> None:
    """Print compact context for an Azure DevOps pull request."""
    details = run_json(["az", "repos", "pr", "show", "--id", args.id, *scope_args(args)])
    repo = details.get("repository") or {}
    project = repo.get("project") or {}
    payload = {
        "pullRequestId": details.get("pullRequestId"),
        "title": details.get("title"),
        "status": details.get("status"),
        "isDraft": details.get("isDraft", False),
        "sourceBranch": details.get("sourceRefName"),
        "sourceBranchName": strip_refs_heads(details.get("sourceRefName")),
        "targetBranch": details.get("targetRefName"),
        "targetBranchName": strip_refs_heads(details.get("targetRefName")),
        "repositoryId": repo.get("id"),
        "repositoryName": repo.get("name"),
        "projectId": project.get("id"),
        "projectName": project.get("name"),
        "createdBy": (details.get("createdBy") or {}).get("uniqueName") or (details.get("createdBy") or {}).get("displayName"),
        "url": details.get("url"),
    }
    print(json.dumps(payload, indent=2))


def list_threads(args: argparse.Namespace) -> None:
    """List Azure DevOps pull request threads, optionally filtering by status."""
    details = run_json(["az", "repos", "pr", "show", "--id", args.id, *scope_args(args)])
    repo = details.get("repository") or {}
    project = repo.get("project") or {}
    project_name = project.get("name")
    repository_id = repo.get("id")
    if not project_name or not repository_id:
        sys.exit("error: could not determine project or repository for the pull request")

    response = run_json(
        [
            "az",
            "devops",
            "invoke",
            "--area",
            "git",
            "--resource",
            "pullRequestThreads",
            "--route-parameters",
            f"project={project_name}",
            f"repositoryId={repository_id}",
            f"pullRequestId={args.id}",
            "--api-version",
            "7.1",
            *scope_args(args),
        ]
    )
    threads = response.get("value") or []
    if args.status:
        threads = [thread for thread in threads if thread.get("status") == args.status]
    print(json.dumps({"count": len(threads), "threads": threads}, indent=2))


def add_scope_flags(parser: argparse.ArgumentParser) -> None:
    """Add common Azure DevOps CLI scope flags."""
    parser.add_argument("--detect", default="true")
    parser.add_argument("--org", default="")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    context_parser = subparsers.add_parser("context")
    context_parser.add_argument("--id", required=True)
    add_scope_flags(context_parser)
    threads_parser = subparsers.add_parser("list-threads")
    threads_parser.add_argument("--id", required=True)
    threads_parser.add_argument("--status", default="")
    add_scope_flags(threads_parser)
    payload_parser = subparsers.add_parser("thread-payload")
    payload_parser.add_argument("--content", required=True)
    payload_parser.add_argument("--status", default="active")
    payload_parser.add_argument("--file-path", default="")
    payload_parser.add_argument("--line-start", type=int)
    payload_parser.add_argument("--line-end", type=int)
    payload_parser.add_argument("--out-file", default="")
    args = parser.parse_args()

    if args.command == "context":
        context(args)
    elif args.command == "list-threads":
        list_threads(args)
    elif args.command == "thread-payload":
        payload = build_thread_payload(args)
        if args.out_file:
            out_file = resolve_out_file(args.out_file, "ado-pr-")
            out_file.parent.mkdir(parents=True, exist_ok=True)
            out_file.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
            print(json.dumps({"outFile": str(out_file), "payload": payload}, indent=2))
        else:
            print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
