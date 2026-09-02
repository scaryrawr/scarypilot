#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# ///
"""Inspect Azure DevOps PR context and build thread payloads."""

from __future__ import annotations

import argparse
import json
import shutil
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


def list_builds(args: argparse.Namespace) -> None:
    """List pipeline runs for the pull request's current synthetic merge commit."""
    details = run_json(["az", "repos", "pr", "show", "--id", args.id, *scope_args(args)])
    repo = details.get("repository") or {}
    project = repo.get("project") or {}
    project_name = project.get("name")
    repository_id = repo.get("id")
    merge_commit_id = (details.get("lastMergeCommit") or {}).get("commitId")
    if not project_name or not repository_id or not merge_commit_id:
        sys.exit("error: could not determine project, repository, or current merge commit for the pull request")

    merge_ref = f"refs/pull/{args.id}/merge"
    response = run_json(
        [
            "az",
            "devops",
            "invoke",
            "--area",
            "build",
            "--resource",
            "builds",
            "--route-parameters",
            f"project={project_name}",
            "--query-parameters",
            f"branchName={merge_ref}",
            f"repositoryId={repository_id}",
            "repositoryType=TfsGit",
            "queryOrder=queueTimeDescending",
            f"$top={args.top}",
            "--api-version",
            "7.1",
            *scope_args(args),
        ]
    )
    current_builds = [
        build for build in response.get("value") or [] if build.get("sourceVersion") == merge_commit_id
    ]
    builds = [
        {
            "id": build.get("id"),
            "buildNumber": build.get("buildNumber"),
            "status": build.get("status"),
            "result": build.get("result"),
            "definitionId": (build.get("definition") or {}).get("id"),
            "definitionName": (build.get("definition") or {}).get("name"),
            "sourceBranch": build.get("sourceBranch"),
            "sourceVersion": build.get("sourceVersion"),
            "queueTime": build.get("queueTime"),
            "startTime": build.get("startTime"),
            "finishTime": build.get("finishTime"),
            "url": ((build.get("_links") or {}).get("web") or {}).get("href") or build.get("url"),
        }
        for build in current_builds
    ]
    failed_results = {"failed", "partiallySucceeded", "canceled"}
    failed = [build for build in builds if build.get("result") in failed_results]
    pending = [build for build in builds if build.get("status") != "completed"]
    succeeded = [build for build in builds if build.get("result") == "succeeded"]
    payload = {
        "pullRequestId": details.get("pullRequestId"),
        "mergeRef": merge_ref,
        "mergeCommitId": merge_commit_id,
        "hasFailures": bool(failed),
        "hasPending": bool(pending),
        "failed": failed,
        "pending": pending,
        "succeeded": succeeded,
        "builds": builds,
    }
    print(json.dumps(payload, indent=2))


def invoke_thread_api(
    args: argparse.Namespace,
    *,
    resource: str,
    method: str,
    payload: dict[str, Any],
    thread_id: str,
) -> Any:
    """Invoke a PR thread API with a temporary JSON payload."""
    details = run_json(["az", "repos", "pr", "show", "--id", args.id, *scope_args(args)])
    repo = details.get("repository") or {}
    project = repo.get("project") or {}
    project_name = project.get("name")
    repository_id = repo.get("id")
    if not project_name or not repository_id:
        sys.exit("error: could not determine project or repository for the pull request")

    out_file = resolve_out_file("auto", "ado-pr-thread-")
    try:
        out_file.write_text(json.dumps(payload), encoding="utf-8")
        route_parameters = [
            f"project={project_name}",
            f"repositoryId={repository_id}",
            f"pullRequestId={args.id}",
            f"threadId={thread_id}",
        ]
        return run_json(
            [
                "az",
                "devops",
                "invoke",
                "--area",
                "git",
                "--resource",
                resource,
                "--route-parameters",
                *route_parameters,
                "--http-method",
                method,
                "--api-version",
                "7.1",
                "--in-file",
                str(out_file),
                *scope_args(args),
            ]
        )
    finally:
        shutil.rmtree(out_file.parent, ignore_errors=True)


def reply_and_resolve(args: argparse.Namespace) -> None:
    """Reply to a pull request thread, then resolve it only after the reply succeeds."""
    reply = invoke_thread_api(
        args,
        resource="pullRequestThreadComments",
        method="POST",
        payload={"content": args.content, "parentCommentId": 0, "commentType": 1},
        thread_id=args.thread_id,
    )
    resolved = invoke_thread_api(
        args,
        resource="pullRequestThreads",
        method="PATCH",
        payload={"status": args.status},
        thread_id=args.thread_id,
    )
    print(json.dumps({"reply": reply, "thread": resolved}, indent=2))


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
    builds_parser = subparsers.add_parser("list-builds")
    builds_parser.add_argument("--id", required=True)
    builds_parser.add_argument("--top", type=int, default=100)
    add_scope_flags(builds_parser)
    resolve_parser = subparsers.add_parser("reply-and-resolve")
    resolve_parser.add_argument("--id", required=True)
    resolve_parser.add_argument("--thread-id", required=True)
    resolve_parser.add_argument("--content", required=True)
    resolve_parser.add_argument("--status", default="fixed", choices=["fixed", "closed", "wontFix", "byDesign"])
    add_scope_flags(resolve_parser)
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
    elif args.command == "list-builds":
        list_builds(args)
    elif args.command == "reply-and-resolve":
        reply_and_resolve(args)
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
