# /// script
# requires-python = ">=3.11"
# ///
import importlib.util
import json
import os
from pathlib import Path
import sys
from urllib.parse import parse_qs, urlsplit

from shared.pr import PrClient
from shared.transport import Response, State, Transport

if sys.argv[1:]:
    raise RuntimeError("Domain requests must arrive on stdin, not argv.")

spec = importlib.util.spec_from_file_location("real_bridge", Path(__file__).with_name("real-bridge.py"))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

record = {"kind": "python", "authCalls": 0, "httpCalls": 0, "args": sys.argv[1:]}
real_dispatch = bridge.dispatch


def auth():
    record["authCalls"] += 1
    return "Basic installed-batch-fixture"


def send(url, method, body, headers):
    if method != "GET" or body is not None:
        raise RuntimeError("This fixture allows only read requests.")
    record["httpCalls"] += 1
    parsed = urlsplit(url)
    if parsed.path.endswith("/items"):
        query = parse_qs(parsed.query)
        result = {"content": "old\n" if query["versionDescriptor.version"] == ["a" * 40] else "new 日本語 🤖\n"}
    elif parsed.path.endswith("/iterations/3/changes"):
        result = {"changeEntries": [{
            "changeType": "edit", "item": {"path": f"/file-{index}.ts"}, "changeTrackingId": index + 1,
        } for index in range(17)]}
    elif parsed.path.endswith("/iterations"):
        result = {"value": [{
            "id": 3, "commonRefCommit": {"commitId": "a" * 40},
            "sourceRefCommit": {"commitId": "b" * 40},
        }]}
    elif parsed.path.endswith("/threads"):
        result = {"value": []}
    elif parsed.path.endswith("/42"):
        result = {"pullRequestId": 42, "repository": {"id": "repo-id"}}
    else:
        raise RuntimeError("Unexpected read route.")
    return Response(200, {}, json.dumps(result).encode())


def dispatch(request):
    record["request"] = request
    client = PrClient(request["org"], Transport(
        State(Path(os.environ["ADO_TEST_BATCH_STATE"])), auth=auth, send=send,
    ))
    return real_dispatch(request, client)


bridge.dispatch = dispatch
exit_code = bridge.main()
with Path(os.environ["ADO_TEST_BATCH_LEDGER"]).open("a", encoding="utf-8") as ledger:
    ledger.write(json.dumps(record) + "\n")
sys.exit(exit_code)
