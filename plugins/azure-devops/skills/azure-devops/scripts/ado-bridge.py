#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# ///
"""JSON stdin/stdout domain bridge. Credentials and content never enter argv.

Oversized immutable items exit 1 with stderr JSON code ``content_too_large``.
The decoded UTF-8 content limit is 2097152 bytes; the response limit is 8388608.
``readItems`` accepts 1-8 immutable path/commit reads in a single scope, returning
ordered text/binary/error results through one transport and credential memo.
Its shared deadline is 60 seconds. The batch contains at most 16 MiB decoded
content and streams at most 96 MiB + 64 KiB of ASCII JSON, including worst-case
escapes. Oversized items are explicit per-item ``content_too_large`` errors;
other errors retain their identity, and deadline expiry fails the whole batch.

ADO_REQUEST_DIAGNOSTICS=1 emits newline-delimited stderr JSON tagged with
type=ado_request_diagnostic. HTTP records contain source=http, method, status,
attempt (one-based), waitMs, durationMs, and retryAfterSeconds (number or null).
HTTP records also contain a fixed routeCategory, rateLimit, rateRemaining,
rateCost, cooldownUntil (nullable finite nonnegative numbers), and cacheHit=false.
Cache hits contain source=cache, routeCategory=items, and cacheHit=true. No targets, credentials,
headers, payloads, or exception text appear in these records. Success stdout
remains one domain JSON value; errors remain separate stderr JSON records.
JSON output uses ASCII escapes, preserving Unicode over UTF-8 or Windows
console-encoded pipes. Input is UTF-8 JSON.

Collections and complete snapshots share a 60-second total deadline, including
nested reads. Expiry exits 1 with code=incomplete_read, never a partial success.
X-RateLimit-Remaining=0 and a valid future X-RateLimit-Reset extend organization
cooldown. X-RateLimit-Delay describes server-imposed latency, not another wait.
"""

from __future__ import annotations

import json
import re
import sys
from typing import Any

from shared.pr import PrClient, Publisher, Scope, positive_id
from shared.transport import AdoError, Deferred, organization

MAX_ITEM_BATCH_SIZE = 8
MAX_ITEM_CONTENT_BYTES = 2 * 1024 * 1024
MAX_ITEM_BATCH_OUTPUT_BYTES = MAX_ITEM_BATCH_SIZE * MAX_ITEM_CONTENT_BYTES * 6 + 64 * 1024


def validate_item_batch(request: dict[str, Any]) -> None:
    if set(request) != {"operation", "org", "project", "repositoryId", "items"}:
        raise AdoError("invalid item batch fields")
    for field, limit in (("org", 2048), ("project", 4096), ("repositoryId", 4096)):
        value = request.get(field)
        if not isinstance(value, str) or not 1 <= len(value) <= limit:
            raise AdoError(f"invalid item batch {field}")
    items = request.get("items")
    if not isinstance(items, list) or not 1 <= len(items) <= MAX_ITEM_BATCH_SIZE:
        raise AdoError("item batch requires 1 to 8 items")
    for item in items:
        if not isinstance(item, dict) or set(item) != {"path", "commit"}:
            raise AdoError("invalid item batch entry")
        path, commit = item["path"], item["commit"]
        if not isinstance(path, str) or not 1 <= len(path) <= 4096:
            raise AdoError("invalid item batch path")
        if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-fA-F]{40}", commit):
            raise AdoError("immutable item requires a full commit SHA")


def read_items(request: dict[str, Any], client: PrClient) -> dict[str, Any]:
    results: list[dict[str, Any]] = []
    with client.transport.budget(client.read_timeout):
        for item in request["items"]:
            client.transport.check_budget()
            try:
                payload = client.read({
                    "resource": "item", "project": request["project"],
                    "repositoryId": request["repositoryId"], **item,
                })
                if not isinstance(payload, dict):
                    raise AdoError("item response must be an object")
                content = payload.get("content")
                if content is None:
                    metadata = payload.get("contentMetadata")
                    if not isinstance(metadata, dict) or metadata.get("isBinary") is not True:
                        raise AdoError("item content is incomplete")
                    result = {"kind": "binary"}
                else:
                    if not isinstance(content, str):
                        raise AdoError("item content must be a string")
                    try:
                        size = len(content.encode("utf-8"))
                    except UnicodeEncodeError as exc:
                        raise AdoError("invalid item content encoding") from exc
                    if size > MAX_ITEM_CONTENT_BYTES:
                        raise AdoError("item content exceeds 2097152 bytes", code="content_too_large")
                    result = {"kind": "text", "content": content}
            except AdoError as exc:
                result = {"kind": "error", "error": str(exc)[:1024]}
                if exc.code:
                    result["code"] = exc.code[:1024]
                if isinstance(exc, Deferred):
                    result.update({"deferred": True, "retryAt": exc.retry_at})
            results.append(result)
    return {"results": results}


def dispatch(request: Any, client: PrClient | None = None) -> Any:
    if not isinstance(request, dict):
        raise AdoError("bridge request must be an object")
    org = request.get("org")
    if not isinstance(org, str):
        raise AdoError("bridge organization is required")
    if request.get("operation") == "readItems":
        validate_item_batch(request)
    client = client or PrClient(org)
    if client.org != organization(org):
        raise AdoError("bridge client organization mismatch")
    operation = request.get("operation")
    if operation == "readItems":
        return read_items(request, client)
    if operation == "read":
        return client.read(request)
    if operation == "snapshot":
        return client.snapshot(request.get("pullRequestId"))
    if operation == "publish":
        findings = request.get("findings")
        if not isinstance(findings, list) or any(not isinstance(item, dict) for item in findings):
            raise AdoError("bridge findings must be an array of objects")
        project, repository = request.get("project"), request.get("repositoryId")
        if not isinstance(project, str) or not project or not isinstance(repository, str) or not repository:
            raise AdoError("publication project and repository are required")
        scope = Scope(client.org, project, repository, positive_id(request.get("pullRequestId")))
        return Publisher(client, scope).publish(findings)
    raise AdoError("unsupported bridge operation")


def main() -> int:
    try:
        raw = sys.stdin.buffer.read(8 * 1024 * 1024 + 1)
        if len(raw) > 8 * 1024 * 1024:
            raise AdoError("bridge request exceeds 8 MiB")
        try:
            request = json.loads(raw)
        except (ValueError, UnicodeDecodeError) as exc:
            raise AdoError("invalid bridge JSON") from exc
        result = dispatch(request)
        if request.get("operation") == "readItems":
            json.dump(result, sys.stdout, ensure_ascii=True, separators=(",", ":"))
            sys.stdout.write("\n")
        else:
            print(json.dumps(result, ensure_ascii=True))
        return 0
    except Deferred as exc:
        print(json.dumps({"error": str(exc), "deferred": True, "retryAt": exc.retry_at}), file=sys.stderr)
        return 2
    except AdoError as exc:
        error: dict[str, Any] = {"error": str(exc)}
        if exc.code:
            error["code"] = exc.code
        print(json.dumps(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
