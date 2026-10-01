from __future__ import annotations

import argparse
import importlib.util
import json
import multiprocessing
import os
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
from email.utils import format_datetime
from io import StringIO
from pathlib import Path
from unittest.mock import MagicMock, patch
from urllib.parse import parse_qs, urlsplit

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))

from shared import ado
from shared.pr import PrClient, Publisher, Scope
from shared.transport import AdoError, Deferred, NoRedirect, Response, State, Transport, WriteRejected, authorization, resolve_organization


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), SCRIPTS / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bridge = load("ado-bridge.py")
pr_script = load("ado-pr.py")
make_pr = load("make-pr.py")
review_pr = load("review-pr.py")
work_items = load("ado-work-items.py")
ORG = "https://dev.azure.com/example"
SCOPE = Scope("example", "project", "repo", "42")
DETAILS = {
    "pullRequestId": 42, "status": "active", "title": "A change", "isDraft": False,
    "repository": {"id": "repo", "name": "Repo", "project": {"id": "project", "name": "Project"}},
    "lastMergeSourceCommit": {"commitId": "source"}, "lastMergeTargetCommit": {"commitId": "target"},
    "lastMergeCommit": {"commitId": "merge"}, "sourceRefName": "refs/heads/feature", "targetRefName": "refs/heads/main",
    "reviewers": [{"id": "reviewer", "vote": 10}],
}
FINDING = {
    "findingId": "finding-1",
    "payload": {
        "comments": [{"parentCommentId": 0, "content": "**Bug**\n\nFix it.\n\n- Generated with AI 🤖\n\n<!-- paired-review-finding:finding-1 -->", "commentType": 1}],
        "status": 1, "threadContext": {"filePath": "/a.py", "rightFileStart": {"line": 2, "offset": 0},
                                     "rightFileEnd": {"line": 3, "offset": 0}},
        "pullRequestThreadContext": {"changeTrackingId": 1, "iterationContext": {"firstComparingIteration": 1, "secondComparingIteration": 2}},
    },
}


def response(value, status=200, headers=None):
    return Response(status, headers or {}, json.dumps(value).encode())


class Clock:
    def __init__(self):
        self.now = 1000.0
        self.sleeps = []

    def __call__(self):
        return self.now

    def sleep(self, duration):
        self.sleeps.append(duration)
        self.now += duration


class Http:
    def __init__(self, *outcomes):
        self.outcomes = list(outcomes)
        self.calls = []

    def __call__(self, url, method, body, headers):
        self.calls.append((url, method, json.loads(body) if body else None, headers))
        if not self.outcomes:
            raise AssertionError("unexpected external request")
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


def hold_gate(directory, ready, release):
    state = State(Path(directory), clock=lambda: 1000.0)
    with state.admit("example", 1010):
        ready.put(os.getpid())
        deadline = time.monotonic() + 15
        while not (Path(directory) / "release").exists() and time.monotonic() < deadline:
            time.sleep(0.01)


def hold_writer(directory, ready, release):
    with State(Path(directory)).lock(SCOPE.lock_key):
        ready.put(os.getpid())
        deadline = time.monotonic() + 15
        while not (Path(directory) / "release").exists() and time.monotonic() < deadline:
            time.sleep(0.01)


def cache_worker(directory, ready, start, result, auth="Basic principal-a"):
    state = State(Path(directory))

    def send(url, method, body, headers):
        with state.connect() as db:
            db.execute("INSERT INTO requests VALUES('GET')")
        time.sleep(0.1)
        return response({"content": "immutable"})

    client = PrClient("example", Transport(state, auth=lambda: auth, send=send))
    ready.put(True)
    start.wait(10)
    result.put(bridge.dispatch({"operation": "read", "org": ORG, "project": "project",
                              "resource": "item", "repositoryId": "repo", "path": "/a.py", "commit": "a" * 40}, client))


def publish_worker(directory, ready, start, result):
    state = State(Path(directory))

    def send(url, method, body, headers):
        with state.connect() as db:
            db.execute("INSERT INTO requests VALUES(?)", (method,))
            if method == "GET":
                if "/iterations?" in url:
                    return response({"value": [{"id": 2}]})
                entries = [json.loads(row[0]) for row in db.execute("SELECT payload FROM remote_threads")]
                return response({"value": entries})
            payload = json.loads(body)
            payload["id"] = 99
            db.execute("INSERT INTO remote_threads VALUES(?)", (json.dumps(payload),))
            return response(payload)

    client = PrClient("example", Transport(state, auth=lambda: "Basic test", send=send))
    ready.put(True)
    start.wait(10)
    result.put(bridge.dispatch({"operation": "publish", "org": ORG, "project": "project",
                              "repositoryId": "repo", "pullRequestId": 42, "findings": [FINDING]}, client))


def accepted_post_crash(directory):
    state = State(Path(directory))

    def send(url, method, body, headers):
        if method == "GET":
            return response({"value": [{"id": 2}] if "/iterations?" in url else []})
        payload = {**json.loads(body), "id": 101}
        with state.connect() as db:
            db.execute("INSERT INTO remote_threads VALUES(?)", (json.dumps(payload),))
            db.execute("INSERT INTO requests VALUES('POST')")
        os._exit(19)

    client = PrClient("example", Transport(state, auth=lambda: "Basic test", send=send))
    bridge.dispatch({"operation": "publish", "org": ORG, "project": "project",
                     "repositoryId": "repo", "pullRequestId": 42, "findings": [FINDING]}, client)


def cooldown_worker(directory, result):
    http = Http(response({"value": []}))
    clock = Clock()
    state = State(Path(directory), clock=clock, sleep=clock.sleep)
    client = PrClient("https://EXAMPLE.visualstudio.com/DefaultCollection", Transport(state, auth=lambda: "Basic other", send=http))
    try:
        bridge.dispatch({"operation": "read", "org": ORG, "project": "project", "repositoryId": "repo",
                         "pullRequestId": 42, "resource": "threads"}, client)
        result.put(("ok", len(http.calls), clock.sleeps))
    except Deferred as exc:
        result.put(("deferred", len(http.calls), exc.retry_at))


class BackendTests(unittest.TestCase):
    def setUp(self):
        diagnostics = patch.dict(os.environ, {"ADO_REQUEST_DIAGNOSTICS": ""})
        diagnostics.start()
        self.addCleanup(diagnostics.stop)
        self.directory = tempfile.TemporaryDirectory(dir=Path.cwd())
        self.addCleanup(self.directory.cleanup)
        self.clock = Clock()
        self.state = State(Path(self.directory.name), clock=self.clock, sleep=self.clock.sleep)

    def client(self, http, auth="Basic principal-a"):
        return PrClient("example", Transport(self.state, auth=lambda: auth, send=http, jitter=lambda: 0))

    def read_threads(self, client):
        return bridge.dispatch({"operation": "read", "org": ORG, "project": "project", "repositoryId": "repo",
                                "pullRequestId": 42, "resource": "threads"}, client)

    def publish(self, client, findings=None):
        return bridge.dispatch({"operation": "publish", "org": ORG, "project": "project", "repositoryId": "repo",
                                "pullRequestId": 42, "findings": findings or [FINDING]}, client)

    def test_malformed_credentials_fail_at_caller_boundary_without_dispatch_or_leak(self):
        for control in ("\r", "\n", "\0", "\t", "\x7f"):
            with self.subTest(control=repr(control)):
                secret = f"Bearer private-token{control}injected-value"
                http = Http()
                client = self.client(http, secret)
                with self.assertRaises(AdoError) as failure:
                    self.read_threads(client)
                self.assertEqual(str(failure.exception), "invalid request headers")
                self.assertNotIn("private-token", str(failure.exception))
                self.assertEqual(http.calls, [])
                journal = []
                with self.assertRaises(AdoError):
                    client.transport.request(ORG + "/_apis/example", "POST", before_send=lambda: journal.append("unknown"))
                self.assertEqual(journal, [])

    def test_retry_after_on_success_is_shared_across_aliases_and_principals(self):
        http = Http(response({"value": []}, headers={"retry-after": "5"}), response({"value": [{"id": 1}]}))
        self.assertEqual(self.read_threads(self.client(http)), {"count": 0, "value": []})
        other = PrClient("https://EXAMPLE.visualstudio.com/DefaultCollection", Transport(self.state, auth=lambda: "Basic b", send=http))
        self.assertEqual(self.read_threads(other)["value"], [{"id": 1}])
        self.assertEqual(self.clock.sleeps, [5])
        self.assertEqual(len(http.calls), 2)
        self.assertTrue(all(call[0].startswith(ORG) for call in http.calls))

    def test_diagnostics_are_opt_in_and_default_stderr_is_empty(self):
        for enabled in ("", "true", "0"):
            with self.subTest(enabled=enabled), patch.dict(os.environ, {"ADO_REQUEST_DIAGNOSTICS": enabled}):
                error = StringIO()
                http = Http(response({"value": []}))
                with redirect_stderr(error):
                    self.read_threads(self.client(http))
                self.assertEqual(error.getvalue(), "")
                self.assertEqual(len(http.calls), 1)

    def test_diagnostics_report_retry_success_throttle_and_admission_without_secrets(self):
        secret = "private-credential-header-payload"
        http = Http(response({"error": secret}, 429, {"retry-after": "3", "private": secret}),
                    response({"value": []}, headers={"retry-after": "2", "private": secret}),
                    response({"value": []}))
        error = StringIO()
        with patch.dict(os.environ, {"ADO_REQUEST_DIAGNOSTICS": "1"}), redirect_stderr(error):
            client = self.client(http, "Basic " + secret)
            self.read_threads(client)
            self.read_threads(client)
        records = [json.loads(line) for line in error.getvalue().splitlines()]
        quota = {"routeCategory": "threads", "rateLimit": None, "rateRemaining": None, "rateCost": None, "cacheHit": False}
        self.assertEqual(records, [
            {"type": "ado_request_diagnostic", "source": "http", "method": "GET", "status": 429,
             "attempt": 1, "waitMs": 0, "durationMs": 0, "retryAfterSeconds": 3.0, "cooldownUntil": 1003.0, **quota},
            {"type": "ado_request_diagnostic", "source": "http", "method": "GET", "status": 200,
             "attempt": 2, "waitMs": 3000, "durationMs": 0, "retryAfterSeconds": 2.0, "cooldownUntil": 1005.0, **quota},
            {"type": "ado_request_diagnostic", "source": "http", "method": "GET", "status": 200,
             "attempt": 1, "waitMs": 2000, "durationMs": 0, "retryAfterSeconds": None, "cooldownUntil": None, **quota},
        ])
        self.assertEqual(len(http.calls), 3)
        self.assertEqual(self.clock.sleeps, [3, 2])
        for forbidden in (secret, ORG, "example", "project", "repo", "/_apis"):
            self.assertNotIn(forbidden, error.getvalue())

    def test_bridge_success_and_error_keep_distinct_diagnostic_json_lines(self):
        from io import BytesIO
        request = {"operation": "read", "org": ORG, "project": "project", "repositoryId": "repo",
                   "pullRequestId": 42, "resource": "threads"}
        for status, expected_exit in ((200, 0), (403, 1)):
            with self.subTest(status=status):
                stdin = type("Input", (), {"buffer": BytesIO(json.dumps(request).encode())})()
                output, error = StringIO(), StringIO()
                http = Http(response({"value": []}, status))
                with patch.dict(os.environ, {"ADO_REQUEST_DIAGNOSTICS": "1"}):
                    client = self.client(http)
                    with patch.object(sys, "stdin", stdin), patch.object(bridge, "PrClient", return_value=client), \
                            redirect_stdout(output), redirect_stderr(error):
                        self.assertEqual(bridge.main(), expected_exit)
                records = [json.loads(line) for line in error.getvalue().splitlines()]
                self.assertEqual(records[0]["type"], "ado_request_diagnostic")
                self.assertEqual(records[0]["status"], status)
                if status == 200:
                    self.assertEqual(json.loads(output.getvalue()), {"count": 0, "value": []})
                    self.assertEqual(len(records), 1)
                else:
                    self.assertEqual(output.getvalue(), "")
                    self.assertEqual(records[1], {"error": "Azure DevOps HTTP 403"})
                    self.assertEqual(len(records), 2)
                self.assertEqual(len(http.calls), 1)

    def test_diagnostic_cache_hit_reports_no_second_http_request_or_content(self):
        request = {"operation": "read", "org": ORG, "project": "project", "resource": "item",
                   "repositoryId": "repo", "path": "/private-path.py", "commit": "a" * 40}
        http = Http(response({"content": "private content"}))
        error = StringIO()
        with patch.dict(os.environ, {"ADO_REQUEST_DIAGNOSTICS": "1"}), redirect_stderr(error):
            client = self.client(http)
            self.assertEqual(bridge.dispatch(request, client), {"content": "private content"})
            self.assertEqual(bridge.dispatch(request, client), {"content": "private content"})
        records = [json.loads(line) for line in error.getvalue().splitlines()]
        self.assertEqual(len(records), 2)
        self.assertEqual(records[0]["source"], "http")
        self.assertEqual(records[1], {"type": "ado_request_diagnostic", "source": "cache", "routeCategory": "items", "cacheHit": True})
        self.assertEqual(len(http.calls), 1)
        for forbidden in ("private content", "/private-path.py", "a" * 40, "principal-a"):
            self.assertNotIn(forbidden, error.getvalue())

    def test_safe_rate_diagnostics_and_zero_remaining_reset_coordinate_aliases(self):
        http = Http(response({"value": []}, headers={
            "x-ratelimit-limit": "200", "x-ratelimit-remaining": "0",
            "x-ratelimit-cost": "1.25", "x-ratelimit-reset": "1007", "x-ratelimit-delay": "99",
        }), response({"value": []}))
        error = StringIO()
        with patch.dict(os.environ, {"ADO_REQUEST_DIAGNOSTICS": "1"}), redirect_stderr(error):
            self.read_threads(self.client(http))
            other = PrClient("https://EXAMPLE.visualstudio.com/DefaultCollection",
                             Transport(self.state, auth=lambda: "Basic other", send=http))
            self.read_threads(other)
        records = [json.loads(line) for line in error.getvalue().splitlines()]
        self.assertEqual(records[0], {
            "type": "ado_request_diagnostic", "source": "http", "method": "GET", "status": 200,
            "attempt": 1, "waitMs": 0, "durationMs": 0, "retryAfterSeconds": None,
            "routeCategory": "threads", "rateLimit": 200.0, "rateRemaining": 0.0,
            "rateCost": 1.25, "cooldownUntil": 1007.0, "cacheHit": False,
        })
        self.assertEqual(records[1]["waitMs"], 7000)
        self.assertEqual(records[1]["cooldownUntil"], None)
        self.assertEqual(self.clock.sleeps, [7])
        self.assertEqual(len(http.calls), 2)
        for forbidden in (ORG, "example", "Basic", "/_apis", "x-ratelimit", "99"):
            self.assertNotIn(forbidden, error.getvalue())

    def test_server_imposed_rate_delay_is_not_an_additional_wait(self):
        http = Http(response({"value": []}, headers={"x-ratelimit-delay": "600"}), response({"value": []}))
        client = self.client(http)
        self.read_threads(client)
        self.read_threads(client)
        self.assertEqual(len(http.calls), 2)
        self.assertEqual(self.clock.sleeps, [])
        self.assertEqual(self.state.cooldown("example"), 0)

    def test_invalid_quota_headers_are_null_diagnostics_not_raw_text_or_cooldown(self):
        http = Http(response({"value": []}, headers={
            "x-ratelimit-limit": "private-header-value", "x-ratelimit-remaining": "nan",
            "x-ratelimit-cost": "-1", "x-ratelimit-reset": "1100",
        }))
        error = StringIO()
        with patch.dict(os.environ, {"ADO_REQUEST_DIAGNOSTICS": "1"}), redirect_stderr(error):
            self.read_threads(self.client(http))
        record = json.loads(error.getvalue())
        self.assertEqual((record["rateLimit"], record["rateRemaining"], record["rateCost"], record["cooldownUntil"]),
                         (None, None, None, None))
        self.assertNotIn("private-header-value", error.getvalue())
        self.assertEqual(self.state.cooldown("example"), 0)

    def test_rate_reset_date_and_retry_after_use_later_valid_cooldown(self):
        for retry_after, expected in (("3", 7), ("9", 9), (None, 7)):
            with self.subTest(retry_after=retry_after):
                headers = {"x-ratelimit-remaining": "0",
                           "x-ratelimit-reset": format_datetime(datetime.fromtimestamp(self.clock.now + 7, timezone.utc), usegmt=True)}
                if retry_after is not None:
                    headers["retry-after"] = retry_after
                http = Http(response({"value": []}, headers=headers), response({"value": []}))
                client = self.client(http)
                self.read_threads(client)
                self.read_threads(client)
                self.assertEqual(self.clock.sleeps[-1], expected)
                self.assertEqual(len(http.calls), 2)

    def test_read_fallback_jitter_is_bounded_and_injectable(self):
        jitter = MagicMock(side_effect=[0.0, 1.0])
        http = Http(response({}, 503), response({}, 503), response({"value": []}))
        client = PrClient("example", Transport(self.state, auth=lambda: "Basic fake", send=http, jitter=jitter))
        self.assertEqual(self.read_threads(client)["value"], [])
        self.assertEqual(jitter.call_count, 2)
        self.assertEqual(self.clock.sleeps, [1, 2.5])
        self.assertEqual(len(http.calls), 3)

    def test_retry_after_is_not_jittered(self):
        http = Http(response({}, 503, {"retry-after": "7"}), response({"value": []}))
        jitter = MagicMock(side_effect=AssertionError("prescribed Retry-After must not be jittered"))
        client = PrClient("example", Transport(self.state, auth=lambda: "Basic fake", send=http, jitter=jitter))
        self.read_threads(client)
        jitter.assert_not_called()
        self.assertEqual(self.clock.sleeps, [7])
        self.assertEqual(len(http.calls), 2)

    def test_collection_total_deadline_returns_explicit_incomplete_not_partial_success(self):
        http = Http(response({"value": [{"id": 1}]}, headers={"x-ms-continuationtoken": "one"}),
                    response({"value": [{"id": 2}]}, headers={"x-ms-continuationtoken": "two"}),
                    response({"value": [{"id": 3}]}))

        def send(*args):
            self.clock.now += 2
            return http(*args)

        client = PrClient("example", Transport(self.state, auth=lambda: "Basic fake", send=send), read_timeout=3)
        with self.assertRaisesRegex(AdoError, "incomplete read") as failure:
            self.read_threads(client)
        self.assertEqual(failure.exception.code, "incomplete_read")
        self.assertEqual(len(http.calls), 2)
        self.assertIsNone(client.transport.deadline.get())
        client.transport.send = Http(response({"value": [{"id": 4}]}))
        self.assertEqual(self.read_threads(client), {"count": 1, "value": [{"id": 4}]})

    def test_complete_pages_inside_total_deadline_are_not_truncated(self):
        http = Http(response({"value": [{"id": 1}]}, headers={"x-ms-continuationtoken": "one"}),
                    response({"value": [{"id": 2}]}, headers={"x-ms-continuationtoken": "two"}),
                    response({"value": [{"id": 3}]}))

        def send(*args):
            self.clock.now += 0.5
            return http(*args)

        client = PrClient("example", Transport(self.state, auth=lambda: "Basic fake", send=send), read_timeout=2)
        self.assertEqual(self.read_threads(client), {"count": 3, "value": [{"id": 1}, {"id": 2}, {"id": 3}]})
        self.assertEqual(len(http.calls), 3)

    def test_snapshot_total_deadline_spans_nested_collections_and_bridge_emits_error(self):
        from io import BytesIO
        http = self.snapshot_http()

        def send(*args):
            self.clock.now += 2
            return http(*args)

        client = PrClient("example", Transport(self.state, auth=lambda: "Basic fake", send=send), read_timeout=5)
        request = {"operation": "snapshot", "org": ORG, "pullRequestId": 42}
        stdin = type("Input", (), {"buffer": BytesIO(json.dumps(request).encode())})()
        output, error = StringIO(), StringIO()
        with patch.object(sys, "stdin", stdin), patch.object(bridge, "PrClient", return_value=client), \
                redirect_stdout(output), redirect_stderr(error):
            self.assertEqual(bridge.main(), 1)
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(json.loads(error.getvalue())["code"], "incomplete_read")
        self.assertEqual(len(http.calls), 3)

    def test_native_http_timeout_is_clipped_to_remaining_operation_budget(self):
        result = MagicMock()
        result.code, result.headers = 200, {}
        result.read1.side_effect = [b'{"value":[]}', b""]
        opener = MagicMock()
        opener.open.return_value = result
        client = PrClient("example", Transport(self.state, auth=lambda: "Basic fake"), read_timeout=5)
        with patch("shared.transport.urllib.request.build_opener", return_value=opener):
            self.assertEqual(self.read_threads(client), {"count": 0, "value": []})
        self.assertEqual(opener.open.call_args.kwargs["timeout"], 5)

    def test_changes_and_policy_offset_pages_share_total_read_deadlines(self):
        for operation in ("changes", "policies"):
            with self.subTest(operation=operation):
                if operation == "changes":
                    http = Http(response({"changeEntries": [{"id": 1}], "nextSkip": 1, "nextTop": 1}),
                                response({"changeEntries": [{"id": 2}], "nextSkip": 0, "nextTop": 0}))
                else:
                    http = Http(response({"value": [{"id": index, "status": "approved"} for index in range(100)]}),
                                response({"value": []}))

                def send(*args):
                    self.clock.now += 2
                    return http(*args)

                client = PrClient("example", Transport(self.state, auth=lambda: "Basic fake", send=send), read_timeout=3)
                with self.assertRaisesRegex(AdoError, "incomplete read") as failure:
                    if operation == "changes":
                        bridge.dispatch({"operation": "read", "org": ORG, "project": "project", "repositoryId": "repo",
                                         "pullRequestId": 42, "resource": "changes", "iterationId": 3}, client)
                    else:
                        client.policies(SCOPE)
                self.assertEqual(failure.exception.code, "incomplete_read")
                self.assertEqual(len(http.calls), 2)

    def test_route_category_does_not_derive_from_project_or_repository_identifiers(self):
        http = Http(response({"value": []}))
        error = StringIO()
        with patch.dict(os.environ, {"ADO_REQUEST_DIAGNOSTICS": "1"}), redirect_stderr(error):
            client = self.client(http)
            bridge.dispatch({"operation": "read", "org": ORG, "project": "items", "repositoryId": "changes",
                             "pullRequestId": 42, "resource": "threads"}, client)
        self.assertEqual(json.loads(error.getvalue())["routeCategory"], "threads")
        self.assertEqual(len(http.calls), 1)

    def test_monotonic_deadline_is_not_extended_by_wall_clock_rollback(self):
        elapsed = Clock()
        http = Http(response({"value": [{"id": 1}]}, headers={"x-ms-continuationtoken": "one"}),
                    response({"value": [{"id": 2}]}, headers={"x-ms-continuationtoken": "two"}))

        def send(*args):
            elapsed.now += 2
            self.clock.now -= 100
            return http(*args)

        client = PrClient("example", Transport(self.state, auth=lambda: "Basic fake", send=send, timer=elapsed), read_timeout=3)
        with self.assertRaisesRegex(AdoError, "incomplete read") as failure:
            self.read_threads(client)
        self.assertEqual(failure.exception.code, "incomplete_read")
        self.assertEqual(len(http.calls), 2)

    def test_native_streaming_body_cannot_extend_total_deadline_with_small_chunks(self):
        result = MagicMock()
        result.code, result.headers = 200, {}

        def chunk(_size):
            self.clock.now += 2
            return b" "

        result.read1.side_effect = chunk
        opener = MagicMock()
        opener.open.return_value = result
        client = PrClient("example", Transport(self.state, auth=lambda: "Basic fake"), read_timeout=3)
        with patch("shared.transport.urllib.request.build_opener", return_value=opener), \
                self.assertRaisesRegex(AdoError, "incomplete read") as failure:
            self.read_threads(client)
        self.assertEqual(failure.exception.code, "incomplete_read")
        self.assertEqual(opener.open.call_count, 1)
        self.assertEqual(result.read1.call_count, 2)

    def test_native_definite_write_rejection_does_not_depend_on_reading_error_body(self):
        for status in (404, 409, 429):
            with self.subTest(status=status):
                result = MagicMock()
                result.code, result.headers = status, {"Retry-After": "5"}
                result.read1.side_effect = AssertionError("error body must not hide definite rejection")
                opener = MagicMock()
                opener.open.return_value = result
                transport = Transport(self.state, auth=lambda: "Basic fake")
                with patch("shared.transport.urllib.request.build_opener", return_value=opener), self.assertRaises(WriteRejected):
                    transport.json(SCOPE.base + "/threads?api-version=7.1", "POST", b"{}")
                result.read1.assert_not_called()
                self.assertEqual(opener.open.call_count, 1)
                self.assertEqual(self.state.cooldown("example"), self.clock.now + 5)
                self.clock.now += 5

    def test_network_failure_diagnostics_do_not_invent_a_server_http_status(self):
        http = Http(ConnectionError("private-exception-detail"), response({"value": []}))
        error = StringIO()
        with patch.dict(os.environ, {"ADO_REQUEST_DIAGNOSTICS": "1"}), redirect_stderr(error):
            self.read_threads(self.client(http))
        records = [json.loads(line) for line in error.getvalue().splitlines()]
        self.assertEqual(len(records), 1)
        self.assertEqual((records[0]["status"], records[0]["attempt"]), (200, 2))
        self.assertNotIn("private-exception-detail", error.getvalue())
        self.assertEqual(len(http.calls), 2)

    def test_get_429_date_retry_and_bounded_retry_budget(self):
        date = format_datetime(datetime.fromtimestamp(1007, timezone.utc), usegmt=True)
        http = Http(response({}, 429, {"retry-after": date}), response({"value": [{"id": 7}]}))
        self.assertEqual(self.read_threads(self.client(http))["value"], [{"id": 7}])
        self.assertEqual(len(http.calls), 2)
        self.assertEqual(self.clock.sleeps, [7])
        http = Http(*(response({}, 429) for _ in range(3)))
        with self.assertRaisesRegex(AdoError, "HTTP 429"):
            self.read_threads(self.client(http))
        self.assertEqual(len(http.calls), 3)

    def test_long_success_cooldown_defers_next_request_without_loop(self):
        http = Http(response({"value": []}, headers={"retry-after": "600"}))
        self.read_threads(self.client(http))
        with self.assertRaises(Deferred) as failure:
            self.read_threads(self.client(http, "Basic another"))
        self.assertEqual(failure.exception.retry_at, 1600)
        self.assertEqual(len(http.calls), 1)
        self.assertEqual(self.clock.sleeps, [])

    def test_cross_process_success_cooldown_and_date_are_observed(self):
        date = format_datetime(datetime.fromtimestamp(1009, timezone.utc), usegmt=True)
        self.read_threads(self.client(Http(response({"value": []}, headers={"retry-after": date}))))
        context = multiprocessing.get_context("spawn")
        result = context.Queue()
        worker = context.Process(target=cooldown_worker, args=(self.directory.name, result))
        worker.start()
        worker.join(10)
        self.assertEqual(worker.exitcode, 0)
        self.assertEqual(result.get(timeout=1), ("ok", 1, [9]))
        self.state.throttle("example", 2000)
        worker = context.Process(target=cooldown_worker, args=(self.directory.name, result))
        worker.start()
        worker.join(10)
        self.assertEqual(worker.exitcode, 0)
        self.assertEqual(result.get(timeout=1), ("deferred", 0, 2000))

    def test_cross_process_429_cooldown_prevents_other_principal_read(self):
        http = Http(response({}, 429, {"retry-after": "900"}))
        with self.assertRaises(Deferred):
            self.read_threads(self.client(http))
        self.assertEqual(len(http.calls), 1)
        context = multiprocessing.get_context("spawn")
        result = context.Queue()
        worker = context.Process(target=cooldown_worker, args=(self.directory.name, result))
        worker.start()
        worker.join(10)
        self.assertEqual(worker.exitcode, 0)
        self.assertEqual(result.get(timeout=1), ("deferred", 0, 1900))

    def test_mutations_are_never_retried_or_echoed_in_errors(self):
        for failure in (response({"secret": "do-not-echo"}, 429, {"retry-after": "5"}), ConnectionError("do-not-echo")):
            http = Http(failure)
            with self.assertRaises(AdoError) as error:
                self.client(http).transport.json(SCOPE.base + "/threads?api-version=7.1", "POST", b'{"content":"private"}')
            self.assertNotIn("do-not-echo", str(error.exception))
            self.assertEqual(len(http.calls), 1)
            self.clock.now += 10

    def test_origin_validation_precedes_auth_and_redirects_rejected(self):
        for url in ("http://dev.azure.com/example/a", "https://evil.example/a", "https://user:secret@dev.azure.com/example/a",
                    "https://dev.azure.com:123/example/a", "https://example.visualstudio.com.evil/a",
                    "https://dev.azure.com/example/../other/a", "https://dev.azure.com/%2Fother/a", "https://dev.azure.com/example/a#fragment",
                    "https://almsearch.dev.azure.com.evil/example/a", "https://almsearch.dev.azure.com:444/example/a",
                    "https://user:private@almsearch.dev.azure.com/example/a",
                    "https://almsearch.dev.azure.com/example/%2e%2e/other/a"):
            with self.subTest(url=url), patch("shared.transport.authorization", side_effect=AssertionError("auth called")):
                http = Http()
                transport = Transport(self.state, auth=lambda: (_ for _ in ()).throw(AssertionError("auth called")), send=http)
                with self.assertRaises(AdoError):
                    transport.json(url)
                self.assertEqual(http.calls, [])
        with self.assertRaisesRegex(AdoError, "redirect rejected"):
            NoRedirect().redirect_request(None, None, 302, "", {}, "https://dev.azure.com/other")

    def test_cli_pat_and_token_config_resolution_and_no_token_failure_leak(self):
        with patch.dict(os.environ, {"AZURE_DEVOPS_EXT_PAT": "secret-pat"}), patch("subprocess.run") as run:
            self.assertEqual(authorization(), "Basic OnNlY3JldC1wYXQ=")
            run.assert_not_called()
        environment = dict(os.environ)
        environment.pop("AZURE_DEVOPS_EXT_PAT", None)
        with patch.dict(os.environ, environment, clear=True), \
                patch("shared.transport.shutil.which", return_value="az.exe"), \
                patch("subprocess.run", return_value=subprocess.CompletedProcess([], 0, "cli-token\n", "")):
            self.assertEqual(authorization(), "Bearer cli-token")
        with patch.dict(os.environ, environment, clear=True), \
                patch("shared.transport.shutil.which", return_value="az.exe"), \
                patch("subprocess.run", return_value=subprocess.CompletedProcess([], 1, "", "secret-token")):
            with self.assertRaises(AdoError) as error:
                authorization()
            self.assertNotIn("secret-token", str(error.exception))
        config = Path(self.directory.name) / "azuredevops"
        config.mkdir()
        (config / "config").write_text("[defaults]\norganization=https://example.visualstudio.com/DefaultCollection\n")
        with patch.dict(os.environ, {"AZURE_CONFIG_DIR": self.directory.name, "AZURE_DEVOPS_EXT_ORG": ""}):
            self.assertEqual(resolve_organization(detect="false"), "example")
            with patch("subprocess.run", return_value=subprocess.CompletedProcess([], 0, "git@ssh.dev.azure.com:v3/other/project/repo\n", "")):
                self.assertEqual(resolve_organization(), "other")

    def test_saved_azure_cli_pat_org_alias_and_default_work_without_cli(self):
        config = Path(self.directory.name) / "azuredevops"
        config.mkdir()
        credentials = config / "personalAccessTokens"
        credentials.write_text("[azdevops-cli:https://example.visualstudio.com]\nPersonal Access Token=org%pat\n"
                               "[azdevops-cli: default]\nPersonal Access Token=default-pat\n")
        environment = dict(os.environ)
        environment.pop("AZURE_DEVOPS_EXT_PAT", None)
        environment["AZURE_CONFIG_DIR"] = self.directory.name
        http = Http(response({"value": []}), response({"value": []}))
        transport = Transport(self.state, send=http)
        with patch.dict(os.environ, environment, clear=True), patch("sys.platform", "linux"), \
                patch("shared.transport.shutil.which", return_value=None), \
                patch("subprocess.run", return_value=subprocess.CompletedProcess([], 1, "", "private-error")) as run:
            client = PrClient("example", transport)
            self.read_threads(client)
            self.read_threads(client)
            run.assert_not_called()
            self.assertEqual(http.calls[0][3]["authorization"], "Basic Om9yZyVwYXQ=")
            self.assertEqual(authorization("other"), "Basic OmRlZmF1bHQtcGF0")

    def test_keychain_pat_lookup_has_no_credentials_in_argv(self):
        environment = dict(os.environ)
        environment.pop("AZURE_DEVOPS_EXT_PAT", None)
        environment["AZURE_CONFIG_DIR"] = self.directory.name
        calls = []

        def native(command, **kwargs):
            calls.append(command)
            return subprocess.CompletedProcess(command, 1, "", "") if command[1:3] == ["account", "get-access-token"] else subprocess.CompletedProcess(command, 0, "keychain-secret\n", "")

        with patch.dict(os.environ, environment, clear=True), patch("sys.platform", "darwin"), \
                patch("shared.transport.shutil.which", side_effect=lambda name: "/offline/az" if name == "az" else None), \
                patch("subprocess.run", side_effect=native):
            self.assertEqual(authorization("example"), "Basic OmtleWNoYWluLXNlY3JldA==")
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[1], ["security", "find-generic-password", "-s", "azdevops-cli:https://dev.azure.com/example", "-a", "Personal Access Token", "-w"])
        self.assertNotIn("keychain-secret", json.dumps(calls))

    def test_windows_read_uses_paired_python_for_cli_command_shim_and_memoizes_token(self):
        shim = r"C:\Program Files\Azure CLI\wbin\az.cmd"
        python = r"C:\Program Files\Azure CLI\python.exe"
        http = Http(response({"value": []}), response({"value": []}))
        with patch.dict(os.environ, {"AZURE_CONFIG_DIR": self.directory.name}, clear=True), \
                patch("sys.platform", "win32"), \
                patch("shared.transport.shutil.which", side_effect=lambda name: shim if name == "az" else None), \
                patch("shared.transport.os.path.isfile", side_effect=lambda path: path == python), \
                patch("subprocess.run", return_value=subprocess.CompletedProcess([], 0, "mocked-token\n", "")) as run:
            client = PrClient("example", Transport(self.state, send=http))
            self.read_threads(client)
            self.read_threads(client)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[0][:7], [python, "-X", "utf8", "-IBm", "azure.cli", "account", "get-access-token"])
        self.assertEqual(run.call_args.kwargs["encoding"], "utf-8")
        self.assertNotIn("shell", run.call_args.kwargs)
        self.assertEqual(len(http.calls), 2)
        self.assertTrue(all(call[3]["authorization"] == "Bearer mocked-token" for call in http.calls))

    def test_windows_read_falls_back_to_stored_pat_after_native_launch_oserror193(self):
        native = r"C:\Program Files\Azure CLI\az.exe"
        http = Http(response({"value": []}))
        with patch.dict(os.environ, {"AZURE_CONFIG_DIR": self.directory.name}, clear=True), \
                patch("sys.platform", "win32"), \
                patch("shared.transport.shutil.which", side_effect=lambda name: native if name == "az.exe" else None), \
                patch("subprocess.run", side_effect=OSError(193, "invalid executable")) as run, \
                patch("shared.transport.stored_pat", return_value="stored-pat") as stored:
            client = PrClient("example", Transport(self.state, send=http))
            self.read_threads(client)
        self.assertEqual(run.call_args.args[0][0], native)
        stored.assert_called_once_with("example")
        self.assertEqual(len(http.calls), 1)
        self.assertEqual(http.calls[0][3]["authorization"], "Basic OnN0b3JlZC1wYXQ=")

    def test_immutable_auth_partition_binary_and_content_limit(self):
        request = {"operation": "read", "org": ORG, "project": "project", "resource": "item",
                   "repositoryId": "repo", "path": "/a.py", "commit": "a" * 40}
        http = Http(response({"content": "one"}), response({"content": "two"}), response({"contentMetadata": {"isBinary": True}}))
        self.assertEqual(bridge.dispatch(request, self.client(http)), {"content": "one"})
        self.assertEqual(bridge.dispatch(request, self.client(http)), {"content": "one"})
        self.assertEqual(bridge.dispatch(request, self.client(http, "Basic other")), {"content": "two"})
        request["path"] = "/image.png"
        binary = {"contentMetadata": {"isBinary": True}}
        self.assertEqual(bridge.dispatch(request, self.client(http)), binary)
        self.assertEqual(bridge.dispatch(request, self.client(http)), binary)
        self.assertEqual(len(http.calls), 3)
        request["path"] = "/large.py"
        with self.assertRaisesRegex(AdoError, "exceeds 2097152 bytes") as failure:
            bridge.dispatch(request, self.client(Http(response({"content": "x" * (2 * 1024 * 1024 + 1)}))))
        self.assertEqual(failure.exception.code, "content_too_large")
        request["commit"] = "main"
        with self.assertRaisesRegex(AdoError, "full commit"):
            bridge.dispatch(request, self.client(Http()))

    def test_immutable_entry_and_byte_bounds_evict_oldest(self):
        class Items:
            def __init__(self):
                self.count = 0

            def __call__(self, *args):
                self.count += 1
                return response({"content": "content"})

        http = Items()
        client = self.client(http)
        request = {"operation": "read", "org": ORG, "project": "project", "resource": "item",
                   "repositoryId": "repo", "path": "/0", "commit": "a" * 40}
        for index in range(257):
            request["path"] = f"/{index}"
            bridge.dispatch(request, client)
            self.clock.now += 1
        with self.state.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM cache").fetchone()[0], 256)
        request["path"] = "/0"
        bridge.dispatch(request, client)
        self.assertEqual(http.count, 258)
        large = Http(*(response({"content": "x" * (2 * 1024 * 1024)}) for _ in range(33)))
        for index in range(33):
            request["path"] = f"/large-{index}"
            bridge.dispatch(request, self.client(large))
            self.clock.now += 1
        with self.state.connect() as db:
            self.assertLessEqual(db.execute("SELECT sum(length(payload)) FROM cache").fetchone()[0], 64 * 1024 * 1024)

    def test_changes_threads_complete_and_repeated_token_fails(self):
        http = Http(response({"changeEntries": [{"id": 1}], "nextSkip": 1, "nextTop": 1}),
                    response({"changeEntries": [{"id": 2}], "nextSkip": 0, "nextTop": 0}))
        request = {"operation": "read", "org": ORG, "project": "project", "repositoryId": "repo",
                   "pullRequestId": 42, "resource": "changes", "iterationId": 3}
        self.assertEqual(bridge.dispatch(request, self.client(http))["changeEntries"], [{"id": 1}, {"id": 2}])
        self.assertIn("%24skip=1", http.calls[1][0])
        self.assertEqual(len(http.calls), 2)
        http = Http(response({"value": [{"id": 1}]}, headers={"x-ms-continuationtoken": "opaque+/="}),
                    response({"value": [{"id": 2}]}))
        self.assertEqual(self.read_threads(self.client(http))["count"], 2)
        self.assertIn("continuationToken=opaque%2B%2F%3D", http.calls[1][0])
        http = Http(*(response({"value": []}, headers={"x-ms-continuationtoken": "same"}) for _ in range(2)))
        with self.assertRaisesRegex(AdoError, "repeated"):
            self.read_threads(self.client(http))
        self.assertEqual(len(http.calls), 2)
        with self.assertRaisesRegex(AdoError, "incomplete"):
            self.read_threads(self.client(Http(response({}))))

    def test_changes_aggregate_over_display_cap_and_bound_every_top(self):
        http = Http(response({"changeEntries": [{"id": index} for index in range(1, 2001)],
                              "nextSkip": 2000, "nextTop": 5000}),
                    response({"changeEntries": [{"id": index} for index in range(2001, 4001)],
                              "nextSkip": 4000, "nextTop": 1000}),
                    response({"changeEntries": [{"id": index} for index in range(4001, 4502)],
                              "nextSkip": 0, "nextTop": 0}))
        request = {"operation": "read", "org": ORG, "project": "project", "repositoryId": "repo",
                   "pullRequestId": 42, "resource": "changes", "iterationId": 3}
        payload = bridge.dispatch(request, self.client(http))
        self.assertEqual(payload["changeEntries"], [{"id": index} for index in range(1, 4502)])
        self.assertEqual((payload["nextSkip"], payload["nextTop"]), (0, 0))
        self.assertEqual(len(http.calls), 3)
        queries = [parse_qs(urlsplit(call[0]).query) for call in http.calls]
        self.assertEqual([query["$skip"] for query in queries], [["0"], ["2000"], ["4000"]])
        self.assertEqual([query["$top"] for query in queries], [["2000"], ["2000"], ["1000"]])

    def test_full_change_page_without_body_continuation_fails_explicitly(self):
        request = {"operation": "read", "org": ORG, "project": "project", "repositoryId": "repo",
                   "pullRequestId": 42, "resource": "changes", "iterationId": 3}
        http = Http(response({"changeEntries": [{"id": index} for index in range(2000)]}))
        with self.assertRaisesRegex(AdoError, "incomplete continuation"):
            bridge.dispatch(request, self.client(http))
        self.assertEqual(len(http.calls), 1)

    def snapshot_http(self, end=None):
        good = {"id": 1, "sourceVersion": "merge", "status": "completed", "result": "succeeded"}
        failed = {"id": 2, "sourceVersion": "merge", "status": "completed", "result": "failed"}
        stale = {"id": 3, "sourceVersion": "old", "status": "completed", "result": "failed"}
        return Http(response(DETAILS), response({"value": [{"id": 4, "status": "active", "comments": []}]}),
                    response({"value": [{"id": index, "status": "approved"} for index in range(5, 105)]}),
                    response({"value": [{"id": 105, "status": "rejected"}]}),
                    response({"value": [good, stale]}, headers={"x-ms-continuationtoken": "build-next"}),
                    response({"value": [failed]}), response(end or DETAILS))

    def test_snapshot_exact_budget_includes_late_failed_build_and_complete_policies(self):
        http = self.snapshot_http()
        payload = bridge.dispatch({"operation": "snapshot", "org": ORG, "pullRequestId": 42}, self.client(http))
        self.assertTrue(payload["builds"]["hasFailures"])
        self.assertEqual([build["id"] for build in payload["builds"]["builds"]], [1, 2])
        self.assertEqual(payload["policies"], [{"id": index, "status": "approved"} for index in range(5, 105)]
                         + [{"id": 105, "status": "rejected"}])
        self.assertEqual(payload["reviewers"], DETAILS["reviewers"])
        self.assertEqual(payload["details"], DETAILS)
        self.assertEqual(payload["threads"], [{"id": 4, "status": "active", "comments": []}])
        self.assertEqual(payload["revision"]["mergeCommit"], "merge")
        self.assertEqual(payload["observedAt"], "1970-01-01T00:16:40+00:00")
        self.assertEqual(len(http.calls), 7)
        queries = [parse_qs(urlsplit(call[0]).query) for call in http.calls[2:4]]
        self.assertEqual(queries, [
            {"api-version": ["7.1-preview.1"], "artifactId": ["vstfs:///CodeReview/CodeReviewId/project/42"],
             "$top": ["100"], "$skip": ["0"]},
            {"api-version": ["7.1-preview.1"], "artifactId": ["vstfs:///CodeReview/CodeReviewId/project/42"],
             "$top": ["100"], "$skip": ["100"]},
        ])
        self.assertTrue(all("continuationToken" not in query for query in queries))

    def test_snapshot_full_policy_page_requires_next_offset_even_without_header(self):
        http = self.snapshot_http()
        http.outcomes[3] = response({"value": []})
        payload = bridge.dispatch({"operation": "snapshot", "org": ORG, "pullRequestId": 42}, self.client(http))
        self.assertEqual(len(payload["policies"]), 100)
        self.assertEqual(len(http.calls), 7)
        self.assertEqual(parse_qs(urlsplit(http.calls[3][0]).query)["$skip"], ["100"])

    def test_snapshot_late_policy_page_failures_and_repeated_pages_fail_closed(self):
        for failure, expected in ((response({}, 403), "HTTP 403"),
                                  (response({"value": [{"id": 105}]}), "incomplete"),
                                  (response({"value": [{"id": index, "status": "approved"}
                                                       for index in range(5, 105)]}), "repeated")):
            with self.subTest(expected=expected):
                http = self.snapshot_http()
                http.outcomes[3] = failure
                with self.assertRaisesRegex(AdoError, expected):
                    bridge.dispatch({"operation": "snapshot", "org": ORG, "pullRequestId": 42}, self.client(http))
                self.assertEqual(len(http.calls), 4)

    def test_snapshot_drift_and_late_page_errors_fail_closed(self):
        drift = {**DETAILS, "lastMergeSourceCommit": {"commitId": "new"}}
        http = self.snapshot_http(drift)
        with self.assertRaisesRegex(AdoError, "revision changed"):
            bridge.dispatch({"operation": "snapshot", "org": ORG, "pullRequestId": 42}, self.client(http))
        self.assertEqual(len(http.calls), 7)
        http = self.snapshot_http()
        http.outcomes[5] = response({}, 403)
        with self.assertRaisesRegex(AdoError, "HTTP 403"):
            bridge.dispatch({"operation": "snapshot", "org": ORG, "pullRequestId": 42}, self.client(http))
        self.assertEqual(len(http.calls), 6)
        http = Http(response({**DETAILS, "lastMergeCommit": None}))
        with self.assertRaisesRegex(AdoError, "incomplete"):
            bridge.dispatch({"operation": "snapshot", "org": ORG, "pullRequestId": 42}, self.client(http))
        self.assertEqual(len(http.calls), 1)

    def test_active_snapshot_requires_explicit_draft_and_reviewers_types(self):
        for field, invalid in (("isDraft", "missing"), ("isDraft", None), ("isDraft", 0), ("isDraft", "false"),
                               ("reviewers", "missing"), ("reviewers", None), ("reviewers", {}),
                               ("reviewers", [1]), ("reviewers", False)):
            with self.subTest(field=field, invalid=invalid):
                details = json.loads(json.dumps(DETAILS))
                if invalid == "missing":
                    details.pop(field)
                else:
                    details[field] = invalid
                http = Http(response(details))
                with self.assertRaisesRegex(AdoError, "incomplete"):
                    bridge.dispatch({"operation": "snapshot", "org": ORG, "pullRequestId": 42}, self.client(http))
                self.assertEqual(len(http.calls), 1)

    def test_snapshot_fence_cannot_default_missing_readiness_metadata(self):
        for field in ("isDraft", "reviewers"):
            with self.subTest(field=field):
                fence = json.loads(json.dumps(DETAILS))
                fence.pop(field)
                http = self.snapshot_http(fence)
                with self.assertRaisesRegex(AdoError, "incomplete at snapshot fence"):
                    bridge.dispatch({"operation": "snapshot", "org": ORG, "pullRequestId": 42}, self.client(http))
                self.assertEqual(len(http.calls), 7)

    def test_terminal_snapshot_does_not_read_dependencies(self):
        for status in ("completed", "abandoned"):
            http = Http(response({**DETAILS, "status": status}))
            payload = bridge.dispatch({"operation": "snapshot", "org": ORG, "pullRequestId": 42}, self.client(http))
            self.assertTrue(payload["terminal"])
            self.assertEqual(payload["threads"], [])
            self.assertEqual(payload["policies"], [])
            self.assertEqual(len(http.calls), 1)
        http = Http(response({"pullRequestId": 42, "status": "completed"}))
        self.assertTrue(bridge.dispatch({"operation": "snapshot", "org": ORG, "pullRequestId": 42}, self.client(http))["terminal"])
        self.assertEqual(len(http.calls), 1)

    def test_cli_context_threads_builds_preserve_shapes_and_share_scope(self):
        args = argparse.Namespace(id="42", status="", top=1, org=ORG, detect="false")
        for operation, http, expected in (
            (pr_script.context, Http(response(DETAILS)), {"repositoryId": "repo", "sourceBranchName": "feature"}),
            (pr_script.list_threads, Http(response(DETAILS), response({"value": [{"id": 7}]})), {"count": 1, "threads": [{"id": 7}]}),
            (pr_script.list_builds, Http(response(DETAILS), response({"value": []}, headers={"x-ms-continuationtoken": "next"}),
                                       response({"value": [{"id": 9, "sourceVersion": "merge", "status": "completed", "result": "failed"}]})),
             {"hasFailures": True, "mergeCommitId": "merge"}),
        ):
            output = StringIO()
            with patch.object(pr_script, "cli_client", return_value=self.client(http)), redirect_stdout(output):
                operation(args)
            payload = json.loads(output.getvalue())
            for key, value in expected.items():
                self.assertEqual(payload[key], value)
            self.assertEqual(len(http.calls), 1 if operation == pr_script.context else 2 if operation == pr_script.list_threads else 3)

    def test_direct_request_json_and_create_helper_use_coordinated_owner(self):
        http = Http(response({"pullRequestId": 42}, headers={"retry-after": "60"}))
        transport = self.client(http).transport
        args = argparse.Namespace(org="example", project="project", repository="repo", repository_id="",
                                  source_branch="feature", target_branch="main", title="Title", description="Summary",
                                  description_file="", draft=False, user_authored=False)
        with patch.object(ado, "Transport", return_value=transport), redirect_stdout(StringIO()):
            make_pr.create_pr(args)
        self.assertEqual(len(http.calls), 1)
        self.assertTrue(http.calls[0][2]["description"].endswith(ado.AI_ATTRIBUTION))
        with patch.object(ado, "Transport", return_value=transport), self.assertRaises(Deferred):
            ado.request_json(ORG + "/_apis/projects?api-version=7.1")
        self.assertEqual(len(http.calls), 1)

    def test_work_item_search_and_required_fields_share_owner_cooldown(self):
        http = Http(response({"count": 1, "results": [{
            "fields": {"system.id": "7", "system.title": "Title"},
            "project": {"name": "Project name"},
        }]}, headers={"retry-after": "4"}),
                    response({"value": [{"alwaysRequired": True, "referenceName": "System.Title", "name": "Title"}]}))
        transport = self.client(http).transport
        search = argparse.Namespace(org="https://EXAMPLE.visualstudio.com/DefaultCollection",
                                    top=25, type=["Bug"], project=["Project name"], area=[], text="authored query")
        required = argparse.Namespace(org=ORG, project="Project name", type="Bug")
        output = StringIO()
        with patch.object(ado, "Transport", return_value=transport), redirect_stdout(output):
            work_items.search_work_items(search)
        payload = json.loads(output.getvalue())
        self.assertEqual(payload["results"][0]["id"], 7)
        self.assertEqual(payload["results"][0]["title"], "Title")
        output = StringIO()
        with patch.object(ado, "Transport", return_value=transport), redirect_stdout(output):
            work_items.required_fields(required)
        self.assertEqual(json.loads(output.getvalue())["requiredFields"][0]["referenceName"], "System.Title")
        self.assertEqual([call[1] for call in http.calls], ["POST", "GET"])
        self.assertTrue(http.calls[0][0].startswith("https://almsearch.dev.azure.com/example/"))
        self.assertEqual(http.calls[0][2], {"searchText": "authored query", "$top": 25,
                                         "filters": {"System.WorkItemType": ["Bug"], "System.TeamProject": ["Project name"]}})
        self.assertIn("/Project%20name/_apis/wit/workitemtypes/Bug/fields?", http.calls[1][0])
        self.assertEqual(self.clock.sleeps, [4])

    def test_wiql_cli_executes_coordinated_post_with_exact_query_and_no_az(self):
        query = "SELECT [System.Id] FROM WorkItems WHERE [System.Title] = '$(not-shell)'"
        result = {"queryType": "flat", "asOf": "2026-10-01T00:00:00Z", "columns": [{"referenceName": "System.Id"}],
                  "workItems": [{"id": 7, "url": ORG + "/_apis/wit/workItems/7"}]}
        http = Http(response(result, headers={"retry-after": "60"}))
        transport = self.client(http).transport
        output = StringIO()
        with patch.object(sys, "argv", ["ado-work-items.py", "query", "--org", ORG,
                                       "--project", "Project name", "--wiql", query]), \
                patch.object(ado, "Transport", return_value=transport), \
                patch("subprocess.run", side_effect=AssertionError("unexpected CLI transport")), redirect_stdout(output):
            work_items.main()
        self.assertEqual(json.loads(output.getvalue()), result)
        self.assertEqual([call[1] for call in http.calls], ["POST"])
        self.assertEqual(http.calls[0][2], {"query": query})
        self.assertIn("/Project%20name/_apis/wit/wiql?api-version=7.1", http.calls[0][0])
        with patch.object(ado, "Transport", return_value=transport), self.assertRaises(Deferred):
            work_items.query_work_items(argparse.Namespace(org=ORG, project="Project name", wiql=query))
        self.assertEqual(len(http.calls), 1)

    def test_wiql_post_failure_is_not_blindly_retried(self):
        http = Http(response({"error": "authored private query"}, 429, {"retry-after": "5"}))
        with patch.object(ado, "Transport", return_value=self.client(http).transport), \
                self.assertRaisesRegex(AdoError, "HTTP 429"):
            work_items.query_work_items(argparse.Namespace(org=ORG, project="project", wiql="SELECT [System.Id] FROM WorkItems"))
        self.assertEqual([call[1] for call in http.calls], ["POST"])

    def test_work_item_link_reuses_one_owner_for_repo_resolution_and_patch(self):
        http = Http(response({"id": "repo", "project": {"id": "project"}}, headers={"retry-after": "3"}),
                    response({"rev": 5}))
        transport = self.client(http).transport
        args = argparse.Namespace(org=ORG, project="Project name", repository="Repo name",
                                  project_id="", repository_id="", pull_request_id=42, work_item_id=7)
        output = StringIO()
        with patch.object(work_items, "Transport", return_value=transport), redirect_stdout(output):
            work_items.link_pr(args)
        self.assertEqual(json.loads(output.getvalue())["rev"], 5)
        self.assertEqual([call[1] for call in http.calls], ["GET", "PATCH"])
        self.assertIn("/Project%20name/_apis/git/repositories/Repo%20name?", http.calls[0][0])
        self.assertEqual(http.calls[1][2], [{"op": "add", "path": "/relations/-",
                                           "value": {"rel": "ArtifactLink",
                                                     "url": "vstfs:///Git/PullRequestId/project%2Frepo%2F42",
                                                     "attributes": {"name": "Pull Request"}}}])
        self.assertEqual(self.clock.sleeps, [3])

    def test_review_label_sync_uses_one_owner_scope_and_observes_throttle(self):
        details = json.loads(json.dumps(DETAILS))
        details["repository"]["id"] = "Repo name"
        details["repository"]["project"]["id"] = "Project name"
        http = Http(response(details), response({"value": [
            {"name": "ai-model-old"}, {"name": "keep-user-label"}, {"name": "ai-reviewed"},
        ]}), response({}, 204, {"retry-after": "3"}), response({"name": "ai-model-new"}),
                    response({"value": [{"name": "ai-reviewed"}, {"name": "ai-model-new"}, {"name": "keep-user-label"}]}))
        output = StringIO()
        with patch.object(review_pr, "cli_client", return_value=self.client(http)), redirect_stdout(output):
            review_pr.sync_labels(argparse.Namespace(org=ORG, detect="true", id="42", model=["new"]))
        payload = json.loads(output.getvalue())
        self.assertEqual(payload["addedLabels"], ["ai-model-new"])
        self.assertEqual(payload["removedLabels"], ["ai-model-old"])
        self.assertIn("keep-user-label", payload["finalLabels"])
        self.assertEqual([call[1] for call in http.calls], ["GET", "GET", "DELETE", "POST", "GET"])
        self.assertTrue(all("/Project%20name/_apis/git/repositories/Repo%20name/pullRequests/42/labels" in call[0]
                            for call in http.calls[1:]))
        self.assertEqual(http.calls[3][2], {"name": "ai-model-new"})
        self.assertEqual(self.clock.sleeps, [3])

    def test_review_label_mutation_failure_stops_without_retry_or_later_mutations(self):
        http = Http(response(DETAILS), response({"value": []}), response({}, 503))
        with patch.object(review_pr, "cli_client", return_value=self.client(http)), \
                self.assertRaisesRegex(AdoError, "HTTP 503"):
            review_pr.sync_labels(argparse.Namespace(org=ORG, detect="true", id="42", model=["new"]))
        self.assertEqual([call[1] for call in http.calls], ["GET", "GET", "POST"])
        self.assertEqual(http.calls[2][2], {"name": "ai-reviewed"})

    def test_publication_batch_indexes_new_threads_and_attributes_at_boundary(self):
        http = Http(response({"value": []}), response({"value": [{"id": 2}]}), response({"id": 91}))
        result = self.publish(self.client(http), [FINDING, FINDING])
        self.assertEqual([item["kind"] for item in result["results"]], ["published", "duplicate"])
        self.assertEqual([item["remoteThreadId"] for item in result["results"]], [91, 91])
        self.assertEqual([call[1] for call in http.calls], ["GET", "GET", "POST"])
        self.assertIn("/iterations?", http.calls[1][0])
        submitted = http.calls[2][2]["comments"][0]["content"]
        self.assertTrue(submitted.endswith(ado.AI_ATTRIBUTION))
        self.assertEqual(submitted.count(ado.AI_ATTRIBUTION), 1)

    def test_invalid_finding_payload_fails_before_read_or_write(self):
        for invalid in ({"comments": []}, {**FINDING["payload"], "threadContext": None},
                        {**FINDING["payload"], "pullRequestThreadContext": {"iterationContext": {}}},
                        {**FINDING["payload"], "status": True}):
            http = Http()
            with self.assertRaises(AdoError):
                self.publish(self.client(http), [{"findingId": "finding-1", "payload": invalid}])
            self.assertEqual(http.calls, [])

    def test_publication_latest_iteration_fence_exhausts_pages_and_rejects_stale_payload(self):
        http = Http(response({"value": []}),
                    response({"value": [{"id": 1}]}, headers={"x-ms-continuationtoken": "next-iteration"}),
                    response({"value": [{"id": 3}]}))
        result = self.publish(self.client(http))
        self.assertEqual(result["results"][0]["kind"], "failed")
        self.assertIn("iteration is not current", result["results"][0]["error"])
        self.assertEqual([call[1] for call in http.calls], ["GET", "GET", "GET"])
        with self.state.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM journal").fetchone()[0], 0)
        current = json.loads(json.dumps(FINDING))
        current["payload"]["pullRequestThreadContext"]["iterationContext"]["secondComparingIteration"] = 3
        http = Http(response({"value": []}), response({"value": [{"id": 3}]}), response({"id": 80}))
        self.assertEqual(self.publish(self.client(http), [current])["results"][0]["kind"], "published")
        self.assertEqual([call[1] for call in http.calls], ["GET", "GET", "POST"])

    def test_latest_iteration_is_read_while_publication_os_lock_is_held(self):
        http = Http(response({"value": []}), response({"value": [{"id": 2}]}), response({"id": 81}))

        def send(url, method, body, headers):
            if "/iterations?" in url:
                with self.assertRaisesRegex(AdoError, "still owns"):
                    with self.state.lock(SCOPE.lock_key, wait=0):
                        self.fail("iteration fence ran without the PR writer lock")
            return http(url, method, body, headers)

        self.assertEqual(self.publish(self.client(send))["results"][0]["kind"], "published")
        self.assertEqual([call[1] for call in http.calls], ["GET", "GET", "POST"])

    def test_late_iteration_page_failure_blocks_post_without_an_unknown_receipt(self):
        http = Http(response({"value": []}),
                    response({"value": [{"id": 2}]}, headers={"x-ms-continuationtoken": "next"}),
                    response({}, 403))
        with self.assertRaisesRegex(AdoError, "HTTP 403"):
            self.publish(self.client(http))
        self.assertEqual([call[1] for call in http.calls], ["GET", "GET", "GET"])
        with self.state.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM journal").fetchone()[0], 0)

    def test_successful_iteration_throttle_defers_before_journaling_unsent_post(self):
        http = Http(response({"value": []}),
                    response({"value": [{"id": 2}]}, headers={"retry-after": "90"}))
        with self.assertRaises(Deferred) as error:
            self.publish(self.client(http))
        self.assertEqual(error.exception.retry_at, 1090)
        self.assertEqual([call[1] for call in http.calls], ["GET", "GET"])
        with self.state.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM journal").fetchone()[0], 0)
        self.clock.now += 91
        http = Http(response({"value": []}), response({"value": [{"id": 2}]}), response({"id": 82}))
        self.assertEqual(self.publish(self.client(http))["results"][0]["kind"], "published")
        self.assertEqual([call[1] for call in http.calls], ["GET", "GET", "POST"])

    def test_successful_reply_read_throttle_defers_before_journaling_unsent_post(self):
        http = Http(response({"comments": []}, headers={"retry-after": "90"}))
        with self.assertRaises(Deferred):
            Publisher(self.client(http), SCOPE).reply_and_resolve(7, "Fixed", "fixed", False)
        self.assertEqual([call[1] for call in http.calls], ["GET"])
        with self.state.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM journal").fetchone()[0], 0)
        self.clock.now += 91
        http = Http(response({"comments": []}), response({"id": 8}), response({"id": 7, "status": 2}))
        self.assertEqual(Publisher(self.client(http), SCOPE).reply_and_resolve(7, "Fixed", "fixed", False)["reply"]["id"], 8)
        self.assertEqual([call[1] for call in http.calls], ["GET", "POST", "PATCH"])

    def test_unknown_post_is_reconciled_after_restart_and_never_replayed(self):
        http = Http(response({"value": []}), response({"value": [{"id": 2}]}), ConnectionError("accepted but response lost"))
        self.assertEqual(self.publish(self.client(http))["results"][0]["kind"], "failed")
        self.assertEqual([call[1] for call in http.calls], ["GET", "GET", "POST"])
        remote = {**http.calls[2][2], "id": 77}
        restarted = State(Path(self.directory.name), clock=self.clock, sleep=self.clock.sleep)
        no_remote = Http(response({"value": []}))
        client = PrClient("example", Transport(restarted, auth=lambda: "Basic other", send=no_remote))
        self.assertEqual(self.publish(client)["results"][0]["kind"], "failed")
        self.assertEqual(len(no_remote.calls), 1)
        found = Http(response({"value": [remote]}))
        client = PrClient("example", Transport(restarted, auth=lambda: "Basic other", send=found))
        self.assertEqual(self.publish(client)["results"][0], {"kind": "duplicate", "findingId": "finding-1", "remoteThreadId": 77})
        self.assertEqual(len(found.calls), 1)

    def test_definite_rejections_record_receipt_and_allow_later_explicit_retry(self):
        for index, status in enumerate((400, 401, 403, 404, 409, 429, 499)):
            with self.subTest(status=status):
                finding = json.loads(json.dumps(FINDING))
                finding["findingId"] = f"rejected-{index}"
                http = Http(response({"value": []}), response({"value": [{"id": 2}]}),
                            response({}, status, {"retry-after": "5"}))
                client = self.client(http)
                result = self.publish(client, [finding])
                self.assertEqual(result["results"][0]["kind"], "failed")
                self.assertEqual([call[1] for call in http.calls], ["GET", "GET", "POST"])
                publisher = Publisher(client, SCOPE)
                self.assertFalse(publisher.has_unknown())
                record = publisher.journal("finding:" + finding["findingId"])
                self.assertEqual(record[0], "rejected")
                self.assertEqual(record[2], {"status": status})
                self.clock.now += 5
                repaired = json.loads(json.dumps(finding))
                repaired["payload"]["comments"][0]["content"] = "Corrected explicit invocation."
                later = Http(response({"value": []}), response({"value": [{"id": 2}]}), response({"id": 90 + index}))
                result = self.publish(self.client(later), [repaired])["results"][0]
                self.assertEqual(result["kind"], "published")
                self.assertEqual([call[1] for call in later.calls], ["GET", "GET", "POST"])
                self.assertEqual(publisher.journal("finding:" + finding["findingId"])[0], "confirmed")

    def test_all_client_error_write_responses_are_rejected_without_retry(self):
        for method in ("POST", "PATCH", "PUT", "DELETE"):
            for status in range(400, 500):
                with self.subTest(method=method, status=status):
                    http = Http(response({}, status))
                    with self.assertRaises(WriteRejected) as rejected:
                        self.client(http).transport.json(SCOPE.base + "/threads?api-version=7.1", method, b"{}")
                    self.assertEqual(rejected.exception.status, status)
                    self.assertEqual(rejected.exception.code, "write_rejected")
                    self.assertEqual([call[1] for call in http.calls], [method])
                    self.clock.now += 5

    def test_server_errors_and_transport_failures_leave_publication_unknown(self):
        failures = [response({}, status) for status in (500, 502, 503, 504, 599)]
        failures.extend((ConnectionError("accepted but lost"), TimeoutError("response lost")))
        for index, failure in enumerate(failures):
            with self.subTest(failure=failure):
                finding = json.loads(json.dumps(FINDING))
                finding["findingId"] = f"ambiguous-{index}"
                http = Http(response({"value": []}), response({"value": [{"id": 2}]}), failure)
                client = self.client(http)
                publisher = Publisher(client, SCOPE)
                result = self.publish(client, [finding])
                self.assertEqual(result["results"][0]["kind"], "failed")
                self.assertEqual([call[1] for call in http.calls], ["GET", "GET", "POST"])
                self.assertTrue(publisher.has_unknown())
                self.assertEqual(publisher.journal("finding:" + finding["findingId"])[0], "unknown")
                self.clock.now += 5
                later = Http(response({"value": []}))
                self.assertEqual(self.publish(self.client(later))["results"][0]["kind"], "failed")
                self.assertEqual([call[1] for call in later.calls], ["GET"])
                with self.state.connect() as db:
                    db.execute("DELETE FROM journal")

    def test_server_error_writes_and_client_error_reads_are_not_write_rejections(self):
        for method, statuses in (("POST", range(500, 600)), ("GET", (404, 409))):
            for status in statuses:
                with self.subTest(method=method, status=status):
                    http = Http(response({}, status))
                    with self.assertRaises(AdoError) as failure:
                        self.client(http).transport.request(SCOPE.base + "/threads?api-version=7.1", method)
                    self.assertNotIsInstance(failure.exception, WriteRejected)
                    self.assertEqual([call[1] for call in http.calls], [method])
                    self.clock.now += 5

    def test_duplicate_batch_entries_do_not_automatically_retry_rejected_post(self):
        http = Http(response({"value": []}), response({"value": [{"id": 2}]}), response({}, 429, {"retry-after": "5"}))
        result = self.publish(self.client(http), [FINDING, FINDING])
        self.assertEqual([entry["kind"] for entry in result["results"]], ["failed", "failed"])
        self.assertEqual([call[1] for call in http.calls], ["GET", "GET", "POST"])
        self.assertEqual(self.clock.sleeps, [])
        self.assertFalse(Publisher(self.client(Http()), SCOPE).has_unknown())

    def test_rejection_stops_new_batch_writes_but_does_not_poison_other_findings(self):
        second = json.loads(json.dumps(FINDING))
        second["findingId"] = "another-finding"
        second["payload"]["comments"][0]["content"] = "A different finding."
        http = Http(response({"value": []}), response({"value": [{"id": 2}]}), response({}, 400))
        result = self.publish(self.client(http), [FINDING, second])
        self.assertEqual([entry["kind"] for entry in result["results"]], ["failed", "failed"])
        self.assertEqual([call[1] for call in http.calls], ["GET", "GET", "POST"])
        later = Http(response({"value": []}), response({"value": [{"id": 2}]}), response({"id": 92}))
        self.assertEqual(self.publish(self.client(later), [second])["results"][0]["kind"], "published")
        self.assertEqual([call[1] for call in later.calls], ["GET", "GET", "POST"])

    def test_transport_rejection_is_structured_but_lost_response_remains_ambiguous(self):
        http = Http(response({}, 403))
        with self.assertRaises(WriteRejected) as rejected:
            self.client(http).transport.json(SCOPE.base + "/threads?api-version=7.1", "POST", b"{}")
        self.assertEqual(rejected.exception.status, 403)
        self.assertEqual(rejected.exception.code, "write_rejected")
        self.assertEqual(len(http.calls), 1)
        http = Http(ConnectionError("accepted but lost"))
        with self.assertRaises(AdoError) as ambiguous:
            self.client(http).transport.json(SCOPE.base + "/threads?api-version=7.1", "POST", b"{}")
        self.assertNotIsInstance(ambiguous.exception, WriteRejected)
        self.assertIn("unknown", str(ambiguous.exception))
        self.assertEqual(len(http.calls), 1)

    def test_rejected_reply_can_be_explicitly_retried_without_poisoning_pr(self):
        args = argparse.Namespace(id="42", thread_id="7", content="  user reply\n\n",
                                  status="fixed", user_authored=True)
        http = Http(response(DETAILS), response({"comments": []}), response({}, 429, {"retry-after": "5"}))
        with patch.object(pr_script, "cli_client", return_value=self.client(http)), self.assertRaises(WriteRejected):
            pr_script.reply_and_resolve(args)
        self.assertEqual([call[1] for call in http.calls], ["GET", "GET", "POST"])
        with self.state.connect() as db:
            phase, receipt = db.execute("SELECT phase,receipt FROM journal").fetchone()
        self.assertEqual((phase, json.loads(receipt)), ("rejected", {"status": 429}))
        self.clock.now += 5
        later = Http(response(DETAILS), response({"comments": []}),
                     response({"id": 8, "content": args.content}), response({"id": 7, "status": 2}))
        output = StringIO()
        with patch.object(pr_script, "cli_client", return_value=self.client(later)), redirect_stdout(output):
            pr_script.reply_and_resolve(args)
        self.assertEqual([call[1] for call in later.calls], ["GET", "GET", "POST", "PATCH"])
        self.assertEqual(later.calls[2][2]["content"], args.content)
        self.assertEqual(json.loads(output.getvalue())["thread"]["status"], 2)

    def test_unknown_post_blocks_different_findings_until_reconciliation(self):
        second = {"findingId": "finding-2", "payload": {**FINDING["payload"],
                  "comments": [{"parentCommentId": 0, "content": "Other bug", "commentType": 1}]}}
        http = Http(response({"value": []}), response({"value": [{"id": 2}]}), ConnectionError("accepted but lost"))
        self.assertEqual([item["kind"] for item in self.publish(self.client(http), [FINDING, second])["results"]], ["failed", "failed"])
        self.assertEqual([call[1] for call in http.calls], ["GET", "GET", "POST"])
        remote = {**http.calls[2][2], "id": 90}
        http = Http(response({"value": [remote]}), response({"value": [{"id": 2}]}), response({"id": 91}))
        self.assertEqual(self.publish(self.client(http), [second])["results"][0]["kind"], "published")
        self.assertEqual([call[1] for call in http.calls], ["GET", "GET", "POST"])

    def test_exact_normalized_text_and_anchor_duplicate_without_marker(self):
        remote = {**FINDING["payload"], "id": 75,
                  "comments": [{"content": " **Bug** \t\r\n\t\r\nFix it.\t\n\n- Generated with AI 🤖"}]}
        http = Http(response({"value": [remote]}))
        self.assertEqual(self.publish(self.client(http))["results"][0]["remoteThreadId"], 75)
        self.assertEqual(len(http.calls), 1)

    def test_legacy_duplicate_ignores_later_replies_after_first_nondeleted_comment(self):
        for index, first in enumerate(("Different concern", "**Bug**\n\nFix   it.", "**Bug**\nFix it."), 1):
            with self.subTest(first=first):
                finding = json.loads(json.dumps(FINDING))
                finding["findingId"] = f"finding-{index}"
                finding["payload"]["comments"][0]["content"] = finding["payload"]["comments"][0]["content"].replace(
                    "finding-1", finding["findingId"])
                remote = {**FINDING["payload"], "id": 75,
                          "comments": [{"content": " \t\r\n", "isDeleted": True}, {"content": first},
                                       {"content": finding["payload"]["comments"][0]["content"]}]}
                http = Http(response({"value": [remote]}), response({"value": [{"id": 2}]}), response({"id": 91}))
                result = self.publish(self.client(http), [finding])
                self.assertEqual(result["results"][0]["kind"], "published")
                self.assertEqual([call[1] for call in http.calls], ["GET", "GET", "POST"])

    def test_deleted_comments_are_skipped_before_exact_marker_match(self):
        remote = {**FINDING["payload"], "id": 75,
                  "comments": [{"content": None, "isDeleted": True}, {"content": " \t\r\n", "isDeleted": True},
                               {"content": "<!-- paired-review-finding:finding-1 -->"}]}
        http = Http(response({"value": [remote]}))
        self.assertEqual(self.publish(self.client(http))["results"][0]["kind"], "duplicate")
        self.assertEqual(len(http.calls), 1)

    def test_first_live_blank_comment_does_not_legacy_match_a_later_reply(self):
        remote = {**FINDING["payload"], "id": 75,
                  "comments": [{"content": " \t\r\n"}, {"content": "**Bug**\n\nFix it."}]}
        http = Http(response({"value": [remote]}), response({"value": [{"id": 2}]}), response({"id": 91}))
        self.assertEqual(self.publish(self.client(http))["results"][0]["kind"], "published")
        self.assertEqual([call[1] for call in http.calls], ["GET", "GET", "POST"])

    def test_first_nondeleted_comment_legacy_matches_but_deleted_content_does_not(self):
        remote = {**FINDING["payload"], "id": 75,
                  "comments": [{"content": "Different deleted concern", "isDeleted": True},
                               {"content": "**Bug**\n\nFix it."}, {"content": "Later unrelated reply"}]}
        http = Http(response({"value": [remote]}))
        self.assertEqual(self.publish(self.client(http))["results"][0]["kind"], "duplicate")
        self.assertEqual(len(http.calls), 1)

    def test_unknown_write_marker_reconciliation_may_scan_later_live_comments(self):
        http = Http(response({"value": []}), response({"value": [{"id": 2}]}), ConnectionError("accepted but response lost"))
        self.assertEqual(self.publish(self.client(http))["results"][0]["kind"], "failed")
        submitted = http.calls[2][2]["comments"][0]["content"]
        remote = {**FINDING["payload"], "id": 75,
                  "comments": [{"content": "Root was edited after publication"}, {"content": submitted}]}
        recovered = Http(response({"value": [remote]}))
        result = self.publish(self.client(recovered))["results"][0]
        self.assertEqual(result, {"kind": "duplicate", "findingId": "finding-1", "remoteThreadId": 75})
        self.assertEqual([call[1] for call in recovered.calls], ["GET"])

    def test_auto_payload_scratch_uses_os_default_without_allocating_during_test(self):
        directory = Path.cwd() / "mocked-runtime-scratch"
        with patch.object(ado.tempfile, "mkdtemp", return_value=str(directory)) as allocate:
            self.assertEqual(ado.resolve_out_file("auto", "ado-thread-"), directory / "thread.json")
        allocate.assert_called_once_with(prefix="ado-thread-")
        self.assertEqual(ado.resolve_out_file("relative-output.json", "unused"), Path("relative-output.json"))

    def test_duplicate_marker_is_case_sensitive_and_not_removed_broadly(self):
        for index, content in enumerate(("<!-- Paired-review-finding:finding-1 -->",
                                        "<!-- paired-review-finding:FINDING-1 -->",
                                        "**Bug**\n\nFix it.\n\n<!-- paired-review-finding:FINDING-1 -->"), 1):
            with self.subTest(content=content):
                finding = json.loads(json.dumps(FINDING))
                finding["findingId"] = f"finding-{index}"
                finding["payload"]["comments"][0]["content"] = finding["payload"]["comments"][0]["content"].replace(
                    "finding-1", finding["findingId"])
                content = content.replace("finding-1", finding["findingId"]).replace("FINDING-1", finding["findingId"].upper())
                remote = {**FINDING["payload"], "id": 75, "comments": [{"content": content}]}
                http = Http(response({"value": [remote]}), response({"value": [{"id": 2}]}), response({"id": 91}))
                self.assertEqual(self.publish(self.client(http), [finding])["results"][0]["kind"], "published")
                self.assertEqual([call[1] for call in http.calls], ["GET", "GET", "POST"])

    def test_duplicate_text_preserves_interior_whitespace_and_normalizes_nfc(self):
        finding = json.loads(json.dumps(FINDING))
        finding["payload"]["comments"][0]["content"] = "**Café**\n\nFix it."
        remote = {**finding["payload"], "id": 75,
                  "comments": [{"content": "**Cafe\u0301**\r\n\r\nFix it.\t\r\n\r\n🤖 Generated with AI"}]}
        http = Http(response({"value": [remote]}))
        self.assertEqual(self.publish(self.client(http), [finding])["results"][0]["kind"], "duplicate")
        self.assertEqual(len(http.calls), 1)

    def test_reply_receipt_resume_patch_without_duplicate_post_and_preserve_user_text(self):
        args = argparse.Namespace(id="42", thread_id="7", content="  User text\n\n", status="fixed", user_authored=True)
        http = Http(response(DETAILS), response({"comments": []}), response({"id": 8, "content": args.content}), response({}, 503))
        with patch.object(pr_script, "cli_client", return_value=self.client(http)), self.assertRaises(AdoError):
            pr_script.reply_and_resolve(args)
        self.assertEqual([call[1] for call in http.calls], ["GET", "GET", "POST", "PATCH"])
        self.assertEqual(http.calls[2][2]["content"], args.content)
        self.clock.now += 2
        http = Http(response(DETAILS), response({"id": 7, "status": "fixed"}))
        output = StringIO()
        with patch.object(pr_script, "cli_client", return_value=self.client(http)), redirect_stdout(output):
            pr_script.reply_and_resolve(args)
        self.assertEqual([call[1] for call in http.calls], ["GET", "PATCH"])
        self.assertEqual(json.loads(output.getvalue())["reply"]["id"], 8)
        http = Http(response(DETAILS))
        with patch.object(pr_script, "cli_client", return_value=self.client(http)), redirect_stdout(StringIO()):
            pr_script.reply_and_resolve(args)
        self.assertEqual([call[1] for call in http.calls], ["GET"])
        args.status = "closed"
        http = Http(response(DETAILS), response({"id": 7, "status": 4}))
        with patch.object(pr_script, "cli_client", return_value=self.client(http)), redirect_stdout(StringIO()):
            pr_script.reply_and_resolve(args)
        self.assertEqual([call[1] for call in http.calls], ["GET", "PATCH"])

    def test_success_shaped_but_incomplete_patch_keeps_reply_receipt_for_resume(self):
        http = Http(response({"comments": []}), response({"id": 8}), response({"id": 7, "status": "active"}))
        with self.assertRaisesRegex(AdoError, "resume PATCH"):
            Publisher(self.client(http), SCOPE).reply_and_resolve(7, "Fixed", "fixed", False)
        self.assertEqual([call[1] for call in http.calls], ["GET", "POST", "PATCH"])
        http = Http(response({"id": 7, "status": 2}))
        self.assertEqual(Publisher(self.client(http), SCOPE).reply_and_resolve(7, "Fixed", "fixed", False)["reply"]["id"], 8)
        self.assertEqual([call[1] for call in http.calls], ["PATCH"])

    def test_unknown_reply_reconciliation_ignores_old_matching_comments(self):
        text = "exact"
        publisher = Publisher(self.client(Http(response({"comments": [{"id": 1, "content": text}]}),
                                                ConnectionError("lost"))), SCOPE)
        with self.assertRaises(AdoError):
            publisher.reply_and_resolve(7, text, "fixed", True)
        http = Http(response({"comments": [{"id": 1, "content": text}]}))
        with self.assertRaisesRegex(AdoError, "reconciliation"):
            Publisher(self.client(http), SCOPE).reply_and_resolve(7, text, "fixed", True)
        self.assertEqual(len(http.calls), 1)
        http = Http(response({"comments": [{"id": 1, "content": text}, {"id": 2, "content": text}]}),
                    response({"id": 7, "status": "fixed"}))
        result = Publisher(self.client(http), SCOPE).reply_and_resolve(7, text, "fixed", True)
        self.assertEqual(result["reply"]["id"], 2)
        self.assertEqual([call[1] for call in http.calls], ["GET", "PATCH"])

    def test_bridge_invalid_origin_is_nonzero_no_stdout_or_secret_echo(self):
        result = subprocess.run([sys.executable, str(SCRIPTS / "ado-bridge.py")],
                                input=json.dumps({"operation": "read", "org": "https://user:private@evil", "resource": "pullRequest", "pullRequestId": 1}),
                                capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertNotIn("private", result.stderr)

    def test_bridge_stdin_stdout_success_and_defer_error_contract(self):
        request = {"operation": "read", "org": ORG, "project": "project", "repositoryId": "repo",
                   "pullRequestId": 42, "resource": "threads"}
        from io import BytesIO
        stdin = type("Input", (), {"buffer": BytesIO(json.dumps(request).encode())})()
        http = Http(response({"value": [{"id": 5}]}, headers={"retry-after": "90"}))
        output = StringIO()
        with patch.object(sys, "stdin", stdin), patch.object(bridge, "PrClient", return_value=self.client(http)), redirect_stdout(output):
            self.assertEqual(bridge.main(), 0)
        self.assertEqual(json.loads(output.getvalue()), {"value": [{"id": 5}], "count": 1})
        stdin.buffer.seek(0)
        output, error = StringIO(), StringIO()
        with patch.object(sys, "stdin", stdin), patch.object(sys, "stderr", error), patch.object(bridge, "PrClient", return_value=self.client(http)), redirect_stdout(output):
            self.assertEqual(bridge.main(), 2)
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(json.loads(error.getvalue())["retryAt"], 1090)
        self.assertTrue(json.loads(error.getvalue())["deferred"])
        self.assertEqual(len(http.calls), 1)

    def test_bridge_oversized_item_has_explicit_code_and_byte_limit(self):
        from io import BytesIO
        request = {"operation": "read", "org": ORG, "project": "project", "resource": "item",
                   "repositoryId": "repo", "path": "/large.py", "commit": "a" * 40}
        for outcome in (response({"content": "x" * (2097152 + 1)}),
                        AdoError("response exceeds 8388608 bytes", code="response_too_large")):
            stdin = type("Input", (), {"buffer": BytesIO(json.dumps(request).encode())})()
            output, error = StringIO(), StringIO()
            http = Http(outcome)
            with patch.object(sys, "stdin", stdin), patch.object(sys, "stderr", error), \
                    patch.object(bridge, "PrClient", return_value=self.client(http)), redirect_stdout(output):
                self.assertEqual(bridge.main(), 1)
            self.assertEqual(output.getvalue(), "")
            payload = json.loads(error.getvalue())
            self.assertEqual(payload["code"], "content_too_large")
            self.assertIn("exceeds", payload["error"])
            self.assertIn("bytes", payload["error"])
            self.assertEqual(len(http.calls), 1)

    def test_incomplete_builds_and_changes_are_explicit_errors(self):
        for build in ({"id": 1}, {"id": 1, "sourceVersion": "merge", "status": "completed"}):
            with self.assertRaisesRegex(AdoError, "incomplete"):
                self.client(Http(response({"value": [build]}))).builds(SCOPE, DETAILS)
        request = {"operation": "read", "org": ORG, "project": "project", "repositoryId": "repo",
                   "pullRequestId": 42, "resource": "changes", "iterationId": 3}
        with self.assertRaisesRegex(AdoError, "did not advance"):
            bridge.dispatch(request, self.client(Http(response({"changeEntries": [], "nextSkip": 0, "nextTop": 1}))))


class MultiprocessTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(dir=Path.cwd())
        self.addCleanup(self.directory.cleanup)
        self.state = State(Path(self.directory.name))
        self.context = multiprocessing.get_context("spawn")
        self.children = []
        self.addCleanup(self.clean_children)

    def clean_children(self):
        for process in self.children:
            if process.is_alive():
                process.terminate()
            process.join(5)

    def launch(self, target, args):
        process = self.context.Process(target=target, args=args)
        process.start()
        self.children.append(process)
        return process

    def test_live_admissions_not_reclaimed_by_age_and_crash_releases_slot(self):
        ready, release = self.context.Queue(), self.context.Event()
        for _ in range(4):
            self.launch(hold_gate, (self.directory.name, ready, release))
        for _ in range(4):
            ready.get(timeout=15)
        with self.assertRaisesRegex(AdoError, "admission wait"):
            with self.state.admit("example", time.time() + 0.15):
                self.fail("live permit was reclaimed")
        self.children[0].terminate()
        self.children[0].join(5)
        with self.state.admit("example", time.time() + 1):
            with self.state.connect() as db:
                self.assertEqual(db.execute("SELECT count(*) FROM admission").fetchone()[0], 4)
        (Path(self.directory.name) / "release").touch()
        for process in self.children[1:]:
            process.join(10)
            self.assertEqual(process.exitcode, 0)

    def test_writer_lock_survives_elapsed_time_but_not_process_crash(self):
        ready, release = self.context.Queue(), self.context.Event()
        process = self.launch(hold_writer, (self.directory.name, ready, release))
        ready.get(timeout=10)
        clock = Clock()
        state = State(Path(self.directory.name), clock=clock, sleep=clock.sleep)
        with self.assertRaisesRegex(AdoError, "still owns"):
            with state.lock(SCOPE.lock_key, wait=100):
                self.fail("live writer was reclaimed")
        process.terminate()
        process.join(5)
        with state.lock(SCOPE.lock_key, wait=0):
            pass

    def concurrent_callers(self, worker, count=3):
        with self.state.connect() as db:
            db.execute("CREATE TABLE requests(method TEXT)")
            db.execute("CREATE TABLE remote_threads(payload TEXT)")
        ready, start, result = self.context.Queue(), self.context.Event(), self.context.Queue()
        processes = [self.launch(worker, (self.directory.name, ready, start, result)) for _ in range(count)]
        for _ in processes:
            ready.get(timeout=15)
        start.set()
        results = [result.get(timeout=15) for _ in processes]
        for process in processes:
            process.join(10)
            self.assertEqual(process.exitcode, 0)
        return results

    def test_immutable_cache_cross_process_coalesces_one_external_get(self):
        results = self.concurrent_callers(cache_worker)
        self.assertEqual(results, [{"content": "immutable"}] * 3)
        with self.state.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM requests").fetchone()[0], 1)

    def test_immutable_cache_cross_process_different_credentials_do_not_share(self):
        with self.state.connect() as db:
            db.execute("CREATE TABLE requests(method TEXT)")
        ready, start, result = self.context.Queue(), self.context.Event(), self.context.Queue()
        for auth in ("Basic principal-a", "Basic principal-b"):
            process = self.launch(cache_worker, (self.directory.name, ready, start, result, auth))
            ready.get(timeout=10)
            start.set()
            self.assertEqual(result.get(timeout=10), {"content": "immutable"})
            process.join(10)
            self.assertEqual(process.exitcode, 0)
        with self.state.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM requests").fetchone()[0], 2)
            self.assertEqual(db.execute("SELECT count(*) FROM cache").fetchone()[0], 2)

    def test_publication_cross_process_single_post_and_complete_reads(self):
        results = self.concurrent_callers(publish_worker)
        self.assertEqual(sorted(result["results"][0]["kind"] for result in results), ["duplicate", "duplicate", "published"])
        with self.state.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM requests WHERE method='POST'").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT count(*) FROM requests WHERE method='GET'").fetchone()[0], 4)
            self.assertEqual(db.execute("SELECT count(*) FROM remote_threads").fetchone()[0], 1)

    def test_process_crash_after_accepted_post_reconciles_durable_unknown_journal(self):
        with self.state.connect() as db:
            db.execute("CREATE TABLE requests(method TEXT)")
            db.execute("CREATE TABLE remote_threads(payload TEXT)")
        process = self.launch(accepted_post_crash, (self.directory.name,))
        process.join(10)
        self.assertEqual(process.exitcode, 19)
        with self.state.connect() as db:
            self.assertEqual(db.execute("SELECT phase FROM journal").fetchone()[0], "unknown")
            remote = json.loads(db.execute("SELECT payload FROM remote_threads").fetchone()[0])
        http = Http(response({"value": [remote]}))
        client = PrClient("example", Transport(self.state, auth=lambda: "Basic other", send=http))
        result = bridge.dispatch({"operation": "publish", "org": ORG, "project": "project",
                                  "repositoryId": "repo", "pullRequestId": 42, "findings": [FINDING]}, client)
        self.assertEqual(result["results"][0]["kind"], "duplicate")
        self.assertEqual(result["results"][0]["remoteThreadId"], 101)
        self.assertEqual([call[1] for call in http.calls], ["GET"])
        with self.state.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM requests WHERE method='POST'").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT phase FROM journal").fetchone()[0], "confirmed")

if __name__ == "__main__":
    unittest.main()
