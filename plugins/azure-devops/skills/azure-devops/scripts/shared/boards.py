from __future__ import annotations

import json
import math
import re
import urllib.parse
from typing import Any

from .transport import AdoError, Deferred, Transport, canonical_url, organization


MAX_OUTPUT_BYTES = 1024 * 1024
FIELD_PATTERN = r"[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+"
GUID_PATTERN = r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}"
ORG_PATTERN = (r"(?:[A-Za-z0-9][A-Za-z0-9_-]*|"
               r"https://dev\.azure\.com(?::443)?/[A-Za-z0-9][A-Za-z0-9_-]*/?|"
               r"https://[A-Za-z0-9][A-Za-z0-9_-]*\.visualstudio\.com(?::443)?(?:/DefaultCollection)?/?)")
OPERATIONS = {"workItemSearch", "workItemQuery", "workItemGet"}
DEFAULT_FIELDS = [
    "System.Id", "System.TeamProject", "System.WorkItemType", "System.Title", "System.State",
    "System.AssignedTo", "System.AreaPath", "System.IterationPath", "System.ChangedDate",
]


def string(value: Any, label: str, limit: int, *, blank: bool = False) -> str:
    if not isinstance(value, str) or len(value) > limit or (not blank and not value.strip()):
        raise AdoError(f"invalid Azure Boards {label}; expected {'a' if blank else 'a nonblank'} string up to {limit} characters")
    return value


def project_name(value: Any) -> str:
    value = string(value, "project", 4096)
    decoded = value
    for _ in range(4):
        next_value = urllib.parse.unquote(decoded)
        if next_value == decoded:
            break
        decoded = next_value
    else:
        raise AdoError("invalid Azure Boards project encoding")
    if decoded in (".", "..") or any(char in decoded for char in "/\\") or any(
        ord(char) < 32 or ord(char) == 127 for char in decoded
    ):
        raise AdoError("invalid Azure Boards project path")
    return value


def integer(value: Any, label: str, maximum: int, minimum: int = 1) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise AdoError(f"invalid Azure Boards {label}; expected an integer from {minimum} to {maximum}")
    return value


def organization_name(value: Any) -> str:
    value = string(value, "organization", 2048)
    if not re.fullmatch(ORG_PATTERN, value):
        raise AdoError("invalid Azure Boards organization; use a name or canonical HTTPS organization URL")
    return organization(value)


def string_list(value: Any, label: str, maximum: int = 16, *, fields: bool = False) -> list[str]:
    if not isinstance(value, list) or not 1 <= len(value) <= maximum:
        raise AdoError(f"invalid Azure Boards {label}; expected 1 to {maximum} strings")
    for item in value:
        string(item, label, 256 if fields else 4096)
        if fields and not re.fullmatch(FIELD_PATTERN, item):
            raise AdoError("invalid Azure Boards field reference")
    if fields and len(set(value)) != len(value):
        raise AdoError("duplicate Azure Boards field references")
    return value


def validate_request(request: Any) -> dict[str, Any]:
    if not isinstance(request, dict) or not isinstance(request.get("operation"), str) or request["operation"] not in OPERATIONS:
        raise AdoError("invalid Azure Boards operation")
    operation = request["operation"]
    required = {"operation", "org", "project", {"workItemSearch": "text", "workItemQuery": "wiql", "workItemGet": "id"}[operation]}
    optional = {"workItemSearch": {"top", "types", "areas"}, "workItemQuery": {"top"}, "workItemGet": {"fields"}}[operation]
    if not required <= request.keys() or request.keys() - required - optional:
        raise AdoError("invalid Azure Boards request fields")
    organization_name(request["org"])
    project_name(request["project"])
    if operation == "workItemGet":
        integer(request["id"], "ID", 2147483647)
        if "fields" in request:
            string_list(request["fields"], "fields", 32, fields=True)
    else:
        integer(request.get("top", 25), "top", 100)
        if operation == "workItemSearch":
            string(request["text"], "search text", 4096)
            for name in ("types", "areas"):
                if name in request:
                    string_list(request[name], name)
        else:
            string(request["wiql"], "WIQL", 32768)
    return request


def object_response(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise AdoError(f"malformed Azure Boards {label}; expected an object")
    return value


def result_url(value: Any, org: str, item_id: int) -> str:
    value = string(value, "response URL", 16384)
    owner, normalized = canonical_url(value)
    path = urllib.parse.urlsplit(normalized).path
    if owner != org or not re.fullmatch(rf"/{re.escape(org)}(?:/[^/]+)?/_apis/wit/workitems/{item_id}", path, re.IGNORECASE):
        raise AdoError("Azure Boards response URL or organization mismatch")
    return normalized


def json_field(value: Any, depth: int = 0) -> None:
    if depth > 16:
        raise AdoError("Azure Boards field nesting exceeds 16 levels", code="content_too_large")
    if value is None or type(value) is bool:
        return
    if isinstance(value, str):
        string(value, "field content", 65536, blank=True)
    elif type(value) in (int, float):
        try:
            finite = math.isfinite(value)
        except OverflowError as exc:
            raise AdoError("invalid Azure Boards numeric field") from exc
        if not finite:
            raise AdoError("invalid Azure Boards numeric field")
    elif isinstance(value, (dict, list)):
        if len(value) > 1024:
            raise AdoError("Azure Boards field collection exceeds 1024 entries", code="content_too_large")
        if isinstance(value, dict):
            for key in value:
                string(key, "field object key", 256, blank=True)
            values = value.values()
        else:
            values = value
        for item in values:
            json_field(item, depth + 1)
    else:
        raise AdoError("invalid Azure Boards JSON field")


def bounded_result(value: dict[str, Any]) -> dict[str, Any]:
    try:
        encoded = json.dumps(value, ensure_ascii=True, separators=(",", ":"), allow_nan=False).encode("ascii")
    except (ValueError, UnicodeEncodeError) as exc:
        raise AdoError("invalid Azure Boards result encoding") from exc
    if len(encoded) > MAX_OUTPUT_BYTES:
        raise AdoError("Azure Boards result exceeds 1 MiB; request fewer items or fields", code="content_too_large")
    return value


class BoardsClient:
    def __init__(self, org: str, transport: Transport | None = None):
        self.org = organization_name(org)
        self.transport = transport or Transport()

    def url(self, project: str, path: str, **query: Any) -> str:
        prefix = "/" + urllib.parse.quote(project, safe="") if project else ""
        return f"https://dev.azure.com/{self.org}{prefix}/_apis/{path}?" + urllib.parse.urlencode({"api-version": "7.1", **query})

    def project(self, project: str) -> str:
        if not re.fullmatch(GUID_PATTERN, project):
            return project
        payload = object_response(self.transport.json(self.url("", "projects/" + project)), "project")
        if string(payload.get("id"), "project ID", 36).lower() != project.lower():
            raise AdoError("Azure Boards project ID mismatch")
        return project_name(payload.get("name"))

    def execute(self, request: Any) -> dict[str, Any]:
        request = validate_request(request)
        if organization(request["org"]) != self.org:
            raise AdoError("Azure Boards client organization mismatch")
        try:
            with self.transport.budget(60):
                if request["operation"] == "workItemSearch":
                    result = self.search(request)
                elif request["operation"] == "workItemQuery":
                    result = self.query(request)
                else:
                    result = self.get(request)
                return bounded_result(result)
        except Deferred:
            raise
        except AdoError as exc:
            message = str(exc)
            if "HTTP 401" in message or "HTTP 403" in message or "token unavailable" in message:
                raise AdoError(f"{message}; sign in with Azure CLI or set AZURE_DEVOPS_EXT_PAT and check Boards read permissions",
                               code=exc.code) from exc
            if message.startswith("HTTP read") or message in (
                "Azure DevOps HTTP 429", "Azure DevOps HTTP 502",
                "Azure DevOps HTTP 503", "Azure DevOps HTTP 504",
            ):
                raise AdoError(f"{message}; check Azure DevOps connectivity and retry after any organization cooldown",
                               code=exc.code) from exc
            raise

    def search(self, request: dict[str, Any]) -> dict[str, Any]:
        project = self.project(request["project"])
        top = request.get("top", 25)
        filters = {"System.TeamProject": [project]}
        if "types" in request:
            filters["System.WorkItemType"] = request["types"]
        if "areas" in request:
            filters["System.AreaPath"] = request["areas"]
        payload = object_response(self.transport.json(
            f"https://almsearch.dev.azure.com/{self.org}/_apis/search/workitemsearchresults?api-version=7.1",
            "POST", json.dumps({"searchText": request["text"], "$top": top, "filters": filters}).encode("utf-8"),
            {"Content-Type": "application/json"}, replay_safe=True,
        ), "search")
        if "infoCode" in payload and (type(payload["infoCode"]) is not int or payload["infoCode"] != 0):
            raise AdoError("Azure Boards search is unavailable or incomplete; check search indexing and permissions")
        count = integer(payload.get("count"), "search count", 9007199254740991, 0)
        entries = payload.get("results")
        if not isinstance(entries, list) or len(entries) > top or count < len(entries):
            raise AdoError("malformed Azure Boards search result counts")
        results = []
        for entry in entries:
            entry = object_response(entry, "search entry")
            fields = object_response(entry.get("fields"), "search fields")
            raw_id = fields.get("system.id")
            if isinstance(raw_id, str) and len(raw_id) <= 10 and re.fullmatch(r"[0-9]+", raw_id):
                raw_id = int(raw_id)
            item_id = integer(raw_id, "search ID", 2147483647)
            owner = project_name(object_response(entry.get("project"), "search project").get("name"))
            if owner.casefold() != project.casefold():
                raise AdoError("Azure Boards search project mismatch")
            results.append({
                "id": item_id, "project": owner,
                "title": string(fields.get("system.title"), "title", 65536, blank=True),
                "type": string(fields.get("system.workitemtype"), "type", 65536),
                "state": string(fields.get("system.state"), "state", 65536),
                "assignedTo": None if fields.get("system.assignedto") is None else string(fields["system.assignedto"], "assignedTo", 65536, blank=True),
                "areaPath": None if fields.get("system.areapath") is None else string(fields["system.areapath"], "areaPath", 65536, blank=True),
                "url": f"https://dev.azure.com/{self.org}/{urllib.parse.quote(owner, safe='')}/_workitems/edit/{item_id}",
            })
        if len({entry["id"] for entry in results}) != len(results):
            raise AdoError("duplicate Azure Boards search IDs")
        return {"count": count, "results": results, "returnedCount": len(results), "limit": top, "truncated": count > len(results)}

    def query(self, request: dict[str, Any]) -> dict[str, Any]:
        top = request.get("top", 25)
        payload = object_response(self.transport.json(
            self.url(request["project"], "wit/wiql", **{"$top": top + 1}), "POST",
            json.dumps({"query": request["wiql"]}).encode("utf-8"), {"Content-Type": "application/json"},
            replay_safe=True,
        ), "WIQL")
        if payload.get("queryType") in ("tree", "oneHop") or "workItemRelations" in payload:
            raise AdoError("unsupported Azure Boards WIQL relations; only flat WorkItems queries are supported", code="unsupported_query")
        if payload.get("queryType") != "flat" or payload.get("queryResultType") != "workItem":
            raise AdoError("malformed Azure Boards WIQL query type")
        as_of = string(payload.get("asOf"), "WIQL asOf", 256)
        raw_columns = payload.get("columns")
        entries = payload.get("workItems")
        if not isinstance(raw_columns, list) or len(raw_columns) > 100:
            raise AdoError("malformed Azure Boards WIQL columns")
        if not isinstance(entries, list) or len(entries) > top + 1:
            raise AdoError("malformed Azure Boards WIQL reference count")
        columns = []
        for column in raw_columns:
            column = object_response(column, "WIQL column")
            reference = string(column.get("referenceName"), "field reference", 256)
            if not re.fullmatch(FIELD_PATTERN, reference):
                raise AdoError("invalid Azure Boards WIQL field reference")
            columns.append({"referenceName": reference, "name": string(column.get("name"), "column name", 65536)})
        references = []
        for item in entries:
            item = object_response(item, "WIQL reference")
            item_id = integer(item.get("id"), "WIQL ID", 2147483647)
            references.append({"id": item_id, "url": result_url(item.get("url"), self.org, item_id)})
        if len({item["id"] for item in references}) != len(references):
            raise AdoError("duplicate Azure Boards WIQL IDs")
        return {"queryType": "flat", "queryResultType": "workItem", "asOf": as_of, "columns": columns,
                "workItems": references[:top], "returnedCount": min(top, len(references)), "limit": top,
                "truncated": len(references) > top}

    def get(self, request: dict[str, Any]) -> dict[str, Any]:
        project = self.project(request["project"])
        selected_fields = request.get("fields", DEFAULT_FIELDS)
        fields = list(dict.fromkeys([*selected_fields, "System.TeamProject"]))
        item_id = request["id"]
        payload = object_response(self.transport.json(
            self.url(request["project"], f"wit/workitems/{item_id}", fields=",".join(fields)),
        ), "work item")
        if integer(payload.get("id"), "work item ID", 2147483647) != item_id:
            raise AdoError("Azure Boards work item ID mismatch")
        revision = integer(payload.get("rev"), "revision", 2147483647)
        result_fields = object_response(payload.get("fields"), "work item fields")
        if len(result_fields) > 33 or result_fields.keys() - set(fields):
            raise AdoError("malformed Azure Boards requested fields")
        if string(result_fields.get("System.TeamProject"), "work item project", 4096).casefold() != project.casefold():
            raise AdoError("Azure Boards work item project mismatch")
        for key, value in result_fields.items():
            if not re.fullmatch(FIELD_PATTERN, key):
                raise AdoError("invalid Azure Boards field reference")
            json_field(value)
        if "System.Id" in result_fields and integer(result_fields["System.Id"], "System.Id", 2147483647) != item_id:
            raise AdoError("Azure Boards work item field ID mismatch")
        return {"id": item_id, "rev": revision, "url": result_url(payload.get("url"), self.org, item_id),
                "fields": {key: value for key, value in result_fields.items() if key in selected_fields}}
