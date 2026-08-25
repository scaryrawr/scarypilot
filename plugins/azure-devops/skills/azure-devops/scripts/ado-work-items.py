#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# ///
"""Build Azure Boards helper payloads."""

from __future__ import annotations

import argparse
import json
import shlex
import sys
import urllib.parse
from typing import Any

from shared.ado import normalize_organization, request_json, token


def parse_work_item_url(raw_url: str) -> dict[str, Any]:
    """Parse a supported Azure DevOps work item URL."""
    parsed = urllib.parse.urlparse(raw_url)
    is_visual_studio = (parsed.hostname or "").endswith(".visualstudio.com")
    is_dev_azure = parsed.hostname == "dev.azure.com"
    if not is_visual_studio and not is_dev_azure:
        sys.exit(f"error: unsupported Azure DevOps host: {parsed.hostname}")

    segments = [urllib.parse.unquote(part) for part in parsed.path.split("/") if part]
    if is_dev_azure:
        if not segments:
            sys.exit(f"error: could not determine organization from {raw_url}")
        organization, segments = segments[0], segments[1:]
    else:
        organization = (parsed.hostname or "").removesuffix(".visualstudio.com")
        if segments[:1] == ["DefaultCollection"]:
            segments = segments[1:]

    if len(segments) < 4 or segments[1] != "_workitems" or segments[2] != "edit":
        sys.exit(f"error: URL is not a recognized work item URL: {raw_url}")
    try:
        work_item_id = int(segments[3])
    except ValueError:
        sys.exit(f"error: could not determine work item id from {raw_url}")

    return {
        "url": raw_url,
        "host": parsed.hostname,
        "organization": organization,
        "organizationUrl": f"https://dev.azure.com/{organization}",
        "project": segments[0],
        "workItemId": work_item_id,
    }


def escape_wiql_string(value: str) -> str:
    """Escape a value for a WIQL string literal."""
    return "'" + value.replace("'", "''") + "'"


def powershell_quote(value: str) -> str:
    """Quote a string as a PowerShell single-quoted literal."""
    return "'" + value.replace("'", "''") + "'"


def build_wiql(args: argparse.Namespace) -> dict[str, Any]:
    """Build a WIQL query and equivalent az command arguments."""
    fields = args.fields or "System.Id,System.Title,System.State"
    clauses: list[str] = []
    if args.assigned_to:
        assigned = "@Me" if args.assigned_to == "@Me" else escape_wiql_string(args.assigned_to)
        clauses.append(f"[System.AssignedTo] = {assigned}")
    if args.state:
        clauses.append(f"[System.State] IN ({', '.join(escape_wiql_string(value) for value in args.state)})")
    excluded_states = ["Closed", "Removed", *args.exclude_state] if args.current else args.exclude_state
    for state in dict.fromkeys(excluded_states):
        clauses.append(f"[System.State] <> {escape_wiql_string(state)}")
    if args.type:
        clauses.append(f"[System.WorkItemType] IN ({', '.join(escape_wiql_string(value) for value in args.type)})")
    clauses.extend(args.extra_clause)

    select_fields = ", ".join(f"[{field.strip()}]" for field in fields.split(","))
    where_clause = f" WHERE {' AND '.join(clauses)}" if clauses else ""
    wiql = f"SELECT {select_fields} FROM workitems{where_clause} ORDER BY [System.ChangedDate] DESC"
    executable = "az"
    command_args = ["boards", "query", "--wiql", wiql, "--detect", "true"]
    posix_command = " ".join(shlex.quote(part) for part in [executable, *command_args])
    powershell_command = f"az boards query --wiql {powershell_quote(wiql)} --detect true"
    return {
        "wiql": wiql,
        "executable": executable,
        "commandArgs": command_args,
        "posixCommand": posix_command,
        "powerShellCommand": powershell_command,
    }


def auth_headers(content_type: str | None = None) -> dict[str, str]:
    """Return Azure DevOps REST authorization headers."""
    headers = {"Authorization": f"Bearer {token()}"}
    if content_type:
        headers["Content-Type"] = content_type
    return headers


def search_work_items(args: argparse.Namespace) -> None:
    """Search work items with the Azure DevOps work item search API."""
    normalized = normalize_organization(args.org)
    top = args.top if args.top > 0 else 25
    filters: dict[str, list[str]] = {}
    if args.type:
        filters["System.WorkItemType"] = args.type
    if args.project:
        filters["System.TeamProject"] = args.project
    if args.area:
        filters["System.AreaPath"] = args.area
    body: dict[str, Any] = {"searchText": args.text, "$top": top}
    if filters:
        body["filters"] = filters
    payload = request_json(
        f"https://almsearch.dev.azure.com/{normalized['organization']}/_apis/search/workitemsearchresults?api-version=7.1",
        method="POST",
        body=json.dumps(body).encode("utf-8"),
        headers=auth_headers("application/json"),
    )
    results = []
    for result in payload.get("results", []):
        fields = result.get("fields") or {}
        item_id = fields.get("system.id")
        project_name = (result.get("project") or {}).get("name") or ""
        results.append(
            {
                "id": int(item_id) if item_id else None,
                "type": fields.get("system.workitemtype"),
                "state": fields.get("system.state"),
                "title": fields.get("system.title"),
                "assignedTo": fields.get("system.assignedto"),
                "areaPath": fields.get("system.areapath"),
                "project": project_name,
                "url": (
                    f"{normalized['organizationUrl']}/{urllib.parse.quote(project_name, safe='')}/_workitems/edit/{item_id}"
                    if item_id
                    else None
                ),
            }
        )
    print(json.dumps({"count": payload.get("count", len(results)), "results": results}, indent=2))


def required_fields(args: argparse.Namespace) -> None:
    """List always-required fields for a work item type."""
    normalized = normalize_organization(args.org)
    payload = request_json(
        f"{normalized['organizationUrl']}/{urllib.parse.quote(args.project, safe='')}/_apis/wit/workitemtypes/"
        f"{urllib.parse.quote(args.type, safe='')}/fields?$expand=all&api-version=7.1",
        headers=auth_headers(),
    )
    fields = [
        {
            "referenceName": field.get("referenceName"),
            "name": field.get("name"),
            "allowedValues": field.get("allowedValues") or [],
            "defaultValue": field.get("defaultValue"),
        }
        for field in payload.get("value", [])
        if field.get("alwaysRequired")
    ]
    print(json.dumps({"workItemType": args.type, "project": args.project, "requiredFields": fields}, indent=2))


def link_pr(args: argparse.Namespace) -> None:
    """Link an Azure DevOps pull request to a work item with a named ArtifactLink."""
    normalized = normalize_organization(args.org)
    project_id = args.project_id
    repository_id = args.repository_id
    if not project_id or not repository_id:
        if not args.project or not args.repository:
            sys.exit("error: provide either --project-id/--repository-id or --project/--repository")
        repo_payload = request_json(
            f"{normalized['organizationUrl']}/{urllib.parse.quote(args.project, safe='')}/_apis/git/repositories/"
            f"{urllib.parse.quote(args.repository, safe='')}?api-version=7.1",
            headers=auth_headers(),
        )
        repository_id = repo_payload.get("id")
        project_id = (repo_payload.get("project") or {}).get("id")
    if not project_id or not repository_id:
        sys.exit("error: could not resolve project id and repository id for the pull request link")
    artifact_url = f"vstfs:///Git/PullRequestId/{project_id}%2F{repository_id}%2F{args.pull_request_id}"
    patch = [
        {
            "op": "add",
            "path": "/relations/-",
            "value": {"rel": "ArtifactLink", "url": artifact_url, "attributes": {"name": "Pull Request"}},
        }
    ]
    payload = request_json(
        f"{normalized['organizationUrl']}/_apis/wit/workitems/{args.work_item_id}?api-version=7.1",
        method="PATCH",
        body=json.dumps(patch).encode("utf-8"),
        headers=auth_headers("application/json-patch+json"),
    )
    print(
        json.dumps(
            {
                "workItemId": args.work_item_id,
                "pullRequestId": args.pull_request_id,
                "repositoryId": repository_id,
                "projectId": project_id,
                "linked": True,
                "rev": payload.get("rev"),
            },
            indent=2,
        )
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    parse_url = subparsers.add_parser("parse-url")
    parse_url.add_argument("url")
    wiql = subparsers.add_parser("wiql")
    wiql.add_argument("--assigned-to", default="")
    wiql.add_argument("--current", action="store_true")
    wiql.add_argument("--state", action="append", default=[])
    wiql.add_argument("--exclude-state", action="append", default=[])
    wiql.add_argument("--type", action="append", default=[])
    wiql.add_argument("--fields", default="")
    wiql.add_argument("--extra-clause", action="append", default=[])
    search = subparsers.add_parser("search")
    search.add_argument("--org", required=True)
    search.add_argument("--text", required=True)
    search.add_argument("--type", action="append", default=[])
    search.add_argument("--project", action="append", default=[])
    search.add_argument("--area", action="append", default=[])
    search.add_argument("--top", type=int, default=25)
    required = subparsers.add_parser("required-fields")
    required.add_argument("--org", required=True)
    required.add_argument("--project", required=True)
    required.add_argument("--type", required=True)
    link = subparsers.add_parser("link-pr")
    link.add_argument("--org", required=True)
    link.add_argument("--work-item-id", type=int, required=True)
    link.add_argument("--pull-request-id", type=int, required=True)
    link.add_argument("--project", default="")
    link.add_argument("--repository", default="")
    link.add_argument("--project-id", default="")
    link.add_argument("--repository-id", default="")
    args = parser.parse_args()

    if args.command == "parse-url":
        print(json.dumps(parse_work_item_url(args.url), indent=2))
    elif args.command == "wiql":
        print(json.dumps(build_wiql(args), indent=2))
    elif args.command == "search":
        search_work_items(args)
    elif args.command == "required-fields":
        required_fields(args)
    elif args.command == "link-pr":
        link_pr(args)


if __name__ == "__main__":
    main()
