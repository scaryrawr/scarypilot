# /// script
# requires-python = ">=3.11"
# ///
import json
import os
from pathlib import Path
import sys

script = Path(sys.argv[0]).resolve()
expected = Path(os.environ["ADO_TEST_EXPECTED_BRIDGE"]).resolve()
if script != expected or not (script.parent / "shared" / "transport.py").is_file():
    raise RuntimeError("The installed sibling bridge and transport are required.")
if sys.argv[1:]:
    raise RuntimeError("Authored content must arrive through stdin, not argv.")

request = json.loads(sys.stdin.buffer.read())
ledger = Path(os.environ["ADO_TEST_LEDGER"])
with ledger.open("a", encoding="utf-8") as output:
    output.write(json.dumps({
        "kind": "python", "script": str(script), "args": sys.argv[1:],
        "request": request, "cwd": os.getcwd(),
    }) + "\n")
passes = len(ledger.read_text(encoding="utf-8").splitlines())

if request["operation"] == "read" and request["resource"] == "pullRequest":
    result = {
        "pullRequestId": 42,
        "repository": {"id": "repo-id", "project": {"id": "project-id", "name": "project"}},
        "lastMergeSourceCommit": {"commitId": "source"},
        "lastMergeTargetCommit": {"commitId": "target"},
        "lastMergeCommit": {"commitId": "merge"}, "status": "active",
    }
elif request["operation"] == "publish":
    result = {"results": [{
        "kind": "published", "findingId": item["findingId"], "remoteThreadId": 100 + index,
    } for index, item in enumerate(request["findings"])]}
elif request["operation"] == "snapshot":
    result = {
        "details": {"pullRequestId": 42}, "reviewers": [{"id": "reviewer", "vote": 10}],
        "threads": [], "policies": [{"id": "policy", "status": "approved"}],
        "builds": {"hasFailures": False, "hasPending": False, "builds": []},
        "revision": {"sourceCommit": f"source-{passes}"}, "observedAt": f"pass-{passes}",
    }
else:
    raise RuntimeError("Unexpected bridge domain request.")

print(json.dumps(result))
