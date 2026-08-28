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

from shared.ado import parse_azure_devops_https_url, upload_pr_attachment


def parse_azure_devops_url(raw_url: str) -> dict[str, Any]:
    """Parse a supported Azure DevOps URL and identify the internal workflow."""
    parsed = urllib.parse.urlparse(raw_url)
    url_parts = parse_azure_devops_https_url(raw_url)
    if not url_parts:
        sys.exit(f"error: unsupported Azure DevOps host: {parsed.hostname}")

    resource_section = url_parts["resourceSection"]
    resource_segments = url_parts["resourceSegments"]
    result: dict[str, Any] = {
        "url": raw_url,
        "host": url_parts["host"],
        "organization": url_parts["organization"],
        "organizationUrl": url_parts["organizationUrl"],
        "project": url_parts["project"],
        "resourceType": "unknown",
        "routeSkill": "unknown",
        "isVisualStudioHost": url_parts["isVisualStudioHost"],
    }

    if resource_section == "_git":
        repository_index = 1 if resource_segments[:1] == ["_optimized"] else 0
        if len(resource_segments) <= repository_index:
            return result
        repository = resource_segments[repository_index]
        next_segment = resource_segments[repository_index + 1] if len(resource_segments) > repository_index + 1 else None
        if next_segment == "pullrequest":
            try:
                pull_request_id = int(resource_segments[repository_index + 2])
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

    if resource_section == "_workitems" and len(resource_segments) > 1 and resource_segments[0] == "edit":
        try:
            work_item_id = int(resource_segments[1])
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
