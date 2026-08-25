#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# ///
"""Azure DevOps PR creation helper utilities."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.parse
from pathlib import Path
from typing import Any

from shared.ado import normalize_organization, request_json, run, token, upload_pr_attachment


PR_DESCRIPTION_MAX = 4000


def git(args: list[str], cwd: Path | None = None, *, exit_on_error: bool = True) -> str:
    """Run git with optional repository cwd."""
    return run(["git", *args], cwd=cwd, exit_on_error=exit_on_error)


def parse_azure_remote(remote_url: str) -> dict[str, Any] | None:
    """Parse Azure DevOps HTTPS or SSH git remotes."""
    parsed = urllib.parse.urlparse(remote_url)
    if parsed.scheme == "https" and parsed.hostname:
        is_visual_studio = parsed.hostname.endswith(".visualstudio.com")
        is_dev_azure = parsed.hostname == "dev.azure.com"
        if is_visual_studio or is_dev_azure:
            segments = [urllib.parse.unquote(part) for part in parsed.path.split("/") if part]
            if is_dev_azure:
                if not segments:
                    return None
                organization, segments = segments[0], segments[1:]
            else:
                organization = parsed.hostname.removesuffix(".visualstudio.com")
                if segments[:1] == ["DefaultCollection"]:
                    segments = segments[1:]
            repository_index = 3 if len(segments) > 2 and segments[2] == "_optimized" else 2
            if len(segments) <= repository_index or len(segments) < 2 or segments[1] != "_git":
                return None
            return {
                "organization": organization,
                "organizationUrl": f"https://dev.azure.com/{organization}",
                "project": segments[0],
                "repository": segments[repository_index],
                "scheme": "https",
            }

    ssh_prefixes = ("ssh://git@ssh.dev.azure.com:v3/", "git@ssh.dev.azure.com:v3/")
    for prefix in ssh_prefixes:
        if remote_url.startswith(prefix):
            parts = remote_url[len(prefix):].split("/")
            if len(parts) >= 3:
                organization, project, repository = parts[:3]
                return {
                    "organization": organization,
                    "organizationUrl": f"https://dev.azure.com/{organization}",
                    "project": project,
                    "repository": repository,
                    "scheme": "ssh",
                }
    return None


def repo_root(value: str | None) -> Path:
    """Return the repository root to inspect."""
    return Path(value).resolve() if value else Path(git(["rev-parse", "--show-toplevel"])).resolve()


def preflight(args: argparse.Namespace) -> None:
    """Print PR-creation preflight state for the current repository."""
    root = repo_root(args.repo_root)
    branch = git(["rev-parse", "--abbrev-ref", "HEAD"], root)
    head = git(["rev-parse", "HEAD"], root)
    status_lines = [line for line in git(["status", "--short"], root).splitlines() if line]
    conflict_files = [line for line in git(["diff", "--name-only", "--diff-filter=U"], root).splitlines() if line]

    has_origin_remote = True
    origin_remote_url = None
    try:
        origin_remote_url = git(["remote", "get-url", "origin"], root, exit_on_error=False)
    except subprocess.CalledProcessError:
        has_origin_remote = False

    default_branch = None
    try:
        symbolic_ref = git(["symbolic-ref", "refs/remotes/origin/HEAD"], root, exit_on_error=False)
        default_branch = symbolic_ref.removeprefix("refs/remotes/origin/")
    except subprocess.CalledProcessError:
        default_branch = None

    blockers: list[str] = []
    warnings: list[str] = []
    is_detached_head = branch == "HEAD"
    if is_detached_head:
        blockers.append("Detached HEAD")
    if conflict_files:
        blockers.append("Merge conflicts present")
    if not has_origin_remote:
        blockers.append("No origin remote")

    parsed_remote = parse_azure_remote(origin_remote_url) if origin_remote_url else None
    if origin_remote_url and not parsed_remote:
        blockers.append("Origin remote is not a recognized Azure DevOps remote")
    if default_branch and branch == default_branch:
        warnings.append(f"Current branch matches the default branch ({default_branch})")

    print(
        json.dumps(
            {
                "repoRoot": str(root),
                "branch": branch,
                "head": head,
                "isDetachedHead": is_detached_head,
                "hasUncommittedChanges": bool(status_lines),
                "statusLines": status_lines,
                "hasConflicts": bool(conflict_files),
                "conflictFiles": conflict_files,
                "hasOriginRemote": has_origin_remote,
                "originRemoteUrl": origin_remote_url,
                "parsedRemote": parsed_remote,
                "defaultBranch": default_branch,
                "isOnDefaultBranch": bool(default_branch and branch == default_branch),
                "blockers": blockers,
                "warnings": warnings,
            },
            indent=2,
        )
    )


def first_existing(paths: list[Path]) -> Path | None:
    """Return the first existing file from candidates."""
    return next((path for path in paths if path.exists()), None)


def discover_template(args: argparse.Namespace) -> None:
    """Discover a pull request template for a target branch."""
    root = repo_root(args.repo_root)
    target_branch = args.target_branch
    checked: list[Path] = []
    branch_template_bases = [
        ".azuredevops/pull_request_template/branches",
        ".vsts/pull_request_template/branches",
        "docs/pull_request_template/branches",
        "pull_request_template/branches",
    ]
    general_templates = [
        ".azuredevops/pull_request_template.md",
        ".azuredevops/pull_request_template.txt",
        ".vsts/pull_request_template.md",
        ".vsts/pull_request_template.txt",
        "docs/pull_request_template.md",
        "docs/pull_request_template.txt",
        "pull_request_template.md",
        "pull_request_template.txt",
    ]
    additional_dirs = [
        ".azuredevops/pull_request_template",
        ".vsts/pull_request_template",
        "docs/pull_request_template",
        "pull_request_template",
    ]

    found: Path | None = None
    if target_branch:
        branch_candidates = [
            root / base / f"{target_branch}{suffix}"
            for base in branch_template_bases
            for suffix in (".md", ".txt")
        ]
        checked.extend(branch_candidates)
        found = first_existing(branch_candidates)
    if not found:
        general_candidates = [root / relative for relative in general_templates]
        checked.extend(general_candidates)
        found = first_existing(general_candidates)

    additional_templates: list[Path] = []
    for directory in additional_dirs:
        absolute = root / directory
        if not absolute.is_dir():
            continue
        additional_templates.extend(path for path in absolute.iterdir() if path.is_file() and path.suffix in {".md", ".txt"})

    selected = found or (additional_templates[0] if len(additional_templates) == 1 else None)
    print(
        json.dumps(
            {
                "repoRoot": str(root),
                "targetBranch": target_branch,
                "selectedPath": str(selected) if selected else None,
                "selectedContent": selected.read_text(encoding="utf-8") if selected else None,
                "checked": [str(path) for path in checked],
                "additionalTemplates": [str(path) for path in additional_templates],
            },
            indent=2,
        )
    )


def normalize_ref(branch: str) -> str:
    """Normalize a branch name to a full Azure DevOps refs/heads ref."""
    if branch.startswith("refs/"):
        return branch
    return f"refs/heads/{branch.removeprefix('origin/')}"


def read_description(args: argparse.Namespace) -> str:
    """Read and validate the PR description from inline text or a file."""
    description = ""
    if args.description_file:
        description = Path(args.description_file).read_text(encoding="utf-8")
    elif args.description is not None:
        description = args.description
    description = description.replace("\r\n", "\n")
    if len(description) > PR_DESCRIPTION_MAX:
        sys.exit(
            f"error: PR description is {len(description)} characters, exceeding the Azure DevOps limit of "
            f"{PR_DESCRIPTION_MAX}. Trim it (keep every template section, drop verbose detail) and retry."
        )
    return description


def create_pr(args: argparse.Namespace) -> None:
    """Create an Azure DevOps pull request through REST to preserve multiline descriptions."""
    normalized = normalize_organization(args.org)
    project = urllib.parse.quote(args.project, safe="")
    repository = args.repository_id or args.repository
    if not repository:
        sys.exit("error: provide --repository-id or --repository")
    repository_quoted = urllib.parse.quote(repository, safe="")
    description = read_description(args)
    url = f"{normalized['organizationUrl']}/{project}/_apis/git/repositories/{repository_quoted}/pullrequests?api-version=7.1"
    body = json.dumps(
        {
            "sourceRefName": normalize_ref(args.source_branch),
            "targetRefName": normalize_ref(args.target_branch),
            "title": args.title,
            "description": description,
            "isDraft": args.draft,
        }
    ).encode("utf-8")
    payload = request_json(
        url,
        method="POST",
        body=body,
        headers={"Authorization": f"Bearer {token()}", "Content-Type": "application/json"},
    )
    repo = payload.get("repository") or {}
    repo_name = repo.get("name") or repository
    pull_request_id = payload.get("pullRequestId")
    web_url = (
        f"{normalized['organizationUrl']}/{project}/_git/{urllib.parse.quote(repo_name, safe='')}/pullrequest/{pull_request_id}"
        if pull_request_id
        else None
    )
    print(
        json.dumps(
            {
                "pullRequestId": pull_request_id,
                "isDraft": payload.get("isDraft"),
                "title": payload.get("title"),
                "sourceRefName": payload.get("sourceRefName"),
                "targetRefName": payload.get("targetRefName"),
                "descriptionLength": len(description),
                "repositoryId": repo.get("id"),
                "repositoryName": repo_name,
                "webUrl": web_url,
                "apiUrl": payload.get("url"),
            },
            indent=2,
        )
    )


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


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    preflight_parser = subparsers.add_parser("preflight")
    preflight_parser.add_argument("--repo-root", default="")
    template_parser = subparsers.add_parser("discover-template")
    template_parser.add_argument("--repo-root", default="")
    template_parser.add_argument("--target-branch", default="")
    create_parser = subparsers.add_parser("create-pr")
    create_parser.add_argument("--org", required=True)
    create_parser.add_argument("--project", required=True)
    create_parser.add_argument("--repository-id", default="")
    create_parser.add_argument("--repository", default="")
    create_parser.add_argument("--source-branch", required=True)
    create_parser.add_argument("--target-branch", required=True)
    create_parser.add_argument("--title", required=True)
    create_parser.add_argument("--description-file", default="")
    create_parser.add_argument("--description")
    create_parser.add_argument("--draft", action="store_true")
    upload_parser = subparsers.add_parser("upload-attachment")
    upload_parser.add_argument("--org", required=True)
    upload_parser.add_argument("--project", required=True)
    upload_parser.add_argument("--repository-id", required=True)
    upload_parser.add_argument("--pull-request-id", required=True)
    upload_parser.add_argument("--file", required=True)
    upload_parser.add_argument("--file-name", default="")
    args = parser.parse_args()

    if args.command == "preflight":
        preflight(args)
    elif args.command == "discover-template":
        discover_template(args)
    elif args.command == "create-pr":
        create_pr(args)
    elif args.command == "upload-attachment":
        upload_attachment(args)


if __name__ == "__main__":
    main()
