#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# ///
"""Inspect Azure DevOps PR context and build thread payloads."""

from __future__ import annotations

import argparse
import json
import sys

from shared.ado import build_thread_payload, resolve_out_file, strip_refs_heads
from shared.pr import Publisher, Scope, cli_client
from shared.transport import AdoError, Deferred


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def context(args: argparse.Namespace) -> None:
    """Print compact context for an Azure DevOps pull request."""
    details = cli_client(args).details(args.id)
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
    client = cli_client(args)
    details = client.details(args.id)
    threads = client.threads(Scope.from_details(client.org, details))["value"]
    if args.status:
        threads = [thread for thread in threads if thread.get("status") == args.status]
    print(json.dumps({"count": len(threads), "threads": threads}, indent=2))


def list_builds(args: argparse.Namespace) -> None:
    """List pipeline runs for the pull request's current synthetic merge commit."""
    client = cli_client(args)
    details = client.details(args.id)
    payload = client.builds(Scope.from_details(client.org, details), details, args.top)
    print(json.dumps(payload, indent=2))


def reply_and_resolve(args: argparse.Namespace) -> None:
    """Reply to a pull request thread, then resolve it only after the reply succeeds."""
    client = cli_client(args)
    details = client.details(args.id)
    payload = Publisher(client, Scope.from_details(client.org, details)).reply_and_resolve(
        args.thread_id, args.content, args.status, args.user_authored,
    )
    print(json.dumps(payload, indent=2))


def snapshot(args: argparse.Namespace) -> None:
    print(json.dumps(cli_client(args).snapshot(args.id), indent=2))


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
    snapshot_parser = subparsers.add_parser("snapshot")
    snapshot_parser.add_argument("--id", required=True)
    add_scope_flags(snapshot_parser)
    threads_parser = subparsers.add_parser("list-threads")
    threads_parser.add_argument("--id", required=True)
    threads_parser.add_argument("--status", default="")
    add_scope_flags(threads_parser)
    builds_parser = subparsers.add_parser("list-builds")
    builds_parser.add_argument("--id", required=True)
    builds_parser.add_argument("--top", type=positive_int, default=100)
    add_scope_flags(builds_parser)
    resolve_parser = subparsers.add_parser("reply-and-resolve")
    resolve_parser.add_argument("--id", required=True)
    resolve_parser.add_argument("--thread-id", required=True)
    resolve_parser.add_argument("--content", required=True)
    resolve_parser.add_argument("--user-authored", action="store_true")
    resolve_parser.add_argument("--status", default="fixed", choices=["fixed", "closed", "wontFix", "byDesign"])
    add_scope_flags(resolve_parser)
    payload_parser = subparsers.add_parser("thread-payload")
    payload_parser.add_argument("--content", required=True)
    payload_parser.add_argument("--user-authored", action="store_true")
    payload_parser.add_argument("--status", default="active")
    payload_parser.add_argument("--file-path", default="")
    payload_parser.add_argument("--line-start", type=int)
    payload_parser.add_argument("--line-end", type=int)
    payload_parser.add_argument("--out-file", default="")
    args = parser.parse_args()

    if args.command == "context":
        context(args)
    elif args.command == "snapshot":
        snapshot(args)
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
    try:
        main()
    except Deferred as exc:
        print(json.dumps({"error": str(exc), "deferred": True, "retryAt": exc.retry_at}), file=sys.stderr)
        sys.exit(2)
    except AdoError as exc:
        sys.exit(f"error: {exc}")
