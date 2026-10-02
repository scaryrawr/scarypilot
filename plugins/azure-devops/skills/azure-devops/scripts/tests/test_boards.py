from __future__ import annotations

import argparse
import importlib.util
import json
import shlex
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import BytesIO, StringIO, TextIOWrapper
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))

from shared import ado, boards
from shared.pr import PrClient
from shared.transport import AdoError, Deferred, Response, State, Transport


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), SCRIPTS / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bridge = load("ado-bridge.py")
cli = load("ado-work-items.py")
PROJECT = "Project & 日本語"
SCOPE = {"org": "https://EXAMPLE.visualstudio.com/DefaultCollection", "project": PROJECT}
SEARCH = {"operation": "workItemSearch", **SCOPE, "text": "login"}
QUERY = {"operation": "workItemQuery", **SCOPE, "wiql": "SELECT [System.Id] FROM WorkItems"}
GET = {"operation": "workItemGet", **SCOPE, "id": 42, "fields": ["System.Title"]}
ITEM_URL = "https://dev.azure.com/example/_apis/wit/workItems/42"


def search_entry(item_id=42, **fields):
    return {"project": {"name": PROJECT}, "fields": {
        "system.id": str(item_id), "system.title": "Login error", "system.workitemtype": "Bug",
        "system.state": "Active", **fields,
    }}


def query_result(items=None):
    return {"queryType": "flat", "queryResultType": "workItem", "asOf": "2026-10-01T00:00:00Z",
            "columns": [{"referenceName": "System.Id", "name": "ID"}],
            "workItems": [{"id": 42, "url": ITEM_URL}] if items is None else items}


def ownership_result(*ids, project=PROJECT):
    return {"count": len(ids), "value": [
        {"id": item_id, "fields": {"System.TeamProject": project}} for item_id in ids
    ]}


def get_result(**updates):
    return {"id": 42, "rev": 3, "url": ITEM_URL,
            "fields": {"System.Title": "Login error", "System.TeamProject": PROJECT}, **updates}

SELECTED_GET_RESULT = {"id": 42, "rev": 3, "url": ITEM_URL, "fields": {"System.Title": "Login error"}}


def response(payload, status=200, headers=None):
    return Response(status, headers or {}, json.dumps(payload).encode())


class BoardsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.now = 1000.0
        self.sleeps = []
        self.calls = []
        self.auth_calls = 0
        self.outcomes = []
        self.state = State(Path(self.directory.name), clock=lambda: self.now, sleep=self.sleep)
        self.transport = Transport(self.state, auth=self.auth, send=self.send, jitter=lambda: 0)

    def sleep(self, duration):
        self.sleeps.append(duration)
        self.now += duration

    def auth(self):
        self.auth_calls += 1
        return "Basic test"

    def send(self, url, method, body, headers):
        self.calls.append((url, method, json.loads(body) if body else None, headers))
        self.assertTrue(self.outcomes, "unexpected HTTP request")
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        if callable(outcome):
            return outcome()
        return outcome

    def dispatch(self, request, *outcomes):
        self.outcomes.extend(outcomes)
        return bridge.dispatch(request, transport=self.transport)

    def test_invalid_requests_do_not_construct_owner_or_touch_credentials_or_http(self):
        invalid_scope = [
            {"org": ""}, {"org": " "}, {"org": "https://dev.azure.com/example/project"},
            {"org": "https://dev.azure.com/example?secret=x"}, {"org": "https://evil.invalid/example"},
            {"org": "http://dev.azure.com/example"}, {"org": "https://user@dev.azure.com/example"},
            {"project": ""}, {"project": "  "}, {"project": "."}, {"project": ".."},
            {"project": "one/two"}, {"project": "one\\two"}, {"project": "%2Fescape"},
            {"project": "%252e%252e"}, {"project": "Project\n"}, {"extra": True},
            {"project": "%2f%"}, {"project": "%2f%ff"}, {"project": "%255c%"},
            {"project": "\ud800"}, {"project": "\udfff"}, {"project": "Project\ud800X"},
        ]
        invalid = [{**request, **change} for request in (SEARCH, QUERY, GET) for change in invalid_scope]
        invalid.extend({**SEARCH, **change} for change in [
            {"text": ""}, {"text": " \n "}, {"text": "x" * 4097}, {"types": []}, {"areas": [" "]},
            {"types": ["Bug"] * 17}, {"top": 0}, {"top": 101}, {"top": True}, {"top": 1.1}, {"top": "25"},
        ])
        invalid.extend({**QUERY, **change} for change in [
            {"wiql": " \t"}, {"wiql": "x" * 32769}, {"top": 0}, {"top": False}, {"top": 1.1}, {"top": "25"},
        ])
        invalid.extend({**GET, **change} for change in [
            {"id": value} for value in (0, -1, 2147483648, True, 1.1, "42")
        ])
        invalid.extend({**GET, **change} for change in [
            {"fields": []}, {"fields": ["invalid"]}, {"fields": ["System.Title"] * 2},
            {"fields": [f"Custom.F{i}" for i in range(33)]},
        ])
        for request in invalid:
            with self.subTest(request=request), patch.object(bridge, "BoardsClient", side_effect=AssertionError("owner constructed")):
                with self.assertRaises(AdoError):
                    bridge.dispatch(request)
        self.assertEqual((self.auth_calls, self.calls), (0, []))

    def test_supplementary_unicode_project_is_valid_and_encodes_before_request(self):
        project = "Project \U0001f680"
        result = self.dispatch({**GET, "project": project},
                               response(get_result(fields={"System.TeamProject": project, "System.Title": "Unicode"})))
        self.assertEqual(result["fields"], {"System.Title": "Unicode"})
        self.assertIn("/Project%20%F0%9F%9A%80/_apis/", self.calls[0][0])

    def test_search_exact_shape_total_count_and_encoded_project_url(self):
        result = self.dispatch({**SEARCH, "types": ["Bug"], "areas": [PROJECT + "\\Client"], "top": 1},
                               response({"count": 30, "results": [search_entry()]}))
        self.assertEqual(result, {
            "count": 30, "results": [{
                "id": 42, "project": PROJECT, "title": "Login error", "type": "Bug", "state": "Active",
                "assignedTo": None, "areaPath": None,
                "url": "https://dev.azure.com/example/Project%20%26%20%E6%97%A5%E6%9C%AC%E8%AA%9E/_workitems/edit/42",
            }], "returnedCount": 1, "limit": 1, "truncated": True,
        })
        self.assertEqual(self.calls[0][:3], (
            "https://almsearch.dev.azure.com/example/_apis/search/workitemsearchresults?api-version=7.1",
            "POST", {"searchText": "login", "$top": 1, "filters": {
                "System.TeamProject": [PROJECT], "System.WorkItemType": ["Bug"], "System.AreaPath": [PROJECT + "\\Client"],
            }},
        ))

    def test_complete_empty_responses_and_missing_service_shapes(self):
        self.assertEqual(self.dispatch(SEARCH, response({"count": 0, "results": []})),
                         {"count": 0, "results": [], "returnedCount": 0, "limit": 25, "truncated": False})
        self.assertEqual(self.dispatch(QUERY, response(query_result([])))["workItems"], [])
        self.assertEqual(len(self.calls), 2)
        for request, payload in [(SEARCH, {}), (SEARCH, {"results": []}), (SEARCH, {"count": 0}),
                                 (QUERY, {}), (QUERY, {"workItems": []}), (GET, {})]:
            with self.subTest(request=request, payload=payload), self.assertRaises(AdoError):
                self.dispatch(request, response(payload))

    def test_search_rejects_invalid_ids_missing_fields_project_and_count_mismatches(self):
        entry = search_entry()
        invalid_entries = [
            {**entry, "fields": {**entry["fields"], "system.id": value}} for value in ("0", "-1", "1.2", True, 1.1, "9" * 5000)
        ]
        invalid_entries.extend([
            {**entry, "project": {"name": "Other"}}, {**entry, "fields": {"system.id": "42"}},
            {**entry, "fields": {**entry["fields"], "system.title": "x" * 65537}},
        ])
        for value in invalid_entries:
            with self.subTest(value=value), self.assertRaises(AdoError):
                self.dispatch(SEARCH, response({"count": 1, "results": [value]}))
        for payload in [
            {"count": True, "results": []}, {"count": -1, "results": []},
            {"count": 0, "results": [entry]}, {"count": 26, "results": [entry] * 26},
            {"count": 2, "results": [entry, entry]}, {"count": 0, "results": [], "infoCode": 1},
        ]:
            with self.subTest(payload=payload), self.assertRaises(AdoError):
                self.dispatch(SEARCH, response(payload))

    def test_query_fetches_top_plus_one_and_returns_only_top_references(self):
        result = self.dispatch({**QUERY, "top": 1}, response(query_result([
            {"id": 42, "url": ITEM_URL}, {"id": 43, "url": ITEM_URL[:-2] + "43"},
        ])), response(ownership_result(43, 42)))
        self.assertEqual(result, {**query_result(), "returnedCount": 1, "limit": 1, "truncated": True})
        self.assertIn("/Project%20%26%20%E6%97%A5%E6%9C%AC%E8%AA%9E/_apis/wit/wiql?", self.calls[0][0])
        self.assertEqual(parse_qs(urlsplit(self.calls[0][0]).query), {"api-version": ["7.1"], "$top": ["2"]})
        self.assertEqual(self.calls[0][1:3], ("POST", {"query": QUERY["wiql"]}))
        self.assertEqual(self.calls[1][:3], (
            "https://dev.azure.com/example/_apis/wit/workitemsbatch?api-version=7.1", "POST",
            {"ids": [42, 43], "fields": ["System.TeamProject"],
             "asOf": "2026-10-01T00:00:00Z", "errorPolicy": "Fail"},
        ))
        self.assertEqual(self.outcomes, [])

    def test_query_cross_project_reference_cannot_pollute_bounded_top(self):
        request = {**QUERY, "top": 1, "wiql": (
            "SELECT [System.Id] FROM WorkItems WHERE "
            "([System.TeamProject] = @Project AND [System.State] = 'Active') "
            "OR [System.Title] = 'Other project'"
        )}
        wiql_payload = {
            "queryType": "flat", "queryResultType": "workItem", "asOf": "2026-10-01T00:00:00Z",
            "columns": [{"referenceName": "System.Id", "name": "ID"}],
            "workItems": [
                {"id": 7, "url": "https://dev.azure.com/example/_apis/wit/workItems/7"},
                {"id": 42, "url": "https://dev.azure.com/example/_apis/wit/workItems/42"},
            ],
        }
        ownership_payload = {"count": 2, "value": [
            {"id": 7, "fields": {"System.TeamProject": "Other"}},
            {"id": 42, "fields": {"System.TeamProject": "Project & 日本語"}},
        ]}
        with self.assertRaisesRegex(AdoError, "query project mismatch"):
            self.dispatch(request, response(wiql_payload), response(ownership_payload))

    def test_query_cross_project_sentinel_fails_instead_of_false_truncation(self):
        references = [{"id": 42, "url": ITEM_URL}, {"id": 43, "url": ITEM_URL[:-2] + "43"}]
        owners = ownership_result(42, 43)
        owners["value"][1]["fields"]["System.TeamProject"] = "Other"
        with self.assertRaisesRegex(AdoError, "query project mismatch") as error:
            self.dispatch({**QUERY, "top": 1}, response(query_result(references)), response(owners))
        self.assertEqual(error.exception.code, "unsupported_query")

    def test_query_preserves_arbitrary_wiql_without_regex_scope_assumptions(self):
        queries = [
            "SELECT [System.Id] FROM WorkItems",
            "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'Other'",
            "SELECT [System.Id] FROM WorkItems WHERE ([System.TeamProject] = @Project AND "
            "([System.State] = 'Active' OR [System.Title] = 'AND OR WHERE ''quoted'''))",
            "SELECT [System.Id] FROM WorkItems /* [System.TeamProject] = @Project */ "
            "WHERE [System.Title] = '[System.TeamProject] = @Project' -- OR in comment\n",
        ]
        for wiql in queries:
            with self.subTest(wiql=wiql):
                start = len(self.calls)
                result = self.dispatch({**QUERY, "wiql": wiql}, response(query_result()),
                                       response(ownership_result(42)))
                self.assertEqual(self.calls[start][2], {"query": wiql})
                self.assertEqual(result, {**query_result(), "returnedCount": 1, "limit": 25, "truncated": False})
                self.assertNotIn("fields", result["workItems"][0])

    def test_query_rejects_invalid_or_incomplete_ownership(self):
        invalid = [
            {}, {"count": True, "value": []}, {"count": 1, "value": []},
            ownership_result(), ownership_result(43), ownership_result(42, 42),
            {"count": 1, "value": [None]},
            {"count": 1, "value": [{"id": True, "fields": {"System.TeamProject": PROJECT}}]},
            {"count": 1, "value": [{"id": 42}]},
        ]
        invalid.extend({"count": 1, "value": [{"id": 42, "fields": fields}]} for fields in [
            {}, {"System.TeamProject": None}, {"System.TeamProject": ""},
            {"System.TeamProject": "Other"}, {"System.TeamProject": "one/two"},
            {"System.TeamProject": "x" * 4097},
            {"System.TeamProject": PROJECT, "System.Title": "not requested"},
        ])
        for payload in invalid:
            with self.subTest(payload=payload), self.assertRaises(AdoError):
                self.dispatch(QUERY, response(query_result()), response(payload))
        with self.assertRaisesRegex(AdoError, "duplicate.*ownership IDs"):
            refs = [{"id": 42, "url": ITEM_URL}, {"id": 43, "url": ITEM_URL[:-2] + "43"}]
            self.dispatch(QUERY, response(query_result(refs)), response(ownership_result(42, 42)))

    def test_query_guid_resolves_owner_and_checks_lookup_before_wiql(self):
        guid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        result = self.dispatch({**QUERY, "project": guid}, response({"id": guid, "name": PROJECT}),
                               response(query_result()), response(ownership_result(42, project=PROJECT.lower())))
        self.assertEqual(result["workItems"], query_result()["workItems"])
        self.assertIn("/" + guid + "/_apis/wit/wiql?", self.calls[1][0])
        with self.assertRaisesRegex(AdoError, "project ID mismatch"):
            self.dispatch({**QUERY, "project": guid}, response({"id": "other", "name": PROJECT}))
        with self.assertRaisesRegex(AdoError, "query project mismatch"):
            self.dispatch({**QUERY, "project": guid}, response({"id": guid, "name": PROJECT}),
                          response(query_result()), response(ownership_result(42, project="Other")))

    def test_query_ownership_is_bounded_to_one_batch_at_maximum_top(self):
        refs = [{"id": i, "url": ITEM_URL[:-2] + str(i)} for i in range(1, 102)]
        result = self.dispatch({**QUERY, "top": 100}, response(query_result(refs)),
                               response(ownership_result(*range(1, 102))))
        self.assertEqual([item["id"] for item in result["workItems"]], list(range(1, 101)))
        self.assertEqual((result["returnedCount"], result["limit"], result["truncated"]), (100, 100, True))
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(len(self.calls[1][2]["ids"]), 101)

    def test_query_invalid_wiql_and_failed_ownership_never_return_success(self):
        with self.assertRaisesRegex(AdoError, "HTTP 400"):
            self.dispatch({**QUERY, "wiql": "invalid WIQL"}, response({}, 400))
        with self.assertRaisesRegex(AdoError, "HTTP 404"):
            self.dispatch(QUERY, response(query_result()), response({}, 404))
        def slow():
            self.now += 60
            return response(ownership_result(42))
        with self.assertRaisesRegex(AdoError, "total operation deadline"):
            self.dispatch(QUERY, response(query_result()), slow)

    def test_query_oversized_output_fails_after_ownership_without_slicing_columns(self):
        payload = {**query_result(), "columns": [
            {"referenceName": f"Custom.F{i}", "name": "x" * 65536} for i in range(16)
        ]}
        with self.assertRaisesRegex(AdoError, "exceeds 1 MiB") as error:
            self.dispatch(QUERY, response(payload), response(ownership_result(42)))
        self.assertEqual(error.exception.code, "content_too_large")

    def test_query_rejects_relation_types_instead_of_claiming_empty_flat_result(self):
        for payload in [
            {**query_result(), "queryType": "tree"}, {**query_result(), "queryType": "oneHop"},
            {**query_result(), "workItemRelations": []},
        ]:
            with self.subTest(payload=payload), self.assertRaisesRegex(AdoError, "only flat") as error:
                self.dispatch(QUERY, response(payload))
            self.assertEqual(error.exception.code, "unsupported_query")

    def test_query_rejects_malformed_columns_refs_urls_and_excess_page(self):
        for updates in [
            {"queryResultType": "workItemLink"}, {"asOf": ""}, {"columns": [{"referenceName": "System.Id"}]},
            {"columns": [{"referenceName": "invalid", "name": "ID"}]},
            {"workItems": [{"id": True, "url": ITEM_URL}]}, {"workItems": [{"id": 0, "url": ITEM_URL}]},
            {"workItems": [{"id": 42, "url": "https://evil.invalid/42"}]},
            {"workItems": [{"id": 42, "url": "https://dev.azure.com/other/_apis/wit/workItems/42"}]},
            {"workItems": [{"id": 42, "url": ITEM_URL[:-2] + "43"}]},
            {"workItems": [{"id": 42, "url": ITEM_URL}] * 2},
            {"workItems": [{"id": 42, "url": ITEM_URL}] * 27},
        ]:
            with self.subTest(updates=updates), self.assertRaises(AdoError):
                self.dispatch(QUERY, response({**query_result(), **updates}))

    def test_get_exact_fields_and_ownership_independent_of_url(self):
        result = self.dispatch(GET, response(get_result()))
        self.assertEqual(result, SELECTED_GET_RESULT)
        self.assertEqual(self.calls[0][1], "GET")
        self.assertEqual(parse_qs(urlsplit(self.calls[0][0]).query), {
            "api-version": ["7.1"], "fields": ["System.Title,System.TeamProject"],
        })
        for payload in [
            get_result(id=43), get_result(rev=0), get_result(fields={"System.Title": "Login error"}),
            get_result(fields={"System.TeamProject": "Other", "System.Title": "Login error"}),
            get_result(fields={"System.TeamProject": PROJECT, "Custom.Unrequested": "x"}),
            get_result(fields={"System.TeamProject": PROJECT, "System.Title": "x" * 65537}),
            get_result(url="https://dev.azure.com/other/_apis/wit/workItems/42"),
        ]:
            with self.subTest(payload=payload), self.assertRaises(AdoError):
                self.dispatch(GET, response(payload))

    def test_project_guid_get_resolves_and_checks_project_id_and_name(self):
        project_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        result = self.dispatch({**GET, "project": project_id},
                               response({"id": project_id, "name": PROJECT}), response(get_result()))
        self.assertEqual(result, SELECTED_GET_RESULT)
        self.assertIn("/_apis/projects/" + project_id, self.calls[0][0])
        self.assertIn("/" + project_id + "/_apis/wit/workitems/42", self.calls[1][0])
        self.assertEqual(self.auth_calls, 1)
        with self.assertRaisesRegex(AdoError, "project ID mismatch"):
            self.dispatch({**GET, "project": project_id}, response({"id": "other", "name": PROJECT}))
        with self.assertRaisesRegex(AdoError, "work item project mismatch"):
            self.dispatch({**GET, "project": project_id}, response({"id": project_id, "name": PROJECT}),
                          response(get_result(fields={"System.TeamProject": "Other", "System.Title": "Login error"})))

    def test_get_returns_project_only_if_selected_and_accepts_thirty_two_selected_fields(self):
        result = self.dispatch({**GET, "fields": ["System.Title", "System.TeamProject"]}, response(get_result()))
        self.assertEqual(result, get_result())
        selected = [f"Custom.F{i}" for i in range(32)]
        fields = {key: "selected" for key in selected}
        result = self.dispatch({**GET, "fields": selected}, response(get_result(fields={**fields, "System.TeamProject": PROJECT})))
        self.assertEqual(result["fields"], fields)
        self.assertEqual(len(result["fields"]), 32)
        self.assertNotIn("System.TeamProject", result["fields"])
        self.assertIn("System.TeamProject", parse_qs(urlsplit(self.calls[-1][0]).query)["fields"][0])

    def test_get_defaults_include_useful_summary_fields_and_validates_field_id(self):
        request = {key: value for key, value in GET.items() if key != "fields"}
        payload = get_result(fields={"System.TeamProject": PROJECT, "System.Id": 42, "System.Title": "Login error"})
        self.assertEqual(self.dispatch(request, response(payload)), payload)
        self.assertEqual(parse_qs(urlsplit(self.calls[0][0]).query)["fields"], [
            "System.Id,System.TeamProject,System.WorkItemType,System.Title,System.State,System.AssignedTo,System.AreaPath,System.IterationPath,System.ChangedDate",
        ])
        with self.assertRaisesRegex(AdoError, "field ID mismatch"):
            self.dispatch(request, response(get_result(fields={"System.TeamProject": PROJECT, "System.Id": 43})))

    def test_shared_transport_paces_boards_and_pr_with_same_credential_memo(self):
        self.dispatch(SEARCH, response({"count": 0, "results": []}, headers={"retry-after": "4"}))
        client = PrClient("example", self.transport)
        self.outcomes.append(response({"value": []}))
        pr_request = {"operation": "read", "org": "example", "project": PROJECT, "repositoryId": "repo",
                      "pullRequestId": 42, "resource": "threads"}
        self.assertEqual(bridge.dispatch(pr_request, client), {"count": 0, "value": []})
        self.dispatch(QUERY, response(query_result()), response(ownership_result(42)))
        self.assertEqual(self.sleeps, [4])
        self.assertEqual(self.auth_calls, 1)
        self.assertEqual([call[1] for call in self.calls], ["POST", "GET", "POST", "POST"])

    def test_shared_organization_cooldown_is_deferred_without_http(self):
        self.state.throttle("example", self.now + 120)
        with self.assertRaises(Deferred) as error:
            self.dispatch(GET)
        self.assertEqual(error.exception.retry_at, 1120)
        self.assertEqual(self.calls, [])

    def test_search_and_query_read_posts_retry_throttle_and_network_without_mutation(self):
        for request, payload in [(SEARCH, {"count": 0, "results": []}), (QUERY, query_result([]))]:
            with self.subTest(operation=request["operation"]):
                start = len(self.calls)
                self.dispatch(request, ConnectionError("private"), response({}, 429, {"retry-after": "3"}), response(payload))
                calls = self.calls[start:]
                self.assertEqual([call[1] for call in calls], ["POST"] * 3)
                self.assertEqual(calls[0][2], calls[1][2])
                self.assertEqual(calls[1][2], calls[2][2])

    def test_query_ownership_read_post_retries_without_changing_snapshot_request(self):
        self.dispatch(QUERY, response(query_result()), ConnectionError("private"),
                      response({}, 429, {"retry-after": "3"}), response(ownership_result(42)))
        self.assertEqual([call[1] for call in self.calls], ["POST"] * 4)
        self.assertEqual(self.calls[1][2], self.calls[2][2])
        self.assertEqual(self.calls[2][2], self.calls[3][2])
        self.assertEqual(self.auth_calls, 1)

    def test_auth_and_network_errors_are_actionable_without_leaking_private_details(self):
        for status in (401, 403):
            with self.subTest(status=status), self.assertRaisesRegex(AdoError, "Boards read permissions"):
                self.dispatch(GET, response({}, status))
        with self.assertRaisesRegex(AdoError, "connectivity") as error:
            self.dispatch(GET, *(ConnectionError("private credential or target") for _ in range(3)))
        self.assertNotIn("private", str(error.exception))
        with patch.object(self.transport, "auth", side_effect=AdoError("Azure CLI token unavailable; sign in", code="auth")):
            self.transport.credentials.clear()
            with self.assertRaisesRegex(AdoError, "AZURE_DEVOPS_EXT_PAT") as error:
                self.dispatch(GET)
            self.assertEqual(error.exception.code, "auth")

    def test_nonretryable_http_errors_preserve_status_without_retry_guidance(self):
        for status in (400, 404, 409, 422, 500):
            with self.subTest(status=status):
                start = len(self.calls)
                with self.assertRaises(AdoError) as error:
                    self.dispatch(GET, response({}, status))
                self.assertEqual(str(error.exception), f"Azure DevOps HTTP {status}")
                self.assertEqual(len(self.calls) - start, 1)

    def test_retryable_http_errors_keep_connectivity_and_cooldown_guidance(self):
        with self.assertRaises(AdoError) as error:
            self.dispatch(GET, *(response({}, 503) for _ in range(3)))
        self.assertEqual(str(error.exception),
                         "Azure DevOps HTTP 503; check Azure DevOps connectivity and retry after any organization cooldown")
        self.assertEqual(len(self.calls), 3)

    def test_total_budget_is_sixty_seconds_and_fails_instead_of_returning_partial_data(self):
        def slow():
            self.now += 60
            return response(get_result())
        with self.assertRaisesRegex(AdoError, "total operation deadline") as error:
            self.dispatch(GET, slow)
        self.assertEqual(error.exception.code, "incomplete_read")
        self.assertIsNone(self.transport.budget_remaining())

    def test_serialized_output_cap_and_nested_field_limits_fail_explicitly(self):
        entries = [search_entry(index + 1, **{"system.title": "x" * 65536}) for index in range(25)]
        with self.assertRaisesRegex(AdoError, "exceeds 1 MiB") as error:
            self.dispatch(SEARCH, response({"count": 25, "results": entries}))
        self.assertEqual(error.exception.code, "content_too_large")
        for value in [[0] * 1025, float("nan"), 10 ** 400, {"key": "x" * 65537}]:
            with self.subTest(value=type(value).__name__), self.assertRaises(AdoError):
                self.dispatch(GET, response(get_result(fields={"System.TeamProject": PROJECT, "System.Title": value})))

    def test_exact_one_mib_serialized_result_is_accepted_and_one_extra_byte_fails(self):
        requested = [f"Custom.F{i}" for i in range(16)]
        fields = {"System.TeamProject": PROJECT, **{key: "x" * 65536 for key in requested[:-1]}, "Custom.F15": ""}
        payload = get_result(fields=fields)
        selected_payload = {**payload, "fields": {key: value for key, value in fields.items() if key in requested}}
        serialized_size = len(json.dumps(selected_payload, ensure_ascii=True, separators=(",", ":")).encode("ascii"))
        fields["Custom.F15"] = "x" * (1024 * 1024 - serialized_size)
        result = self.dispatch({**GET, "fields": requested}, response(payload))
        self.assertEqual(len(json.dumps(result, ensure_ascii=True, separators=(",", ":")).encode("ascii")), 1024 * 1024)
        self.outcomes.append(response(payload))
        output, errors = StringIO(), StringIO()
        request = {**GET, "fields": requested}
        with patch.object(sys, "stdin", TextIOWrapper(BytesIO(json.dumps(request).encode()), encoding="utf-8")), \
                patch.object(boards, "Transport", return_value=self.transport), redirect_stdout(output), redirect_stderr(errors):
            self.assertEqual(bridge.main(), 0)
        self.assertEqual(len(output.getvalue().encode("ascii")), 1024 * 1024 + 1)
        self.assertEqual(json.loads(output.getvalue()), result)
        self.assertEqual(errors.getvalue(), "")
        fields["Custom.F15"] += "x"
        with self.assertRaisesRegex(AdoError, "exceeds 1 MiB") as error:
            self.dispatch({**GET, "fields": requested}, response(payload))
        self.assertEqual(error.exception.code, "content_too_large")

    def test_cli_get_is_coordinated_and_search_query_keep_legacy_shapes(self):
        self.outcomes.append(response(get_result()))
        output = StringIO()
        with patch.object(boards, "Transport", return_value=self.transport), redirect_stdout(output):
            cli.get_work_item(argparse.Namespace(org=SCOPE["org"], project=PROJECT, id=42, fields="System.Title"))
        self.assertEqual(json.loads(output.getvalue()), SELECTED_GET_RESULT)
        legacy_query = {"workItems": [{"id": 42}], "legacy": True}
        self.outcomes.append(response(legacy_query))
        output = StringIO()
        with patch.object(ado, "Transport", return_value=self.transport), redirect_stdout(output):
            cli.query_work_items(argparse.Namespace(org=SCOPE["org"], project=PROJECT, wiql=QUERY["wiql"]))
        self.assertEqual(json.loads(output.getvalue()), legacy_query)
        self.outcomes.append(response({"count": 0, "results": []}))
        output = StringIO()
        with patch.object(ado, "Transport", return_value=self.transport), redirect_stdout(output):
            cli.search_work_items(argparse.Namespace(org=SCOPE["org"], project=[], top=25, text="login", type=[], area=[]))
        self.assertEqual(json.loads(output.getvalue()), {"count": 0, "results": []})

    def test_cli_search_nonpositive_top_preserves_legacy_default_twenty_five(self):
        for top in (0, -3):
            with self.subTest(top=top):
                self.outcomes.append(response({"count": 0, "results": []}))
                output = StringIO()
                with patch.object(ado, "Transport", return_value=self.transport), redirect_stdout(output):
                    cli.search_work_items(argparse.Namespace(
                        org="example", project=["Project"], top=top, text="login", type=["Bug"], area=[],
                    ))
                self.assertEqual(json.loads(output.getvalue()), {"count": 0, "results": []})
                self.assertEqual(self.calls[-1][:3], (
                    "https://almsearch.dev.azure.com/example/_apis/search/workitemsearchresults?api-version=7.1",
                    "POST", {"searchText": "login", "$top": 25, "filters": {
                        "System.WorkItemType": ["Bug"], "System.TeamProject": ["Project"],
                    }},
                ))

    def test_wiql_helper_output_has_project_predicate_and_grouped_or_clause(self):
        args = argparse.Namespace(fields="", assigned_to="@Me", state=[], exclude_state=[],
                                  current=True, type=["Bug"], extra_clause=[
                                      "[System.Title] = 'A' OR [System.Title] = 'B'",
                                  ])
        result = cli.build_wiql(args)
        wiql = (
            "SELECT [System.Id], [System.Title], [System.State] FROM workitems WHERE "
            "[System.TeamProject] = @Project AND [System.AssignedTo] = @Me AND "
            "[System.State] <> 'Closed' AND [System.State] <> 'Removed' AND "
            "[System.WorkItemType] IN ('Bug') AND "
            "([System.Title] = 'A' OR [System.Title] = 'B') ORDER BY [System.ChangedDate] DESC"
        )
        self.assertEqual(result["wiql"], wiql)
        self.assertEqual(result["commandArgs"], ["boards", "query", "--wiql", wiql, "--detect", "true"])
        self.assertEqual(shlex.split(result["posixCommand"]), ["az", *result["commandArgs"]])
        self.assertEqual(result["powerShellCommand"],
                         "az boards query --wiql '" + wiql.replace("'", "''") + "' --detect true")
        output = StringIO()
        with patch.object(sys, "argv", ["ado-work-items.py", "wiql"]), redirect_stdout(output):
            cli.main()
        self.assertEqual(json.loads(output.getvalue())["wiql"],
                         "SELECT [System.Id], [System.Title], [System.State] FROM workitems "
                         "WHERE [System.TeamProject] = @Project ORDER BY [System.ChangedDate] DESC")

    def test_bridge_query_scope_failure_emits_only_explicit_error_not_partial_output(self):
        self.outcomes.extend([response(query_result()), response(ownership_result(42, project="Other"))])
        output, errors = StringIO(), StringIO()
        with patch.object(sys, "stdin", TextIOWrapper(BytesIO(json.dumps(QUERY).encode()), encoding="utf-8")), \
                patch.object(boards, "Transport", return_value=self.transport), redirect_stdout(output), redirect_stderr(errors):
            self.assertEqual(bridge.main(), 1)
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(json.loads(errors.getvalue()), {
            "error": "Azure Boards query project mismatch; narrow WIQL with "
                     "[System.TeamProject] = @Project applying to every OR branch",
            "code": "unsupported_query",
        })

    def test_bridge_verified_query_output_keeps_exact_reference_only_contract(self):
        self.outcomes.extend([response(query_result()), response(ownership_result(42))])
        output, errors = StringIO(), StringIO()
        with patch.object(sys, "stdin", TextIOWrapper(BytesIO(json.dumps(QUERY).encode()), encoding="utf-8")), \
                patch.object(boards, "Transport", return_value=self.transport), redirect_stdout(output), redirect_stderr(errors):
            self.assertEqual(bridge.main(), 0)
        self.assertEqual(json.loads(output.getvalue()),
                         {**query_result(), "returnedCount": 1, "limit": 25, "truncated": False})
        self.assertNotIn("System.TeamProject", output.getvalue())
        self.assertEqual(errors.getvalue(), "")

    def test_cli_invalid_options_fail_before_transport(self):
        for function, args in [
            (cli.search_work_items, argparse.Namespace(org="example", project=[], top=101, text="login", type=[], area=[])),
            (cli.search_work_items, argparse.Namespace(org="example", project=[], top=False, text="login", type=[], area=[])),
            (cli.query_work_items, argparse.Namespace(org="example", project=PROJECT, wiql=" ")),
            (cli.get_work_item, argparse.Namespace(org="example", project=PROJECT, id=True, fields=None)),
        ]:
            with self.subTest(function=function), patch.object(ado, "Transport", side_effect=AssertionError("transport created")), \
                    patch.object(boards, "Transport", side_effect=AssertionError("transport created")), self.assertRaises(AdoError):
                function(args)

    def test_bridge_stdin_stdout_success_and_structured_error_contract(self):
        self.outcomes.append(response(get_result()))
        output, errors = StringIO(), StringIO()
        with patch.object(sys, "stdin", TextIOWrapper(BytesIO(json.dumps(GET).encode()), encoding="utf-8")), \
                patch.object(boards, "Transport", return_value=self.transport), redirect_stdout(output), redirect_stderr(errors):
            self.assertEqual(bridge.main(), 0)
        self.assertEqual(json.loads(output.getvalue()), SELECTED_GET_RESULT)
        self.assertEqual(errors.getvalue(), "")

        for payload, expected_code in [({**GET, "id": 0}, 1), (GET, 2)]:
            self.state.throttle("example", 1120)
            output, errors = StringIO(), StringIO()
            with patch.object(sys, "stdin", TextIOWrapper(BytesIO(json.dumps(payload).encode()), encoding="utf-8")), \
                    patch.object(boards, "Transport", return_value=self.transport), redirect_stdout(output), redirect_stderr(errors):
                self.assertEqual(bridge.main(), expected_code)
            self.assertEqual(output.getvalue(), "")
            error = json.loads(errors.getvalue())
            if expected_code == 2:
                self.assertEqual(error, {"error": "organization cooldown exceeds foreground wait budget",
                                         "deferred": True, "retryAt": 1120})
            else:
                self.assertIn("invalid Azure Boards ID", error["error"])


if __name__ == "__main__":
    unittest.main()
