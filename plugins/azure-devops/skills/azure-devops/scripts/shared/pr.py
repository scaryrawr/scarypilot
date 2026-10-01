from __future__ import annotations

import hashlib
import json
import math
import re
import unicodedata
import urllib.parse
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import wraps
from typing import Any, Callable, Concatenate, ParamSpec, TypeVar

from .ado import AI_ATTRIBUTION, attribute_ai_text
from .transport import AdoError, Transport, WriteRejected, organization, resolve_organization


def object_response(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise AdoError("expected an Azure DevOps object response")
    return value


def identifier(value: Any) -> str:
    if isinstance(value, bool) or not isinstance(value, (str, int)) or not str(value):
        raise AdoError("missing or invalid resource identifier")
    return urllib.parse.quote(str(value), safe="")


def positive_id(value: Any) -> str:
    if isinstance(value, bool) or not str(value).isdigit() or int(value) < 1:
        raise AdoError("expected a positive resource ID")
    return str(int(value))


def revision(details: dict[str, Any]) -> dict[str, Any]:
    return {
        "sourceCommit": object_response(details.get("lastMergeSourceCommit") or {}).get("commitId"),
        "targetCommit": object_response(details.get("lastMergeTargetCommit") or {}).get("commitId"),
        "mergeCommit": object_response(details.get("lastMergeCommit") or {}).get("commitId"),
        "sourceRef": details.get("sourceRefName"),
        "targetRef": details.get("targetRefName"),
        "status": details.get("status"),
        "isDraft": details.get("isDraft", False),
    }


@dataclass(frozen=True)
class Scope:
    org: str
    project: str
    repository: str
    pull_request: str

    @classmethod
    def from_details(cls, org: str, details: dict[str, Any]) -> Scope:
        repository = object_response(details.get("repository"))
        project = object_response(repository.get("project"))
        project_id = project.get("id") or project.get("name")
        repository_id = repository.get("id")
        if not isinstance(project_id, str) or not project_id or not isinstance(repository_id, str) or not repository_id:
            raise AdoError("PR repository or project scope is incomplete")
        return cls(organization(org), project_id, repository_id, positive_id(details.get("pullRequestId")))

    @property
    def base(self) -> str:
        return (f"https://dev.azure.com/{self.org}/{identifier(self.project)}/_apis/git/repositories/"
                f"{identifier(self.repository)}/pullRequests/{self.pull_request}")

    @property
    def lock_key(self) -> str:
        return f"pr:{self.org}:{self.repository.lower()}:{self.pull_request}"


P = ParamSpec("P")
R = TypeVar("R")


def bounded_read(method: Callable[Concatenate["PrClient", P], R]) -> Callable[Concatenate["PrClient", P], R]:
    @wraps(method)
    def bounded(client: PrClient, *args: P.args, **kwargs: P.kwargs) -> R:
        with client.transport.budget(client.read_timeout):
            return method(client, *args, **kwargs)
    return bounded


class PrClient:
    def __init__(self, org: str, transport: Transport | None = None, *, read_timeout: float = 60):
        if not math.isfinite(read_timeout) or read_timeout <= 0:
            raise AdoError("read deadline must be positive and finite")
        self.org = organization(org)
        self.transport = transport or Transport()
        self.read_timeout = read_timeout

    def url(self, project: str, path: str, query: dict[str, Any] | None = None) -> str:
        prefix = f"/{identifier(project)}" if project else ""
        return (f"https://dev.azure.com/{self.org}{prefix}/_apis/{path}?"
                + urllib.parse.urlencode({"api-version": "7.1", **(query or {})}))

    def details(self, pull_request: Any, project: str = "", repository: str = "") -> dict[str, Any]:
        path = (f"git/repositories/{identifier(repository)}/pullRequests/" if repository else "git/pullrequests/")
        payload = object_response(self.transport.json(self.url(project, path + positive_id(pull_request))))
        if positive_id(payload.get("pullRequestId")) != positive_id(pull_request):
            raise AdoError("PR response ID mismatch")
        return payload

    @bounded_read
    def collection(self, url: str) -> dict[str, Any]:
        """Builds use x-ms-continuationtoken. Threads/iterations are
        documented as unpaged collections; consume a token if a service supplies one.
        A full page alone is not evidence of another page for these endpoints.
        """
        entries: list[dict[str, Any]] = []
        seen: set[str] = set()
        for _ in range(1000):
            response = self.transport.request(url)
            try:
                payload = object_response(json.loads(response.body))
            except (ValueError, UnicodeDecodeError) as exc:
                raise AdoError("invalid collection JSON") from exc
            page = payload.get("value")
            if not isinstance(page, list) or any(not isinstance(item, dict) for item in page):
                raise AdoError("incomplete Azure DevOps collection")
            entries.extend(page)
            continuation = response.headers.get("x-ms-continuationtoken")
            if not continuation:
                return {"count": len(entries), "value": entries}
            if continuation in seen:
                raise AdoError("collection continuation repeated")
            seen.add(continuation)
            parsed = urllib.parse.urlsplit(url)
            query = dict(urllib.parse.parse_qsl(parsed.query))
            query["continuationToken"] = continuation
            url = urllib.parse.urlunsplit(parsed._replace(query=urllib.parse.urlencode(query)))
        raise AdoError("collection page limit exceeded")

    def threads(self, scope: Scope) -> dict[str, Any]:
        return self.collection(scope.base + "/threads?api-version=7.1")

    @bounded_read
    def changes(self, scope: Scope, iteration: Any) -> dict[str, Any]:
        """Iteration changes use body nextSkip/nextTop and at most $top=2000."""
        url = scope.base + f"/iterations/{positive_id(iteration)}/changes"
        skip, top = 0, 2000
        seen: set[tuple[int, int]] = set()
        entries: list[dict[str, Any]] = []
        for _ in range(1000):
            payload = object_response(self.transport.json(url + "?" + urllib.parse.urlencode(
                {"api-version": "7.1", "$skip": skip, "$top": top, "$compareTo": 0})))
            page = payload.get("changeEntries")
            if not isinstance(page, list) or any(not isinstance(item, dict) for item in page):
                raise AdoError("incomplete change collection")
            if len(page) >= top and ("nextSkip" not in payload or "nextTop" not in payload):
                raise AdoError("full change page has incomplete continuation")
            entries.extend(page)
            next_skip, next_top = payload.get("nextSkip", 0), payload.get("nextTop", 0)
            if any(isinstance(value, bool) or not isinstance(value, int) or value < 0 for value in (next_skip, next_top)):
                raise AdoError("invalid change continuation")
            if next_skip == 0 and next_top == 0:
                return {"changeEntries": entries, "nextSkip": 0, "nextTop": 0}
            if next_skip <= skip or next_top == 0 or (next_skip, next_top) in seen:
                raise AdoError("change continuation did not advance")
            seen.add((next_skip, next_top))
            skip, top = next_skip, min(next_top, 2000)
        raise AdoError("change page limit exceeded")

    @bounded_read
    def policies(self, scope: Scope) -> list[dict[str, Any]]:
        """Policy Evaluations List uses $top/$skip, not continuation headers.
        A full page must be followed even when no continuation header is present.
        """
        artifact = f"vstfs:///CodeReview/CodeReviewId/{scope.project}/{scope.pull_request}"
        entries: list[dict[str, Any]] = []
        seen: set[str] = set()
        skip, top = 0, 100
        for _ in range(1000):
            payload = object_response(self.transport.json(self.url(scope.project, "policy/evaluations", {
                "api-version": "7.1-preview.1", "artifactId": artifact, "$top": top, "$skip": skip,
            })))
            page = payload.get("value")
            if not isinstance(page, list) or any(not isinstance(policy, dict) or
                not isinstance(policy.get("status"), str) or not policy["status"] for policy in page):
                raise AdoError("snapshot policy data is incomplete")
            if page:
                fingerprint = hashlib.sha256(json.dumps(page, sort_keys=True).encode()).hexdigest()
                if fingerprint in seen:
                    raise AdoError("policy offset page repeated")
                seen.add(fingerprint)
            entries.extend(page)
            if len(page) < top:
                return entries
            skip += len(page)
        raise AdoError("policy page limit exceeded")

    @bounded_read
    def builds(self, scope: Scope, details: dict[str, Any], top: int = 100) -> dict[str, Any]:
        commit = revision(details)["mergeCommit"]
        if not commit:
            raise AdoError("active PR has no current merge commit")
        merge_ref = f"refs/pull/{scope.pull_request}/merge"
        payload = self.collection(self.url(scope.project, "build/builds", {
            "branchName": merge_ref, "repositoryId": scope.repository, "repositoryType": "TfsGit",
            "queryOrder": "queueTimeDescending", "$top": top,
        }))
        fields = ("id", "buildNumber", "status", "result", "sourceBranch", "sourceVersion",
                  "queueTime", "startTime", "finishTime")
        builds = []
        for build in payload["value"]:
            if not isinstance(build.get("sourceVersion"), str) or not build["sourceVersion"]:
                raise AdoError("build source revision is incomplete")
            if build.get("sourceVersion") != commit:
                continue
            positive_id(build.get("id"))
            if build.get("status") not in ("none", "inProgress", "completed", "cancelling", "postponed", "notStarted"):
                raise AdoError("build status is incomplete")
            if build["status"] == "completed" and build.get("result") not in ("succeeded", "partiallySucceeded", "failed", "canceled"):
                raise AdoError("completed build result is incomplete")
            entry = {key: build.get(key) for key in fields}
            entry.update({
                "definitionId": (build.get("definition") or {}).get("id"),
                "definitionName": (build.get("definition") or {}).get("name"),
                "url": ((build.get("_links") or {}).get("web") or {}).get("href") or build.get("url"),
            })
            builds.append(entry)
        failed = [item for item in builds if item["result"] in {"failed", "partiallySucceeded", "canceled"}]
        pending = [item for item in builds if item["status"] != "completed"]
        return {
            "pullRequestId": int(scope.pull_request), "mergeRef": merge_ref, "mergeCommitId": commit,
            "hasFailures": bool(failed), "hasPending": bool(pending), "failed": failed, "pending": pending,
            "succeeded": [item for item in builds if item["result"] == "succeeded"], "builds": builds,
        }

    @bounded_read
    def snapshot(self, pull_request: Any) -> dict[str, Any]:
        details = self.details(pull_request)
        expected = revision(details)
        terminal = details.get("status") in ("completed", "abandoned")
        if not terminal and not isinstance(details.get("isDraft"), bool):
            raise AdoError("active PR draft state is incomplete")
        if not terminal and "reviewers" not in details:
            raise AdoError("active PR reviewer collection is incomplete")
        reviewers = details.get("reviewers", [])
        if not isinstance(reviewers, list) or any(not isinstance(reviewer, dict) for reviewer in reviewers):
            raise AdoError("incomplete reviewer collection")
        payload: dict[str, Any] = {
            "details": details, "reviewers": reviewers, "revision": expected,
            "terminal": terminal,
        }
        if terminal:
            payload.update(threads=[], policies=[], builds=None)
        else:
            if details.get("status") != "active":
                raise AdoError("unknown PR status")
            scope = Scope.from_details(self.org, details)
            if not object_response(object_response(details.get("repository")).get("project")).get("id"):
                raise AdoError("snapshot project ID is incomplete")
            if any(not isinstance(expected[key], str) or not expected[key] for key in
                   ("sourceCommit", "targetCommit", "mergeCommit", "sourceRef", "targetRef")):
                raise AdoError("active PR revision is incomplete")
            if not isinstance(expected["isDraft"], bool):
                raise AdoError("PR draft state is incomplete")
            payload["threads"] = self.threads(scope)["value"]
            for thread in payload["threads"]:
                if not thread.get("isDeleted"):
                    if "status" not in thread or not isinstance(thread.get("comments"), list):
                        raise AdoError("snapshot thread data is incomplete")
            payload["policies"] = self.policies(scope)
            payload["builds"] = self.builds(scope, details)
            fence = self.details(scope.pull_request, scope.project, scope.repository)
            if fence.get("status") == "active" and not isinstance(fence.get("isDraft"), bool):
                raise AdoError("active PR draft state is incomplete at snapshot fence")
            if fence.get("status") == "active" and (
                not isinstance(fence.get("reviewers"), list) or
                any(not isinstance(reviewer, dict) for reviewer in fence["reviewers"])
            ):
                raise AdoError("active PR reviewer collection is incomplete at snapshot fence")
            if revision(fence) != expected or (fence.get("repository") or {}).get("id") != scope.repository:
                raise AdoError("PR revision changed during snapshot")
            payload["details"] = fence
            payload["reviewers"] = fence["reviewers"]
        payload["observedAt"] = datetime.fromtimestamp(self.transport.state.clock(), timezone.utc).isoformat()
        return payload

    def read(self, request: dict[str, Any]) -> Any:
        resource = request.get("resource")
        project = request.get("project", "")
        repository = request.get("repositoryId", "")
        if not isinstance(project, str) or not isinstance(repository, str):
            raise AdoError("project and repository must be strings")
        if resource == "pullRequest":
            return self.details(request.get("pullRequestId"), project, repository)
        if resource == "item":
            commit = request.get("commit")
            if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-fA-F]{40}", commit):
                raise AdoError("immutable item requires a full commit SHA")
            path = request.get("path")
            if not isinstance(path, str) or not path:
                raise AdoError("item path is required")
            return self.transport.immutable(self.url(project, f"git/repositories/{identifier(repository)}/items", {
                "path": path, "versionDescriptor.version": commit.lower(),
                "versionDescriptor.versionType": "commit", "includeContent": "true",
                "includeContentMetadata": "true",
            }))
        scope = Scope(self.org, project, repository, positive_id(request.get("pullRequestId")))
        if resource == "threads":
            return self.threads(scope)
        if resource == "iterations":
            return self.collection(scope.base + "/iterations?api-version=7.1")
        if resource == "changes":
            return self.changes(scope, request.get("iterationId"))
        raise AdoError("unsupported read resource")


def cli_client(args: Any) -> PrClient:
    return PrClient(resolve_organization(args.org, args.detect))


def normalized_text(content: str) -> str:
    content = re.sub(r"<!-- paired-review-finding:[a-z0-9-]+ -->", "", content).rstrip()
    content = re.sub(r"(?:^|\r?\n\r?\n)(?:- Generated with AI 🤖|🤖 Generated with AI)$", "", content)
    content = unicodedata.normalize("NFC", content).replace("\r\n", "\n").replace("\r", "\n")
    return "\n".join(line.rstrip(" \t") for line in content.split("\n")).strip()


def anchor(payload: dict[str, Any]) -> Any:
    context = object_response(payload.get("threadContext") or {})
    path = context.get("filePath", "")
    if not isinstance(path, str):
        raise AdoError("invalid thread anchor path")
    path = path.replace("\\", "/").lstrip("/")
    left_start = object_response(context.get("leftFileStart") or {}).get("line")
    right_start = object_response(context.get("rightFileStart") or {}).get("line")
    return (path, left_start, object_response(context.get("leftFileEnd") or {}).get("line", left_start),
            right_start, object_response(context.get("rightFileEnd") or {}).get("line", right_start))


def matching_thread(threads: list[dict[str, Any]], payload: dict[str, Any], finding_id: str, *,
                    reconcile_marker: bool = False) -> dict[str, Any] | None:
    """Legacy matching uses the first nondeleted comment, never a later reply.
    Unknown-write reconciliation may search all nondeleted comments for a marker.
    """
    marker = f"<!-- paired-review-finding:{finding_id} -->"
    for thread in threads:
        if thread.get("isDeleted"):
            continue
        comments = thread.get("comments")
        if not isinstance(comments, list) or any(not isinstance(comment, dict) for comment in comments):
            raise AdoError("incomplete thread comments")
        first: dict[str, Any] | None = None
        for comment in comments:
            if comment.get("isDeleted"):
                continue
            is_first = first is None
            if is_first:
                first = comment
            content = comment.get("content")
            if content is None:
                continue
            if not isinstance(content, str):
                raise AdoError("invalid thread comment content")
            content = content.strip()
            if not content:
                continue
            if ((is_first or reconcile_marker) and marker in content) or (
                is_first and anchor(thread) == anchor(payload) and
                normalized_text(content) == normalized_text(payload["comments"][0]["content"])
            ):
                if not isinstance(thread.get("id"), int) or isinstance(thread["id"], bool):
                    raise AdoError("matching thread ID is missing")
                return thread
    return None


def finding_payload(value: Any, finding_id: str) -> dict[str, Any]:
    payload = object_response(value)
    payload = json.loads(json.dumps(payload))
    comments = payload.get("comments")
    if not isinstance(comments, list) or not comments:
        raise AdoError("finding comments are required")
    status = payload.get("status")
    if isinstance(status, bool) or not isinstance(status, int) or not 1 <= status <= 6:
        raise AdoError("invalid finding status")
    context = object_response(payload.get("threadContext"))
    if not isinstance(context.get("filePath"), str) or not context["filePath"]:
        raise AdoError("finding file anchor is required")
    has_start = False
    for side in ("left", "right"):
        start, end = context.get(side + "FileStart"), context.get(side + "FileEnd")
        if start is None and end is None:
            continue
        if start is None:
            raise AdoError("finding anchor start is required")
        has_start = True
        for position in (start, end if end is not None else start):
            position = object_response(position)
            line, offset = position.get("line"), position.get("offset", 0)
            if any(isinstance(number, bool) or not isinstance(number, int) or number < minimum
                   for number, minimum in ((line, 1), (offset, 0))):
                raise AdoError("invalid finding anchor position")
        if end is not None and end["line"] < start["line"]:
            raise AdoError("finding anchor range is reversed")
    if not has_start:
        raise AdoError("finding line anchor is required")
    tracking = object_response(payload.get("pullRequestThreadContext"))
    iterations = object_response(tracking.get("iterationContext"))
    for field in ("firstComparingIteration", "secondComparingIteration"):
        number = iterations.get(field)
        if number is None and field == "secondComparingIteration":
            continue
        if isinstance(number, bool) or not isinstance(number, int) or number < 0:
            raise AdoError("invalid finding iteration context")
    if "changeTrackingId" in tracking:
        number = tracking["changeTrackingId"]
        if isinstance(number, bool) or not isinstance(number, int) or number < 0:
            raise AdoError("invalid change tracking ID")
    marker = f"<!-- paired-review-finding:{finding_id} -->"
    for comment in comments:
        if not isinstance(comment, dict) or not isinstance(comment.get("content"), str):
            raise AdoError("invalid finding comment")
        parent = comment.get("parentCommentId")
        if (isinstance(parent, bool) or not isinstance(parent, int) or parent < 0
                or isinstance(comment.get("commentType"), bool) or comment.get("commentType") != 1):
            raise AdoError("invalid finding comment metadata")
        content = comment["content"].replace(marker, "").rstrip()
        content = content.removesuffix(AI_ATTRIBUTION).rstrip()
        comment["content"] = attribute_ai_text(content + "\n\n" + marker)
    return payload


class Publisher:
    def __init__(self, client: PrClient, scope: Scope):
        self.client, self.scope = client, scope
        self.state = client.transport.state

    def journal(self, key: str) -> tuple[str, dict[str, Any], Any] | None:
        with self.state.connect() as db:
            row = db.execute("SELECT phase,payload,receipt FROM journal WHERE scope=? AND key=?",
                             (self.scope.lock_key, key)).fetchone()
        return (row[0], json.loads(row[1]), json.loads(row[2])) if row else None

    def save(self, key: str, phase: str, payload: dict[str, Any], receipt: Any = None) -> None:
        with self.state.connect() as db:
            db.execute("INSERT OR REPLACE INTO journal VALUES(?,?,?,?,?)",
                       (self.scope.lock_key, key, phase, json.dumps(payload), json.dumps(receipt)))

    def write(self, path: str, method: str, payload: dict[str, Any], *,
              before_send: Callable[[], None] | None = None) -> dict[str, Any]:
        return object_response(self.client.transport.json(self.scope.base + path + "?api-version=7.1", method,
                              json.dumps(payload).encode(), {"Content-Type": "application/json"},
                              before_send=before_send))

    def reconcile(self, threads: list[dict[str, Any]]) -> None:
        with self.state.connect() as db:
            rows = db.execute("SELECT key,payload FROM journal WHERE scope=? AND phase='unknown'",
                              (self.scope.lock_key,)).fetchall()
        for key, encoded in rows:
            payload = object_response(json.loads(encoded))
            if key.startswith("finding:"):
                found = matching_thread(threads, payload, key.removeprefix("finding:"), reconcile_marker=True)
                if found:
                    self.save(key, "confirmed", payload, found)
            elif key.startswith("reply:"):
                thread = next((item for item in threads if str(item.get("id")) == payload.get("threadId")), None)
                if thread:
                    comments = thread.get("comments")
                    if not isinstance(comments, list) or any(not isinstance(comment, dict) or
                        isinstance(comment.get("id"), bool) or not isinstance(comment.get("id"), int) for comment in comments):
                        raise AdoError("incomplete thread comments")
                    matches = [comment for comment in comments if comment.get("id") not in payload["before"]
                               and comment.get("content") == payload["reply"]["content"] and not comment.get("isDeleted")]
                    if len(matches) == 1:
                        self.save(key, "replied", payload, matches[0])

    def has_unknown(self) -> bool:
        with self.state.connect() as db:
            return db.execute("SELECT 1 FROM journal WHERE scope=? AND phase='unknown' LIMIT 1",
                              (self.scope.lock_key,)).fetchone() is not None

    def publish(self, findings: list[dict[str, Any]]) -> dict[str, Any]:
        prepared = []
        for finding in findings:
            finding_id = finding.get("findingId")
            if not isinstance(finding_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", finding_id):
                raise AdoError("invalid finding ID")
            prepared.append((finding_id, finding_payload(finding.get("payload"), finding_id)))
        results = []
        rejected: WriteRejected | None = None
        with self.state.lock(self.scope.lock_key):
            threads = self.client.threads(self.scope)["value"]
            self.reconcile(threads)
            latest_iteration = None
            for finding_id, payload in prepared:
                key = "finding:" + finding_id
                record = self.journal(key)
                if record and record[0] == "rejected":
                    record = None
                if record and record[1] != payload:
                    results.append({"kind": "failed", "findingId": finding_id, "error": "finding payload changed after journal creation"})
                    continue
                duplicate = matching_thread(threads, payload, finding_id)
                if duplicate is not None:
                    self.save(key, "confirmed", payload, duplicate)
                    results.append({"kind": "duplicate", "findingId": finding_id, "remoteThreadId": duplicate["id"]})
                    continue
                if record:
                    if record[0] == "confirmed":
                        results.append({"kind": "duplicate", "findingId": finding_id, "remoteThreadId": record[2]["id"]})
                    else:
                        results.append({"kind": "failed", "findingId": finding_id, "error": "unknown publication outcome; reconciliation required"})
                    continue
                if self.has_unknown():
                    results.append({"kind": "failed", "findingId": finding_id, "error": "PR has an unknown write outcome; reconciliation required"})
                    continue
                if rejected is not None:
                    results.append({"kind": "failed", "findingId": finding_id, "error": str(rejected)})
                    continue
                if latest_iteration is None:
                    iterations = self.client.collection(self.scope.base + "/iterations?api-version=7.1")["value"]
                    if not iterations:
                        raise AdoError("PR iterations are incomplete; publication blocked")
                    latest_iteration = max(int(positive_id(iteration.get("id"))) for iteration in iterations)
                expected_iteration = payload["pullRequestThreadContext"]["iterationContext"].get("secondComparingIteration")
                if expected_iteration != latest_iteration:
                    results.append({"kind": "failed", "findingId": finding_id,
                                    "error": "finding iteration is not current; reload the PR before publication"})
                    continue
                try:
                    created = self.write("/threads", "POST", payload,
                                         before_send=lambda: self.save(key, "unknown", payload))
                    if not isinstance(created.get("id"), int) or isinstance(created["id"], bool) or created["id"] < 1:
                        raise AdoError("thread response did not include an ID; outcome unknown")
                except WriteRejected as exc:
                    self.save(key, "rejected", payload, {"status": exc.status})
                    rejected = exc
                    results.append({"kind": "failed", "findingId": finding_id, "error": str(exc)})
                    continue
                except AdoError as exc:
                    results.append({"kind": "failed", "findingId": finding_id, "error": str(exc)})
                    continue
                self.save(key, "confirmed", payload, created)
                threads.append({**payload, **created})
                results.append({"kind": "published", "findingId": finding_id, "remoteThreadId": created["id"]})
        return {"results": results}

    def reply_and_resolve(self, thread_id: Any, content: str, status: str, user_authored: bool) -> dict[str, Any]:
        thread_id = positive_id(thread_id)
        statuses = {"fixed": 2, "closed": 4, "wontFix": 3, "byDesign": 5}
        if status not in statuses or not isinstance(content, str) or not content:
            raise AdoError("reply content and resolution status are required")
        content = content if user_authored else attribute_ai_text(content)
        payload = {"content": content, "parentCommentId": 0, "commentType": 1}
        key = "reply:" + hashlib.sha256(json.dumps([thread_id, content]).encode()).hexdigest()
        with self.state.lock(self.scope.lock_key):
            record = self.journal(key)
            if record and record[0] == "rejected":
                record = None
            if record and record[0] == "completed" and record[1].get("status") == status:
                return record[2]
            path = f"/threads/{thread_id}"
            if record is None or record[0] == "unknown":
                thread = object_response(self.client.transport.json(self.scope.base + path + "?api-version=7.1"))
                comments = thread.get("comments")
                if not isinstance(comments, list) or any(not isinstance(comment, dict) or
                    isinstance(comment.get("id"), bool) or not isinstance(comment.get("id"), int) for comment in comments):
                    raise AdoError("incomplete thread comments")
                previous = record[1]["before"] if record else [comment["id"] for comment in comments]
                matches = [comment for comment in comments if comment.get("id") not in previous
                           and comment.get("content") == content and not comment.get("isDeleted")]
                journal_payload = {"reply": payload, "before": previous, "threadId": thread_id, "status": status}
                if record and len(matches) != 1:
                    raise AdoError("unknown reply outcome; reconciliation required")
                if record:
                    reply = matches[0]
                else:
                    if self.has_unknown():
                        raise AdoError("PR has an unknown write outcome; reconciliation required")
                    try:
                        reply = self.write(path + "/comments", "POST", payload,
                                           before_send=lambda: self.save(key, "unknown", journal_payload))
                    except WriteRejected as exc:
                        self.save(key, "rejected", journal_payload, {"status": exc.status})
                        raise
                    if not isinstance(reply.get("id"), int) or isinstance(reply["id"], bool) or reply["id"] < 1:
                        raise AdoError("reply response did not include an ID; outcome unknown")
                self.save(key, "replied", journal_payload, reply)
            else:
                reply = record[2]["reply"] if record[0] == "completed" else record[2]
                journal_payload = {**record[1], "status": status}
                self.save(key, "replied", journal_payload, reply)
            resolved = self.write(path, "PATCH", {"status": status})
            if (positive_id(resolved.get("id")) != thread_id or isinstance(resolved.get("status"), bool)
                    or resolved.get("status") not in (status, statuses[status])):
                raise AdoError("thread resolution response is incomplete; resume PATCH")
            result = {"reply": reply, "thread": resolved}
            self.save(key, "completed", journal_payload, result)
            return result
