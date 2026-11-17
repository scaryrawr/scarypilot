import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch


MODULE = Path(__file__).resolve().parents[2] / "run_codex_omlx.py"
SPEC = importlib.util.spec_from_file_location("codex_omlx", MODULE)
native = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = native
SPEC.loader.exec_module(native)


class CodexPilotTests(unittest.TestCase):
    def test_native_preflight_preserves_the_default_execution_environment(self):
        class ControlSession:
            launcher_notes = []

            def __init__(self, command, project, env, artifacts, timeout):
                self.project = project

            def send(self, message):
                pass

            def close(self):
                pass

            def rpc(self, method, params):
                if method == "initialize":
                    return {}
                if method == "skills/list":
                    return {"data": [{"cwd": str(self.project), "errors": [], "skills": [{
                        "path": str(self.project / ".agents/skills/better-init/SKILL.md"),
                        "name": "better-init", "scope": "repo",
                    }]}]}
                if method == "mcpServerStatus/list":
                    return {"data": []}
                if method == "thread/start":
                    if params.get("environments") == []:
                        raise RuntimeError("No usable execution environment is available.")
                    return {"model": params["model"], "modelProvider": params["modelProvider"],
                            "approvalPolicy": params["approvalPolicy"], "cwd": params["cwd"],
                            "activePermissionProfile": {"id": params["permissions"], "extends": None},
                            "thread": {"id": "control"}}
                raise AssertionError(f"Unexpected model request during preflight: {method}")

        with tempfile.TemporaryDirectory() as temporary, \
                patch.object(native, "NativeSession", ControlSession), \
                patch.object(native, "verify_file_access", return_value={"status": "passed"}):
            artifacts = Path(temporary)
            result = {}
            native.run_case(native.load_cases()[0], artifacts, Path(sys.executable),
                            Path(sys.executable), 5, True, result)
            self.assertEqual(result["preflight"], "passed")
            self.assertEqual(result["status"], "not_run")
            self.assertNotIn("invocation_started", result)

    def test_failed_native_file_controls_prevent_starting_a_session(self):
        with tempfile.TemporaryDirectory() as temporary, \
                patch.object(native, "NativeSession") as session, \
                patch.object(native, "verify_file_access",
                             side_effect=RuntimeError("Native file control failed")):
            result = {}
            with self.assertRaisesRegex(RuntimeError, "Native file control failed"):
                native.run_case(native.load_cases()[0], Path(temporary), Path(sys.executable),
                                Path(sys.executable), 5, False, result)
            session.assert_not_called()
            self.assertNotIn("invocation_started", result)

    def test_only_reviewed_native_cases_are_selected(self):
        cases = native.load_cases()
        self.assertEqual([(case.kind, case.identifier) for case in cases],
                         [("trigger", 8), ("trigger", 6), ("task", 108), ("task", 109)])
        self.assertEqual([case.should_trigger for case in cases[:2]], [True, False])
        self.assertTrue(all(case.fixtures for case in cases[1:]))

    def test_native_discovery_and_permissions_fail_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            project = Path(temporary).resolve()
            candidate = project / ".agents/skills/better-init/SKILL.md"
            start = {"model": native.MODEL, "modelProvider": "omlx",
                     "approvalPolicy": "never", "cwd": str(project),
                     "activePermissionProfile": {"id": native.PROFILE, "extends": None}}
            row = {"cwd": str(project), "errors": [], "skills": [
                {"path": str(candidate), "name": "better-init", "scope": "repo", "enabled": True},
            ]}
            discovery = {"data": [row]}
            native.verify_startup(start, discovery, project, candidate)
            for key, wrong in (("model", "different"), ("modelProvider", "openai"),
                               ("activePermissionProfile", None), ("approvalPolicy", "on-request")):
                with self.subTest(key=key), self.assertRaises(ValueError):
                    native.verify_startup({**start, key: wrong}, discovery, project, candidate)
            row["skills"].append({"path": "/private/other/SKILL.md", "name": "other",
                                  "scope": "user", "enabled": True})
            with self.assertRaisesRegex(ValueError, "Unexpected enabled"):
                native.verify_startup(start, discovery, project, candidate)

    def test_lexical_task_checks_cannot_claim_semantic_pass(self):
        with tempfile.TemporaryDirectory() as temporary:
            project = Path(temporary)
            output = project / "outputs"
            owner = output / ".agents/skills/code-review/SKILL.md"
            owner.parent.mkdir(parents=True)
            owner.write_text("src/index.js test/index.test.js node --test")
            (output / "AGENTS.md").write_text("npm test")
            case = native.Case("task", 109, "request", (), ("No requirements are invented.",))
            result = native.grade(case, project, False)
            self.assertEqual(result["status"], "not_run")
            self.assertEqual(result["checks"][1]["status"], "passed")
            owner.write_text("src/index.js test/index.test.js. See AGENTS.md for validation.")
            self.assertEqual(native.grade(case, project, False)["checks"][1]["status"], "passed")
            (output / "unwanted.txt").write_text("extra")
            self.assertEqual(native.grade(case, project, False)["status"], "failed")

    def test_load_claim_requires_completed_successful_native_read(self):
        candidate = Path("/private/cedar/project/.agents/skills/better-init/SKILL.md")
        event = {"method": "item/completed", "params": {"item": {
            "type": "commandExecution", "exitCode": 0,
            "command": "cat .agents/skills/better-init/SKILL.md",
        }}}
        self.assertTrue(native.observed_load([event], candidate))
        event["params"]["item"]["command"] = "/bin/zsh -lc 'cat .agents/skills/better-init/SKILL.md'"
        self.assertTrue(native.observed_load([event], candidate))
        event["params"]["item"]["command"] = "/bin/zsh -lc 'cat .agents/skills/better-init/SKILL.md; echo extra'"
        self.assertFalse(native.observed_load([event], candidate))
        event["params"]["item"]["command"] = "/bin/zsh -lc 'cat .agents/skills/better-init/SKILL.md'"
        event["params"]["item"]["exitCode"] = 1
        self.assertFalse(native.observed_load([event], candidate))
        self.assertFalse(native.observed_load([{"method": "item/completed", "params": {
            "item": {"type": "agentMessage", "text": "I loaded better-init."},
        }}], candidate))

    def test_symlink_output_is_rejected_without_following_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "private.txt").write_text("canary")
            output = root / "outputs"
            output.mkdir()
            (output / "escape").symlink_to(root / "private.txt")
            with self.assertRaisesRegex(ValueError, "Unexpected symlink"):
                native.hashes(output)

    def test_transport_handles_batched_notifications_and_retains_native_evidence(self):
        program = (
            "import json,sys\n"
            "for line in sys.stdin:\n"
            " request=json.loads(line)\n"
            " print(json.dumps({'method':'native/notification','params':{}}))\n"
            " print(json.dumps({'id':request['id'],'result':{'alive':True}}),flush=True)\n"
        )
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            session = native.NativeSession([sys.executable, "-u", "-c", program],
                                           root, {}, root, 5)
            try:
                self.assertEqual(session.rpc("initialize", {}), {"alive": True})
                self.assertEqual(session.events[0]["method"], "native/notification")
            finally:
                session.close()
            records = [json.loads(line) for line in (root / "native-rpc.jsonl").read_text().splitlines()]
            self.assertEqual([record["direction"] for record in records],
                             ["client", "server", "server"])

    def test_transport_deadline_stops_the_owned_process(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            session = native.NativeSession([sys.executable, "-c", "import time;time.sleep(30)"],
                                           root, {}, root, 5)
            session.deadline = time.monotonic() - 1
            try:
                with self.assertRaises(TimeoutError):
                    session.receive()
            finally:
                session.close()
            self.assertIsNotNone(session.process.returncode)


if __name__ == "__main__":
    unittest.main()
