#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# ///
"""Parse Azure DevOps URLs and upload PR attachments."""

from __future__ import annotations

import argparse
import json
import sys
import urllib.parse
from typing import Any

from shared.ado import upload_pr_attachment


def parse_azure_devops_url(raw_url: str) -> dict[str, Any]:
    """Parse a supported Azure DevOps URL and identify the internal workflow."""
    parsed = urllib.parse.urlparse(raw_url)
    is_visual_studio = (parsed.hostname or "").endswith(".visualstudio.com")
    is_dev_azure = parsed.hostname == "dev.azure.com"
    if not is_dev_azure and not is_visual_studio:
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

    project = segments[0] if segments else None
    resource_section = segments[1] if len(segments) > 1 else None
    result: dict[str, Any] = {
        "url": raw_url,
        "host": parsed.hostname,
        "organization": organization,
        "organizationUrl": f"https://dev.azure.com/{organization}",
        "project": project,
        "resourceType": "unknown",
        "routeSkill": "unknown",
        "isVisualStudioHost": is_visual_studio,
    }

    if resource_section == "_git":
        repository_index = 3 if len(segments) > 2 and segments[2] == "_optimized" else 2
        if len(segments) <= repository_index:
            return result
        repository = segments[repository_index]
        next_segment = segments[repository_index + 1] if len(segments) > repository_index + 1 else None
        if next_segment == "pullrequest":
            try:
                pull_request_id = int(segments[repository_index + 2])
            except (IndexError, ValueError):
                sys.exit(f"error: could not determine pull request id from {raw_url}")
            result.update(
                {
                    "repository": repository,
                    "resourceType": "pull-request",
                    "resourceId": pull_request_id,
                    "pullRequestId": pull_request_id,
                    "routeSkill": "pull-request",
                }
            )
            return result

    if resource_section == "_workitems" and len(segments) > 3 and segments[2] == "edit":
        try:
            work_item_id = int(segments[3])
        except ValueError:
            sys.exit(f"error: could not determine work item id from {raw_url}")
        result.update(
            {
                "resourceType": "work-item",
                "resourceId": work_item_id,
                "workItemId": work_item_id,
                "routeSkill": "work-items",
            }
        )
    return result


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
    parse_url = subparsers.add_parser("parse-url")
    parse_url.add_argument("url")
    upload = subparsers.add_parser("upload-attachment")
    upload.add_argument("--org", required=True)
    upload.add_argument("--project", required=True)
    upload.add_argument("--repository-id", required=True)
    upload.add_argument("--pull-request-id", required=True)
    upload.add_argument("--file", required=True)
    upload.add_argument("--file-name", default="")
    args = parser.parse_args()

    if args.command == "parse-url":
        print(json.dumps(parse_azure_devops_url(args.url), indent=2))
    elif args.command == "upload-attachment":
        upload_attachment(args)


if __name__ == "__main__":
    main()
