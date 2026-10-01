#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# ///
"""JSON stdin/stdout domain bridge. Credentials and content never enter argv.

Oversized immutable items exit 1 with stderr JSON code ``content_too_large``.
The decoded UTF-8 content limit is 2097152 bytes; the response limit is 8388608.

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
import sys
from typing import Any

from shared.pr import PrClient, Publisher, Scope, positive_id
from shared.transport import AdoError, Deferred, organization


def dispatch(request: Any, client: PrClient | None = None) -> Any:
    if not isinstance(request, dict):
        raise AdoError("bridge request must be an object")
    org = request.get("org")
    if not isinstance(org, str):
        raise AdoError("bridge organization is required")
    client = client or PrClient(org)
    if client.org != organization(org):
        raise AdoError("bridge client organization mismatch")
    operation = request.get("operation")
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
        print(json.dumps(dispatch(request), ensure_ascii=True))
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
