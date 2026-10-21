from __future__ import annotations

import argparse
import html
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .transport import AdoError, Transport, azure_cli_invocation, organization


DEVOPS_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798"
AI_ATTRIBUTION = "- Generated with AI 🤖"


def attribute_ai_text(content: str) -> str:
    """Add a single visible attribution to agent-authored text."""
    body = content.rstrip()
    if not body:
        return ""
    if body.endswith(AI_ATTRIBUTION):
        return body
    if body.endswith("🤖 Generated with AI"):
        body = body.removesuffix("🤖 Generated with AI").rstrip()
    return f"{body}\n\n{AI_ATTRIBUTION}" if body else AI_ATTRIBUTION


def parse_azure_devops_https_url(value: str) -> dict[str, Any] | None:
    """Split an Azure DevOps HTTPS URL into organization, project, and resource parts."""
    parsed = urllib.parse.urlparse(value)
    hostname = parsed.hostname or ""
    is_dev_azure = hostname == "dev.azure.com"
    is_visual_studio = hostname.endswith(".visualstudio.com")
    if parsed.scheme != "https" or not (is_dev_azure or is_visual_studio):
        return None

    segments = [urllib.parse.unquote(part) for part in parsed.path.split("/") if part]
    if is_dev_azure:
        if not segments:
            return None
        organization, segments = segments[0], segments[1:]
    else:
        organization = hostname.removesuffix(".visualstudio.com")
        if segments[:1] == ["DefaultCollection"]:
            segments = segments[1:]

    project = None if segments[:1] == ["_git"] else (segments[0] if segments else None)
    resource_index = 0 if project is None else 1
    return {
        "host": hostname,
        "organization": organization,
        "organizationUrl": f"https://dev.azure.com/{organization}",
        "project": project,
        "resourceSection": segments[resource_index] if len(segments) > resource_index else None,
        "resourceSegments": segments[resource_index + 1 :],
        "isVisualStudioHost": is_visual_studio,
    }


def normalize_organization(value: str) -> dict[str, str]:
    """Normalize an Azure DevOps organization name or URL."""
    try:
        org = organization(value)
    except AdoError as exc:
        sys.exit(f"error: {exc}")
    return {"organization": org, "organizationUrl": f"https://dev.azure.com/{org}"}


def run(command: list[str], cwd: Path | None = None, *, exit_on_error: bool = True) -> str:
    """Run a command and return stdout, preserving stderr context on failure."""
    executable = shutil.which(command[0])
    resolved_command = azure_cli_invocation(command) if command[0] == "az" else [executable or command[0], *command[1:]]
    try:
        return subprocess.run(
            resolved_command, cwd=cwd, check=True, capture_output=True, encoding="utf-8",
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        ).stdout.strip()
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


def request_json(url: str, method: str = "GET", body: bytes | None = None,
                 headers: dict[str, str] | None = None, *, replay_safe: bool = False) -> Any:
    """All direct REST callers share organization admission and cooldown."""
    return Transport().json(url, method, body, headers, replay_safe=replay_safe)


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
    content = args.content if args.user_authored else attribute_ai_text(args.content)
    payload: dict[str, Any] = {
        "comments": [{"parentCommentId": 0, "content": content, "commentType": "text"}],
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
    pr_page_url: str | None = None,
) -> dict[str, Any]:
    """Upload an attachment, optionally formatting video for a project-scoped PR description."""
    file_path = Path(file)
    resolved_file_name = file_name or file_path.name
    relative_video = pr_page_url is not None and is_video_attachment(resolved_file_name)
    normalized_org = organization(org) if relative_video else normalize_organization(org)["organization"]
    if not file_path.is_file():
        sys.exit(f"error: {file_path} is not a regular file")
    context = None
    if relative_video:
        validate_attachment_filename(resolved_file_name)
        context = verified_pr_context(
            org=org, project=project, repository_id=repository_id,
            pull_request_id=pull_request_id, pr_page_url=pr_page_url,
        )
    project_quoted = urllib.parse.quote(context.project_id if context is not None else project, safe="")
    repository_quoted = urllib.parse.quote(context.repository_id if context is not None else repository_id, safe="")
    file_name_quoted = urllib.parse.quote(resolved_file_name, safe="")
    url = (
        f"https://dev.azure.com/{normalized_org}/{project_quoted}/_apis/git/repositories/"
        f"{repository_quoted}/pullRequests/{pull_request_id}/attachments/{file_name_quoted}"
        "?api-version=7.1"
    )
    payload = request_json(
        url,
        method="POST",
        body=file_path.read_bytes(),
        headers={"Content-Type": "application/octet-stream"},
    )
    if context is not None and not isinstance(payload, dict):
        raise AdoError("expected an attachment upload object response")
    attachment_url = payload.get("url")
    if not isinstance(attachment_url, str) or not attachment_url:
        if context is not None:
            raise AdoError("attachment upload response did not include a URL")
        sys.exit("error: attachment upload response did not include a URL")
    return {
        "fileName": resolved_file_name,
        "filePath": str(file_path),
        "id": payload.get("id"),
        "url": attachment_url,
        "markdown": attachment_markdown(resolved_file_name, attachment_url, context=context),
    }


_GUID = re.compile(r"[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}")
PR_PAGE_URL_CONTRACT = (
    "project-relative video markup is for PR descriptions, not comments; "
    "expected an exact HTTPS PR page URL at dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id} "
    "or {org}.visualstudio.com/DefaultCollection/{project}/_git/{repo}/pullrequest/{id}; "
    "no query, fragment, trailing slash, deeper path, userinfo, unsafe encoding, or port other than 443"
)


def _attachment_url_parts(url: str, org: str, *, legacy: bool = False) -> list[str]:
    if not isinstance(url, str) or any(ord(char) < 33 or ord(char) == 127 for char in url) or "\\" in url:
        raise AdoError("unsafe attachment context URL")
    try:
        parsed = urllib.parse.urlsplit(url)
        port = parsed.port
    except ValueError as exc:
        raise AdoError("malformed attachment context URL") from exc
    if (parsed.scheme != "https" or parsed.username is not None or parsed.password is not None
            or port not in (None, 443) or "?" in url or "#" in url):
        raise AdoError("attachment context URLs require HTTPS, no userinfo, query or fragment, and only port 443")
    if parsed.netloc.lower() not in {
        "dev.azure.com", "dev.azure.com:443",
        *({f"{org}.visualstudio.com", f"{org}.visualstudio.com:443"} if legacy else set()),
    }:
        raise AdoError("attachment context URL host does not match the canonical organization")
    raw_parts = parsed.path.split("/")
    if raw_parts[0] != "" or any(not part for part in raw_parts[1:]):
        raise AdoError("attachment context URL requires an exact path without a trailing slash")
    parts = []
    for part in raw_parts[1:]:
        if re.search(r"%(?![0-9a-fA-F]{2})", part):
            raise AdoError("malformed URL encoding")
        try:
            decoded = urllib.parse.unquote(part, errors="strict")
        except UnicodeDecodeError as exc:
            raise AdoError("malformed URL encoding") from exc
        if (decoded in {".", ".."} or "/" in decoded or "\\" in decoded
                or any(ord(char) < 32 or ord(char) == 127 for char in decoded)):
            raise AdoError("unsafe attachment context URL path")
        probe = decoded
        for _ in range(4):
            expanded = urllib.parse.unquote(probe)
            if expanded == probe:
                break
            probe = expanded
            if (probe in {".", ".."} or "/" in probe or "\\" in probe
                    or any(ord(char) < 32 or ord(char) == 127 for char in probe)):
                raise AdoError("unsafe nested attachment context URL encoding")
        else:
            raise AdoError("attachment context URL encoding is too deeply nested")
        parts.append(decoded)
    if parsed.hostname == "dev.azure.com":
        if not parts or parts[0].casefold() != org:
            raise AdoError("attachment context URL organization mismatch")
    else:
        if not parts or parts[0] != "DefaultCollection":
            raise AdoError("legacy PR pages require DefaultCollection")
    return parts


def validate_attachment_filename(file_name: str) -> None:
    if (not isinstance(file_name, str) or not file_name or file_name in {".", ".."}
            or "/" in file_name or "\\" in file_name
            or any(ord(char) < 32 or ord(char) == 127 for char in file_name)):
        raise AdoError("expected a single attachment filename without separators or control characters")


def is_video_attachment(file_name: str) -> bool:
    mime_type, encoding = mimetypes.guess_type(file_name)
    return encoding is None and mime_type is not None and mime_type.startswith("video/")


@dataclass(frozen=True)
class VerifiedPrContext:
    org: str
    project_id: str
    project_name: str
    repository_id: str
    repository_name: str
    pull_request_id: str
    pr_page_url: str

    def attachment_source(self, file_name: str, url: str) -> str:
        validate_attachment_filename(file_name)
        parts = _attachment_url_parts(url, self.org)
        if (len(parts) != 10 or parts[1].casefold() not in {self.project_id.casefold(), self.project_name.casefold()}
                or parts[2:5] != ["_apis", "git", "repositories"]
                or parts[5].casefold() != self.repository_id.casefold()
                or parts[6:9] != ["pullRequests", self.pull_request_id, "attachments"]
                or parts[9] != file_name):
            raise AdoError("attachment URL does not match the authenticated PR identity and exact filename")
        return (
            f"../../../_apis/git/repositories/{self.repository_id}/pullRequests/"
            f"{self.pull_request_id}/attachments/{urllib.parse.quote(file_name, safe='')}"
        )


def verified_pr_context(
    *, org: str, project: str, repository_id: str, pull_request_id: str, pr_page_url: str,
) -> VerifiedPrContext:
    from .pr import identifier, object_response

    normalized_org = organization(org)
    pr_id = str(pull_request_id)
    if not re.fullmatch(r"[1-9][0-9]*", pr_id):
        raise AdoError("expected a positive decimal PR ID without leading zeros")
    try:
        parts = _attachment_url_parts(pr_page_url, normalized_org, legacy=True)
        if (len(parts) != 6 or parts[2] != "_git" or parts[4].lower() != "pullrequest"
                or not re.fullmatch(r"[1-9][0-9]*", parts[5]) or parts[5] != pr_id):
            raise AdoError("PR page route or ID mismatch")
    except AdoError as exc:
        raise AdoError(f"{PR_PAGE_URL_CONTRACT}: {exc}") from exc
    target = (
        f"https://dev.azure.com/{normalized_org}/{identifier(project)}/_apis/git/repositories/"
        f"{identifier(repository_id)}/pullRequests/{pr_id}?api-version=7.1"
    )
    details = object_response(request_json(target))
    repository = object_response(details.get("repository"))
    authenticated_project = object_response(repository.get("project"))
    project_guid, project_name = authenticated_project.get("id"), authenticated_project.get("name")
    repo_guid, repo_name = repository.get("id"), repository.get("name")
    if (not isinstance(project_guid, str) or not _GUID.fullmatch(project_guid)
            or not isinstance(repo_guid, str) or not _GUID.fullmatch(repo_guid)
            or not isinstance(project_name, str) or not project_name
            or not isinstance(repo_name, str) or not repo_name):
        raise AdoError("authenticated PR requires project GUID/name and repository GUID/name")
    if (str(details.get("pullRequestId")) != pr_id
            or project.casefold() not in {project_guid.casefold(), project_name.casefold()}
            or parts[1].casefold() not in {project_guid.casefold(), project_name.casefold()}
            or repository_id.casefold() not in {repo_guid.casefold(), repo_name.casefold()}
            or parts[3].casefold() not in {repo_guid.casefold(), repo_name.casefold()}):
        raise AdoError("arguments or PR page do not match the authenticated PR identity")
    return VerifiedPrContext(
        normalized_org, project_guid, project_name, repo_guid, repo_name, pr_id, pr_page_url,
    )


def video_markdown(
    *, org: str, project: str, repository_id: str, pull_request_id: str,
    pr_page_url: str, file_name: str, url: str,
) -> dict[str, str]:
    """Read authenticated PR metadata and format video for a project-scoped PR description, not comments."""
    validate_attachment_filename(file_name)
    if not is_video_attachment(file_name):
        raise AdoError("video-markdown requires a video filename; use attachment_markdown for other content")
    context = verified_pr_context(
        org=org, project=project, repository_id=repository_id,
        pull_request_id=pull_request_id, pr_page_url=pr_page_url,
    )
    return {"url": url, "markdown": attachment_markdown(file_name, url, context=context)}


def attachment_markdown(file_name: str, url: str, *, context: VerifiedPrContext | None = None) -> str:
    """Format uploaded media inline and other attachments as download links."""
    mime_type, encoding = mimetypes.guess_type(file_name)
    if mime_type is None and encoding is None and Path(file_name).suffix.lower() == ".webp":
        mime_type = "image/webp"
    if encoding is None and mime_type and mime_type.startswith("video/"):
        if context is not None:
            url = context.attachment_source(file_name, url)
        return f'<video src="{html.escape(url, quote=True)}" controls width="800"></video>'
    label = " ".join(file_name.splitlines())
    for character in ("\\", "[", "]", "<", ">"):
        label = label.replace(character, f"\\{character}")
    destination = urllib.parse.quote(url, safe=":/?#[]@!$&'*+,;=%")
    prefix = "!" if encoding is None and mime_type and mime_type.startswith("image/") else ""
    return f"{prefix}[{label}]({destination})"
