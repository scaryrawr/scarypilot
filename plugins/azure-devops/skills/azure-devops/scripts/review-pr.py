#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# ///
"""Azure DevOps PR review helper utilities."""

from __future__ import annotations

import argparse
import json
import sys
import urllib.parse
from typing import Any

from shared.ado import (
    build_thread_payload,
    normalize_ado_file_path,
    normalize_organization,
    request_json,
    resolve_out_file,
    run,
    run_json,
    scope_args,
    strip_refs_heads,
    parse_line_number,
    token,
    upload_pr_attachment,
)


def parse_remote_organization(remote_url: str) -> str | None:
    """Extract an Azure DevOps organization from a git remote URL."""
    patterns = (
        r"https://dev.azure.com/",
        r"https://",
        r"ssh://git@ssh.dev.azure.com:v3/",
        r"git@ssh.dev.azure.com:v3/",
    )
    if remote_url.startswith(patterns[0]):
        parts = remote_url[len(patterns[0]):].split("/")
        return parts[0] if parts else None
    if remote_url.startswith(patterns[1]) and ".visualstudio.com/" in remote_url:
        host = urllib.parse.urlparse(remote_url).hostname or ""
        return host.removesuffix(".visualstudio.com")
    for prefix in patterns[2:]:
        if remote_url.startswith(prefix):
            parts = remote_url[len(prefix):].split("/")
            return parts[0] if parts else None
    return None


def eligibility(args: argparse.Namespace) -> None:
    """Print review eligibility and compact PR metadata."""
    details = run_json(["az", "repos", "pr", "show", "--id", args.id, *scope_args(args)])
    repo = details.get("repository") or {}
    project = repo.get("project") or {}
    status = details.get("status") or "unknown"
    payload = {
        "pullRequestId": details.get("pullRequestId"),
        "title": details.get("title"),
        "status": status,
        "isDraft": details.get("isDraft", False),
        "eligible": status == "active" and not details.get("isDraft", False),
        "sourceBranch": details.get("sourceRefName"),
        "sourceBranchName": strip_refs_heads(details.get("sourceRefName")),
        "targetBranch": details.get("targetRefName"),
        "targetBranchName": strip_refs_heads(details.get("targetRefName")),
        "repositoryId": repo.get("id"),
        "repositoryName": repo.get("name"),
        "projectId": project.get("id"),
        "projectName": project.get("name"),
        "lastMergeSourceCommit": (details.get("lastMergeSourceCommit") or {}).get("commitId"),
        "reviewers": [
            {"reviewer": reviewer.get("uniqueName") or reviewer.get("displayName"), "vote": reviewer.get("vote", 0)}
            for reviewer in details.get("reviewers", [])
        ],
        "url": details.get("url"),
    }
    print(json.dumps(payload, indent=2))


def sync_labels(args: argparse.Namespace) -> None:
    """Synchronize AI review labels on an Azure DevOps pull request."""
    if not args.model:
        sys.exit("error: provide at least one --model value")
    details = run_json(["az", "repos", "pr", "show", "--id", args.id, *scope_args(args)])
    repo = details.get("repository") or {}
    project = repo.get("project") or {}
    repository_id = repo.get("id")
    project_id = project.get("id")
    if not repository_id or not project_id:
        sys.exit("error: could not determine repository or project for the pull request")

    organization = args.org or parse_remote_organization(run(["git", "remote", "get-url", "origin"]))
    if not organization:
        sys.exit("error: could not determine organization; provide --org explicitly")
    normalized = normalize_organization(organization)
    access_token = token()
    endpoint = (
        f"https://dev.azure.com/{normalized['organization']}/{project_id}/_apis/git/repositories/"
        f"{repository_id}/pullRequests/{args.id}/labels?api-version=7.1"
    )
    headers = {"Authorization": f"Bearer {access_token}"}
    existing_payload = request_json(endpoint, headers=headers)
    existing = {label["name"] for label in existing_payload.get("value", []) if label.get("name")}
    desired = list(dict.fromkeys(["ai-reviewed", *[f"ai-model-{model}" for model in args.model]]))
    desired_set = set(desired)
    added: list[str] = []
    removed: list[str] = []

    for label in sorted(existing):
        if not label.startswith("ai-model-") or label in desired_set:
            continue
        delete_url = endpoint.replace("?api-version=7.1", f"/{urllib.parse.quote(label, safe='')}?api-version=7.1")
        request_json(delete_url, method="DELETE", headers=headers)
        removed.append(label)

    for label in desired:
        if label in existing:
            continue
        body = json.dumps({"name": label}).encode("utf-8")
        request_json(endpoint, method="POST", body=body, headers={**headers, "Content-Type": "application/json"})
        added.append(label)

    final_payload = request_json(endpoint, headers=headers)
    final_labels = [label["name"] for label in final_payload.get("value", []) if label.get("name")]
    print(
        json.dumps(
            {
                "organization": normalized["organization"],
                "desiredLabels": desired,
                "addedLabels": added,
                "removedLabels": removed,
                "finalLabels": final_labels,
            },
            indent=2,
        )
    )


def build_code_link(args: argparse.Namespace) -> None:
    """Print an Azure DevOps source URL for a commit file range."""
    organization = normalize_organization(args.org)["organization"]
    file_path = normalize_ado_file_path(args.file_path)
    line_start = parse_line_number(args.line_start, "--line-start")
    line_end = parse_line_number(args.line_end or line_start, "--line-end")
    query = urllib.parse.urlencode(
        {
            "path": file_path,
            "version": f"GC{args.commit}",
            "lineStart": str(line_start),
            "lineEnd": str(line_end),
            "lineStartColumn": "1",
            "lineEndColumn": "1",
        }
    )
    project = urllib.parse.quote(args.project, safe="")
    repo = urllib.parse.quote(args.repo, safe="")
    print(json.dumps({"url": f"https://dev.azure.com/{organization}/{project}/_git/{repo}?{query}"}, indent=2))


def upload_attachment(args: argparse.Namespace) -> None:
    """Upload a pull request attachment and print the created metadata."""
    print(
        json.dumps(
            upload_pr_attachment(
                org=args.org,
                project=args.project,
                repository_id=args.repository_id,
                pull_request_id=args.pull_request_id,
                file=args.file,
                file_name=args.file_name,
            ),
            indent=2,
        )
    )


def add_scope_flags(parser: argparse.ArgumentParser) -> None:
    """Add common Azure DevOps CLI scope flags."""
    parser.add_argument("--detect", default="true")
    parser.add_argument("--org", default="")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    eligibility_parser = subparsers.add_parser("eligibility")
    eligibility_parser.add_argument("--id", required=True)
    add_scope_flags(eligibility_parser)
    payload_parser = subparsers.add_parser("thread-payload")
    payload_parser.add_argument("--content", required=True)
    payload_parser.add_argument("--status", default="active")
    payload_parser.add_argument("--file-path", default="")
    payload_parser.add_argument("--line-start", type=int)
    payload_parser.add_argument("--line-end", type=int)
    payload_parser.add_argument("--out-file", default="")
    labels_parser = subparsers.add_parser("sync-labels")
    labels_parser.add_argument("--id", required=True)
    labels_parser.add_argument("--model", action="append", default=[])
    add_scope_flags(labels_parser)
    code_link_parser = subparsers.add_parser("code-link")
    code_link_parser.add_argument("--org", required=True)
    code_link_parser.add_argument("--project", required=True)
    code_link_parser.add_argument("--repo", required=True)
    code_link_parser.add_argument("--commit", required=True)
    code_link_parser.add_argument("--file-path", required=True)
    code_link_parser.add_argument("--line-start", type=int, required=True)
    code_link_parser.add_argument("--line-end", type=int)
    upload_parser = subparsers.add_parser("upload-attachment")
    upload_parser.add_argument("--org", required=True)
    upload_parser.add_argument("--project", required=True)
    upload_parser.add_argument("--repository-id", required=True)
    upload_parser.add_argument("--pull-request-id", required=True)
    upload_parser.add_argument("--file", required=True)
    upload_parser.add_argument("--file-name", default="")
    args = parser.parse_args()

    if args.command == "eligibility":
        eligibility(args)
    elif args.command == "thread-payload":
        payload = build_thread_payload(args)
        if args.out_file:
            out_file = resolve_out_file(args.out_file, "ado-review-")
            out_file.parent.mkdir(parents=True, exist_ok=True)
            out_file.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
            print(json.dumps({"outFile": str(out_file), "payload": payload}, indent=2))
        else:
            print(json.dumps(payload, indent=2))
    elif args.command == "sync-labels":
        sync_labels(args)
    elif args.command == "code-link":
        build_code_link(args)
    elif args.command == "upload-attachment":
        upload_attachment(args)


if __name__ == "__main__":
    main()
