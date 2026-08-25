from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


DEVOPS_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798"


def normalize_organization(value: str) -> dict[str, str]:
    """Normalize an Azure DevOps organization name or URL."""
    raw = value.strip().rstrip("/")
    if not raw:
        sys.exit("error: Azure DevOps organization cannot be empty")
    if raw.startswith("http://") or raw.startswith("https://"):
        parsed = urllib.parse.urlparse(raw)
        if parsed.hostname == "dev.azure.com":
            parts = [part for part in parsed.path.split("/") if part]
            if not parts:
                sys.exit(f"error: could not determine organization from {value}")
            org = parts[0]
        elif parsed.hostname and parsed.hostname.endswith(".visualstudio.com"):
            org = parsed.hostname.removesuffix(".visualstudio.com")
        else:
            sys.exit(f"error: unsupported Azure DevOps organization URL: {value}")
    else:
        org = raw
    return {"organization": org, "organizationUrl": f"https://dev.azure.com/{org}"}


def run(command: list[str], cwd: Path | None = None, *, exit_on_error: bool = True) -> str:
    """Run a command and return stdout, preserving stderr context on failure."""
    executable = shutil.which(command[0])
    resolved_command = [executable or command[0], *command[1:]]
    try:
        return subprocess.run(resolved_command, cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()
    except FileNotFoundError:
        sys.exit(f"error: executable not found: {command[0]}")
    except subprocess.CalledProcessError as exc:
        if not exit_on_error:
            raise
        details = (exc.stderr or exc.stdout or str(exc)).strip()
        sys.exit(f"error: {' '.join(command)} failed: {details}")


def run_json(command: list[str]) -> Any:
    """Run an az command and decode JSON output."""
    return json.loads(run([*command, "--output", "json"]))


def token() -> str:
    """Return an Azure DevOps access token from Azure CLI."""
    return run(["az", "account", "get-access-token", "--resource", DEVOPS_RESOURCE, "--query", "accessToken", "-o", "tsv"])


def request_json(url: str, method: str = "GET", body: bytes | None = None, headers: dict[str, str] | None = None) -> Any:
    """Call an Azure DevOps JSON endpoint and return decoded JSON."""
    request = urllib.request.Request(url, data=body, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            payload = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        details = exc.read().decode("utf-8", errors="replace")
        sys.exit(f"error: request failed ({exc.code}): {details}")
    return json.loads(payload) if payload else {}


def scope_args(args: argparse.Namespace) -> list[str]:
    """Return az scope arguments from --org or --detect."""
    if args.org:
        return ["--org", normalize_organization(args.org)["organizationUrl"]]
    return ["--detect", args.detect]


def strip_refs_heads(value: str | None) -> str | None:
    """Strip refs/heads/ from a branch ref."""
    prefix = "refs/heads/"
    return value[len(prefix):] if value and value.startswith(prefix) else value


def parse_line_number(value: int, flag: str) -> int:
    """Validate a positive line number."""
    if value < 1:
        sys.exit(f"error: expected {flag} to be a positive integer")
    return value


def normalize_ado_file_path(file_path: str) -> str:
    """Normalize a repository-relative file path to Azure DevOps slash form."""
    slash_path = file_path.replace("\\", "/")
    if (len(slash_path) > 1 and slash_path[1] == ":") or slash_path.startswith("//"):
        sys.exit("error: --file-path must be repository-relative, not a local absolute path")
    trimmed = "/".join(part for part in slash_path.split("/") if part)
    if not trimmed:
        sys.exit("error: --file-path cannot be empty")
    return f"/{trimmed}"


def resolve_out_file(value: str, prefix: str) -> Path:
    """Resolve the optional thread payload output file."""
    if value != "auto":
        return Path(value)
    directory = Path(tempfile.mkdtemp(prefix=prefix))
    return directory / "thread.json"


def build_thread_payload(args: argparse.Namespace) -> dict[str, Any]:
    """Build an Azure DevOps pull request thread payload."""
    payload: dict[str, Any] = {
        "comments": [{"parentCommentId": 0, "content": args.content, "commentType": "text"}],
        "status": args.status,
    }
    if args.file_path:
        if args.line_start is None:
            sys.exit("error: file-specific thread payloads require --line-start")
        line_start = parse_line_number(args.line_start, "--line-start")
        line_end = parse_line_number(args.line_end or line_start, "--line-end")
        if line_end < line_start:
            sys.exit("error: --line-end must be greater than or equal to --line-start")
        payload["threadContext"] = {
            "filePath": normalize_ado_file_path(args.file_path),
            "rightFileStart": {"line": line_start, "offset": 0},
            "rightFileEnd": {"line": line_end, "offset": 0},
        }
    return payload


def upload_pr_attachment(
    *,
    org: str,
    project: str,
    repository_id: str,
    pull_request_id: str,
    file: str,
    file_name: str = "",
) -> dict[str, Any]:
    """Upload a pull request attachment with the Azure DevOps REST API."""
    organization = normalize_organization(org)["organization"]
    file_path = Path(file)
    if not file_path.is_file():
        sys.exit(f"error: {file_path} is not a regular file")
    resolved_file_name = file_name or file_path.name
    project_quoted = urllib.parse.quote(project, safe="")
    file_name_quoted = urllib.parse.quote(resolved_file_name, safe="")
    url = (
        f"https://dev.azure.com/{organization}/{project_quoted}/_apis/git/repositories/"
        f"{repository_id}/pullRequests/{pull_request_id}/attachments/{file_name_quoted}"
        "?api-version=7.1"
    )
    payload = request_json(
        url,
        method="POST",
        body=file_path.read_bytes(),
        headers={"Authorization": f"Bearer {token()}", "Content-Type": "application/octet-stream"},
    )
    return {"fileName": resolved_file_name, "filePath": str(file_path), "id": payload.get("id"), "url": payload.get("url")}
