from __future__ import annotations

import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))

from shared.pr import PrClient
from shared.transport import AdoError, Deferred, Response, State, Transport

spec = importlib.util.spec_from_file_location("batch_bridge", SCRIPTS / "ado-bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


def request(count=8):
    return {
        "operation": "readItems", "org": "example", "project": "project", "repositoryId": "repo",
        "items": [{"path": f"/file-{index}.py", "commit": "a" * 40} for index in range(count)],
    }


class BatchItemsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.state = State(self.directory)
        self.auth_calls = 0
        self.http_calls = 0

    def tearDown(self):
        self.temporary.cleanup()

    def auth(self):
        self.auth_calls += 1
        return "Basic fixture"

    def send(self, url, method, body, headers):
        self.http_calls += 1
        self.assertEqual(method, "GET")
        self.assertIsNone(body)
        with self.state.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM admission").fetchone()[0], 1)
        return Response(200, {}, json.dumps({"content": "日本語 🤖\n", "ignored": "metadata"}).encode())

    def client(self, send=None):
        return PrClient("example", Transport(self.state, auth=self.auth, send=send or self.send))

    def test_one_transport_and_credential_lookup_for_misses_and_cache_hits(self):
        batch = request()
        first = bridge.dispatch(batch, self.client())
        self.assertEqual(first["results"], [{"kind": "text", "content": "日本語 🤖\n"}] * 8)
        self.assertEqual((self.auth_calls, self.http_calls), (1, 8))
        self.assertEqual(bridge.dispatch(batch, self.client()), first)
        self.assertEqual((self.auth_calls, self.http_calls), (2, 8))

    def test_exact_order_and_explicit_errors_do_not_become_binary(self):
        outcomes = iter([
            Response(200, {}, b'{"content":"first"}'),
            Response(200, {}, b'{"contentMetadata":{"isBinary":true}}'),
            AdoError("item response exceeds limit", code="response_too_large"),
            Response(403, {}, b""),
            Deferred(time.time() + 120),
            Response(200, {}, b'{"content":"last"}'),
        ])

        def send(*args):
            outcome = next(outcomes)
            if isinstance(outcome, Exception):
                raise outcome
            return outcome

        results = bridge.dispatch(request(6), self.client(send))["results"]
        self.assertEqual(results[0], {"kind": "text", "content": "first"})
        self.assertEqual(results[1], {"kind": "binary"})
        self.assertEqual(results[2]["code"], "content_too_large")
        self.assertEqual(results[3], {"kind": "error", "error": "Azure DevOps HTTP 403"})
        self.assertEqual(results[4]["kind"], "error")
        self.assertTrue(results[4]["deferred"])
        self.assertGreater(results[4]["retryAt"], time.time())
        self.assertEqual(results[5], {"kind": "text", "content": "last"})

    def test_invalid_batches_fail_before_creating_owner_or_reading(self):
        invalid = [
            {**request(), "items": []}, request(9),
            {**request(1), "project": ""},
            {**request(1), "repositoryId": "r" * 4097},
            {**request(1), "extra": True},
            {**request(1), "items": [{"path": "/", "commit": "branch"}]},
            {**request(1), "items": [{"path": "x" * 4097, "commit": "a" * 40}]},
            {**request(1), "items": [{"path": "/", "commit": "a" * 40, "org": "other"}]},
        ]
        for batch in invalid:
            with self.subTest(batch=batch), patch.object(bridge, "PrClient") as owner:
                with self.assertRaises(AdoError):
                    bridge.dispatch(batch)
                owner.assert_not_called()

    def test_missing_content_is_binary_only_with_explicit_binary_metadata(self):
        client = self.client()
        for payload in ({}, {"content": None}, {"contentMetadata": {"isBinary": False}},
                        {"contentMetadata": {"isBinary": 1}}, {"contentMetadata": "invalid"}):
            with self.subTest(payload=payload), patch.object(client, "read", return_value=payload):
                self.assertEqual(bridge.dispatch(request(1), client)["results"], [
                    {"kind": "error", "error": "item content is incomplete"},
                ])
        with patch.object(client, "read", return_value={"contentMetadata": {"isBinary": True}}):
            self.assertEqual(bridge.dispatch(request(1), client)["results"], [{"kind": "binary"}])
        with patch.object(client, "read", return_value={"content": ""}):
            self.assertEqual(bridge.dispatch(request(1), client)["results"], [{"kind": "text", "content": ""}])

    def test_decoded_content_and_error_sizes_are_bounded(self):
        outcomes = iter([
            {"content": "é" * (bridge.MAX_ITEM_CONTENT_BYTES // 2)},
            {"content": "é" * (bridge.MAX_ITEM_CONTENT_BYTES // 2 + 1)},
            AdoError("x" * 10000, code="y" * 10000),
        ])
        client = self.client()

        def read(_):
            outcome = next(outcomes)
            if isinstance(outcome, Exception):
                raise outcome
            return outcome

        with patch.object(client, "read", side_effect=read):
            results = bridge.dispatch(request(3), client)["results"]
        self.assertEqual(results[0]["kind"], "text")
        self.assertEqual(results[1]["code"], "content_too_large")
        self.assertEqual(len(results[2]["error"]), 1024)
        self.assertEqual(len(results[2]["code"]), 1024)

    def test_ascii_output_and_streaming_memory_bound(self):
        class CountingOutput:
            def __init__(self):
                self.size = 0
                self.largest_chunk = 0

            def write(self, value):
                self.assert_ascii(value)
                self.size += len(value)
                self.largest_chunk = max(self.largest_chunk, len(value))

            @staticmethod
            def assert_ascii(value):
                value.encode("ascii")

        output = CountingOutput()
        client = self.client()
        content = "\x01" * bridge.MAX_ITEM_CONTENT_BYTES
        stdin = io.TextIOWrapper(io.BytesIO(json.dumps(request()).encode()), encoding="utf-8")
        with patch.object(client, "read", return_value={"content": content}), \
                patch.object(bridge, "PrClient", return_value=client), \
                patch.object(sys, "stdin", stdin), patch.object(sys, "stdout", output):
            self.assertEqual(bridge.main(), 0)
        self.assertLessEqual(output.size, bridge.MAX_ITEM_BATCH_OUTPUT_BYTES)
        self.assertGreater(output.size, 32 * 1024 * 1024)
        self.assertLessEqual(output.largest_chunk, bridge.MAX_ITEM_CONTENT_BYTES * 6 + 2)

    def test_total_deadline_never_returns_partial_success(self):
        now = [0.0]
        state = State(self.directory, clock=lambda: now[0])

        def send(*args):
            now[0] += 2
            return Response(200, {}, b'{"content":"ok"}')

        client = PrClient("example", Transport(state, auth=self.auth, send=send), read_timeout=1)
        with self.assertRaises(AdoError) as raised:
            bridge.dispatch(request(2), client)
        self.assertEqual(raised.exception.code, "incomplete_read")

    def test_independent_batch_owners_still_share_four_global_permits(self):
        active = maximum = 0
        condition = threading.Condition()
        release = threading.Event()
        waiting = set()

        def wait_for_permit(_delay):
            with condition:
                waiting.add(threading.get_ident())
                condition.notify_all()
            self.assertTrue(release.wait(15), "admission waiter was not released")

        self.state.sleep = wait_for_permit

        def send(*args):
            nonlocal active, maximum
            with condition:
                active += 1
                maximum = max(maximum, active)
                condition.notify_all()
            try:
                with self.state.connect() as db:
                    self.assertLessEqual(db.execute("SELECT count(*) FROM admission").fetchone()[0], 4)
                self.assertTrue(release.wait(15), "active request was not released")
            finally:
                with condition:
                    active -= 1
            return Response(200, {}, b'{"content":"ok"}')

        def run(index):
            batch = request(1)
            batch["items"][0]["path"] = f"/owner-{index}"
            return bridge.dispatch(batch, self.client(send))

        with patch.object(self.state, "lock", wraps=self.state.lock) as cache_locks, \
                ThreadPoolExecutor(max_workers=6) as workers:
            futures = [workers.submit(run, index) for index in range(6)]
            try:
                with condition:
                    self.assertTrue(condition.wait_for(
                        lambda: active == 4 and len(waiting) == 2, timeout=10,
                    ), "expected four active requests and two admission waiters")
                    self.assertEqual(maximum, 4)
                # Distinct cache stripes ensure the other owners wait for admission, not cache locks.
                self.assertEqual(len({call.args[0] for call in cache_locks.call_args_list}), 6)
                with self.state.connect() as db:
                    self.assertEqual(db.execute(
                        "SELECT count(*), count(DISTINCT owner) FROM admission",
                    ).fetchone(), (4, 4))
            finally:
                release.set()
            results = [future.result(timeout=15) for future in futures]
        self.assertEqual(results, [{"results": [{"kind": "text", "content": "ok"}]}] * 6)
        self.assertEqual(maximum, 4)
        with self.state.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM admission").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
