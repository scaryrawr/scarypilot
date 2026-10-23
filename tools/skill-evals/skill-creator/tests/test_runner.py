"""Credential-free contract tests. The only subprocess is an explicit fake CLI."""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import json
import os
import shutil
import sys
import unittest
import uuid
from pathlib import Path
from unittest.mock import MagicMock, patch

HELPERS = Path(__file__).resolve().parents[1]
REPO = HELPERS.parents[2]
sys.path.insert(0, str(HELPERS))

from scripts import harnesses, run_eval, run_harness_eval
from scripts.grading import ASSERTIONS, REQUIRED_VIEWS, grade, verify_grading


AGENTS = "# Repository\n\nsrc/index.js exports the greeting. test/index.test.js covers it.\nRun npm test for node --test.\n"
REVIEW = """---
name: code-review
description: Review pull requests for greeting compatibility.
---
# Review

When reviewing changes in src/index.js, preserve the exact Hello, <name>! greeting output format relied on by clients.
Check test/index.test.js and validate with npm test.
The incident MCP server is local-only, not available in hosted review.
"""


def event(typ, **data):
    return {"type": typ, "data": data}


def trace(candidate=None, views=()):
    events = [event("session.start", selectedModel="test-model")]
    events.append(event("assistant.message", content="Working on the requested files."))
    if candidate:
        events.extend([
            event("tool.execution_start", toolName="skill", toolCallId="skill-1", arguments={"skill": candidate}),
            event("user.message", source=f"skill-{candidate}"),
            event("tool.execution_complete", toolCallId="skill-1", success=True),
        ])
    for i, path in enumerate(views):
        events.extend([
            event("tool.execution_start", toolName="view", toolCallId=f"view-{i}", arguments={"path": path}),
            event("tool.execution_complete", toolCallId=f"view-{i}", success=True),
        ])
    events.extend([event("assistant.message", content="Done."), event("session.idle")])
    events[1:1] = [
        event("session.skills_loaded", skills=[{"name": candidate or "candidate", "source": "project", "enabled": True}]),
        event("session.mcp_servers_loaded", servers=[]),
    ]
    return events


def jsonl(events):
    return "".join(json.dumps(item) + "\n" for item in events)


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.work = Path(__file__).parent / f".work-{uuid.uuid4().hex}"
        self.work.mkdir()
        self.work = self.work.resolve()
        self.skill = self.work / "better-init"
        source = REPO / "plugins/better-init/skills/better-init"
        shutil.copytree(source, self.skill)
        self.args = argparse.Namespace(
            model="test-model", approved=True, max_calls=10, timeout=2,
            num_workers=1, auth_env=None, cli=str(self.work / "fake-copilot"),
        )

    def tearDown(self):
        shutil.rmtree(self.work)

    def fake_cli(self, behavior="success", task=False):
        code = f"""#!{sys.executable}
import json, os, pathlib, sys, time
root = pathlib.Path.cwd()
candidate = next((root / '.github/skills').iterdir()).name if (root / '.github/skills').exists() else None
behavior = {behavior!r}
assert os.environ['COPILOT_HOME'] != str(pathlib.Path.home() / '.copilot')
assert not any(k in os.environ for k in ('COPILOT_ALLOW_ALL', 'NODE_OPTIONS', 'BASH_ENV', 'COPILOT_PROVIDER_API_KEY_COMMAND'))
assert '--allow-all' not in sys.argv and '--allow-all-paths' not in sys.argv and '--allow-all-urls' not in sys.argv
assert ('--available-tools=skill,view,create,edit,apply_patch' if {task!r} else '--available-tools=skill,view') in sys.argv
(pathlib.Path(os.environ['COPILOT_HOME']).parent / 'fake-env.json').write_text(json.dumps({{'HOME': os.environ['HOME'], 'COPILOT_HOME': os.environ['COPILOT_HOME'], 'args': sys.argv}}))
if behavior == 'nonzero':
    print('authentication unavailable', file=sys.stderr)
    sys.exit(9)
if behavior == 'timeout':
    print('{{"type":"session.start","data":{{}}}}', flush=True)
    time.sleep(10)
if behavior == 'malformed':
    print('{{"type":')
    sys.exit(0)
events = {trace(views=sorted(REQUIRED_VIEWS))!r}
for e in events:
    if e['type'] == 'session.skills_loaded':
        e['data']['skills'] = [{{'name':candidate, 'source':'project', 'enabled':True}}] if candidate else []
if candidate and behavior != 'no-load':
    events[2:2] = [
        {{'type': 'tool.execution_start', 'data': {{'toolName':'skill', 'toolCallId':'s', 'arguments':{{'skill':candidate if behavior != 'wrong-skill' else 'better-init'}}}}}},
        {{'type': 'tool.execution_complete', 'data': {{'toolCallId':'s', 'success':True}}}},
    ]
if behavior == 'truncated':
    events.pop()
if behavior == 'forbidden':
    events.insert(2, {{'type':'tool.execution_start','data':{{'toolName':'bash','toolCallId':'b','arguments':{{'command':'echo nope'}}}}}})
if behavior == 'model-error':
    events.insert(2, {{'type':'session.error','data':{{'errorType':'authentication'}}}})
if behavior == 'model-mismatch':
    events[0]['data']['selectedModel'] = 'other-model'
if {task!r}:
    output = root / 'outputs'
    (output / '.github/skills/code-review').mkdir(parents=True)
    (output / 'AGENTS.md').write_text({AGENTS!r})
    (output / '.github/skills/code-review/SKILL.md').write_text({REVIEW!r})
    events[2:2] = [
        {{'type':'tool.execution_start','data':{{'toolName':'view','toolCallId':'old','arguments':{{'path':'inputs/existing-code-review.md'}}}}}},
        {{'type':'tool.execution_complete','data':{{'toolCallId':'old','success':True}}}},
    ] if (root / 'inputs/existing-code-review.md').exists() else []
    if behavior == 'bad-content':
        (output / '.github/skills/code-review/SKILL.md').write_text('Generic advice. Look for bugs.')
    if behavior == 'scope':
        (root / 'inputs/simple-repository/package.json').write_text('{{}}')
    for index, path in enumerate(('outputs/AGENTS.md', 'outputs/.github/skills/code-review/SKILL.md')):
        events[2:2] = [
            {{'type':'tool.execution_start','data':{{'toolName':'create','toolCallId':f'write-{{index}}','arguments':{{'path':path}}}}}},
            {{'type':'tool.execution_complete','data':{{'toolCallId':f'write-{{index}}','success':True}}}},
        ]
if not {task!r}:
    events = [e for e in events if not (e['type'] == 'tool.execution_start' and e['data'].get('toolName') == 'view') and not (e['type'] == 'tool.execution_complete' and e['data'].get('toolCallId','').startswith('view-'))]
for e in events: print(json.dumps(e))
"""
        Path(self.args.cli).write_text(code)
        Path(self.args.cli).chmod(0o700)

    def run_trigger(self, behavior="success", should_trigger=True, name="run"):
        self.fake_cli(behavior)
        return run_eval.run_single_query({"query": "Initialize guidance", "should_trigger": should_trigger}, self.skill, self.work / name, self.args)

    def task_case(self, case_id=8):
        return run_harness_eval.load_evals(self.skill / "evals/evals.json", [case_id], self.skill)[0]

    def test_provenance_unchanged_copies(self):
        provenance = json.loads((HELPERS / "provenance.json").read_text())
        for relative in provenance["unchanged_copies"]:
            self.assertEqual(hashlib.sha256((HELPERS / relative).read_bytes()).hexdigest(), provenance["source_sha256"][relative])

    def test_cli_gate_before_subprocess(self):
        entry = HELPERS / "scripts/run_eval.py"
        # The fake seam is never started for any refused proposal.
        for extra in ([], ["--approved"], ["--approved", "--model", "auto", "--max-calls", "1"], ["--approved", "--model", "test-model", "--max-calls", "0"]):
            with self.subTest(extra=extra), patch.object(harnesses.subprocess, "Popen") as process, contextlib.redirect_stdout(io.StringIO()):
                code = run_eval.main([
                    "--eval-set", str(self.skill / "evals/trigger-evals.json"),
                    "--skill-path", str(self.skill), "--workspace", str(self.work / "artifacts"),
                    "--query-index", "0", *extra,
                ])
                self.assertEqual(code, 1)
                process.assert_not_called()
        self.assertTrue(entry.is_file())

    def test_budget_repetitions_and_arms(self):
        for calls in (11, 0):
            with self.assertRaises(ValueError):
                harnesses.preflight(self.args, calls)
        self.args.num_workers = 2
        with self.assertRaises(ValueError):
            harnesses.preflight(self.args, 1)

    def test_successful_trigger_and_minimal_staging(self):
        result = self.run_trigger()
        self.assertEqual(result["status"], "passed")
        staged = Path(result["snapshot"]) / ".github/skills" / result["candidate"]
        self.assertEqual([p.name for p in staged.iterdir()], ["SKILL.md"])
        self.assertNotIn("Honor the requested scope", (staged / "SKILL.md").read_text())
        self.assertTrue((Path(result["run_dir"]) / "raw.jsonl").exists())
        self.assertTrue((Path(result["run_dir"]) / "stderr.txt").exists())
        self.assertTrue((Path(result["run_dir"]) / "timing.json").exists())

    def test_negative_case_passes_only_complete_successful_no_load(self):
        result = self.run_trigger("no-load", False)
        self.assertEqual(result["status"], "passed")
        self.assertFalse(result["triggered"])

    def test_read_only_trigger_fixture_is_staged_without_prompt_injection(self):
        self.fake_cli("no-load")
        queries = run_eval.load_queries(self.skill / "evals/trigger-evals.json", [6])
        item = queries[0][1]
        result = run_eval.run_single_query(item, self.skill, self.work / "read-only", self.args)
        self.assertEqual(result["status"], "passed")
        source = self.skill / item["files"][0]
        snapshot = Path(result["snapshot"])
        self.assertEqual((snapshot / "AGENTS.md").read_bytes(), source.read_bytes())
        self.assertIn("AGENTS.md", result["input_hashes"])
        self.assertEqual((Path(result["run_dir"]) / "prompt.txt").read_text(), item["query"])
        self.assertFalse(Path(result["sandbox"]).exists())

    def test_trigger_fixture_errors_prevent_all_inference(self):
        for files in (["evals/files/missing.md"], ["../AGENTS.md"], ["evals/files/simple-repository"], ["evals/files/simple-repository/package.json"], "AGENTS.md"):
            with self.subTest(files=files):
                queries = self.work / "queries.json"
                queries.write_text(json.dumps([
                    {"query": "Initialize guidance", "should_trigger": True},
                    {"query": "Explain guidance", "should_trigger": False, "files": files},
                ]))
                with patch.object(harnesses.subprocess, "Popen") as process, contextlib.redirect_stdout(io.StringIO()):
                    code = run_eval.main([
                        "--eval-set", str(queries), "--skill-path", str(self.skill),
                        "--workspace", str(self.work / "artifacts"), "--approved",
                        "--model", "test-model", "--max-calls", "2",
                    ])
                self.assertEqual(code, 1)
                process.assert_not_called()

    def test_infrastructure_never_passes_negative_cases(self):
        for behavior, reason in [
            ("nonzero", "cli_exit"), ("malformed", "malformed_jsonl"),
            ("truncated", "incomplete_events"), ("forbidden", "forbidden_tool"),
            ("wrong-skill", "unexpected_skill_load"), ("model-error", "model_error"),
            ("model-mismatch", "model_mismatch"),
        ]:
            with self.subTest(behavior=behavior):
                result = self.run_trigger(behavior, False, behavior)
                self.assertEqual(result["status"], "error")
                self.assertFalse(result["pass"])
                self.assertEqual(result["reason"], reason)
                self.assertIsNone(result["triggered"])

    def test_timeout_preserves_partial_evidence(self):
        self.args.timeout = 0.6
        result = self.run_trigger("timeout", False)
        self.assertEqual(result["reason"], "timeout")
        self.assertTrue((Path(result["run_dir"]) / "raw.jsonl").exists())
        # Process startup can itself exceed the timeout on a loaded CI host.
        run = self.work / "deterministic-timeout"
        run.mkdir()
        process = MagicMock()
        process.__enter__.return_value = process
        process.poll.return_value = None
        process.wait.return_value = -9

        def start(*args, **kwargs):
            kwargs["stdout"].write(b'{"type":"session.start","data":{}}\n')
            kwargs["stdout"].flush()
            return process

        with patch.object(harnesses.subprocess, "Popen", side_effect=start):
            code, reason = harnesses.run_command(["fake"], run, run, 0.001, {})
        self.assertEqual(reason, "timeout")
        self.assertEqual(code, -9)
        process.kill.assert_called_once()
        self.assertIn("session.start", (run / "raw.jsonl").read_text())

    def test_case_arm_home_and_candidate_isolation(self):
        first = self.run_trigger(name="first")
        second = self.run_trigger(name="second")
        self.assertNotEqual(first["candidate"], second["candidate"])
        envs = [json.loads((Path(run["run_dir"]) / "fake-env.json").read_text()) for run in (first, second)]
        self.assertNotEqual(envs[0]["COPILOT_HOME"], envs[1]["COPILOT_HOME"])
        self.assertNotEqual(envs[0]["HOME"], envs[1]["HOME"])
        for run, env in zip((first, second), envs):
            self.assertFalse(Path(env["HOME"]).is_relative_to(Path(run["sandbox"])))

    def test_environment_does_not_inherit_auth_or_config(self):
        run = self.work / "environment"
        run.mkdir()
        with patch.dict(os.environ, {"GH_TOKEN": "secret", "NODE_OPTIONS": "untrusted", "COPILOT_ALLOW_ALL": "true", "COPILOT_HOME": "real-home"}):
            env = harnesses.isolated_environment(run, None)
        self.assertNotIn("GH_TOKEN", env)
        self.assertNotIn("NODE_OPTIONS", env)
        self.assertNotIn("COPILOT_ALLOW_ALL", env)
        run2 = self.work / "explicit-auth"
        run2.mkdir()
        with patch.dict(os.environ, {"GH_TOKEN": "secret", "GITHUB_TOKEN": "other"}):
            env = harnesses.isolated_environment(run2, "GH_TOKEN")
        self.assertEqual(env["GH_TOKEN"], "secret")
        self.assertNotIn("GITHUB_TOKEN", env)
        args = harnesses.copilot_command("task", "test-model", self.work)
        self.assertIn("--secret-env-vars=COPILOT_GITHUB_TOKEN,GH_TOKEN,GITHUB_TOKEN", args)
        self.assertIn("--deny-tool=write", args)
        task_args = harnesses.copilot_command("task", "test-model", self.work, writable_outputs=True)
        self.assertIn(f"--allow-tool=write({self.work}/outputs/AGENTS.md)", task_args)
        self.assertIn(f"--allow-tool=write({self.work}/outputs/.github/skills/code-review/SKILL.md)", task_args)
        self.assertNotIn("--allow-tool=create", task_args)
        self.assertNotIn("--allow-tool=edit", task_args)

    def test_fixture_confinement_collisions_and_links(self):
        for ref in ("../SKILL.md", "/etc/passwd", "evals/files/../../SKILL.md", "evals\\files\\x"):
            with self.subTest(ref=ref), self.assertRaises(ValueError):
                harnesses.fixture_sources([ref], self.skill)
        other = self.skill / "evals/files/other/simple-repository"
        other.mkdir(parents=True)
        with self.assertRaisesRegex(ValueError, "collision"):
            harnesses.fixture_sources(["evals/files/simple-repository", "evals/files/other/simple-repository"], self.skill)
        link = self.skill / "evals/files/simple-repository/link"
        link.symlink_to(self.skill / "SKILL.md")
        with self.assertRaisesRegex(ValueError, "Symlink"):
            harnesses.fixture_sources(["evals/files/simple-repository"], self.skill)

    def test_workspace_rejects_real_repository(self):
        with self.assertRaisesRegex(ValueError, "outside existing repositories"):
            harnesses.validate_workspace(self.work / "artifacts", self.skill)

    def test_exact_candidate_must_complete_not_merely_be_requested(self):
        events = trace()
        events.insert(2, event("assistant.message", toolRequests=[{"name": "skill", "id": "missing", "arguments": {"skill": "candidate"}}]))
        with self.assertRaisesRegex(harnesses.EvidenceError, "incomplete"):
            harnesses.parse_evidence(jsonl(events), "candidate", "test-model", self.work)
        events = trace()
        events.insert(2, event("user.message", source="skill-candidate"))
        with self.assertRaisesRegex(harnesses.EvidenceError, "unverified"):
            harnesses.parse_evidence(jsonl(events), "candidate", "test-model", self.work)

    def test_malformed_results_and_paths(self):
        for raw in ("", '{"type":"result"}\n', '{"type":"session.idle","data":{}}\n', '{"type":"assistant.message","data":[]}\n'):
            with self.subTest(raw=raw), self.assertRaises(harnesses.EvidenceError):
                harnesses.parse_evidence(raw, "candidate", "test-model", self.work)
        events = trace(views=["../grading.json"])
        with self.assertRaisesRegex(harnesses.EvidenceError, "tool_path_escape"):
            harnesses.parse_evidence(jsonl(events), "candidate", "test-model", self.work)
        events = trace()
        events.insert(2, event("unreviewed.event"))
        with self.assertRaisesRegex(harnesses.EvidenceError, "unsupported_event_type"):
            harnesses.parse_evidence(jsonl(events), "candidate", "test-model", self.work)
        events = trace()
        events[2:2] = [
            event("tool.execution_start", toolName="create", toolCallId="write", arguments={"path": ".github/hooks/unsafe.json"}),
            event("tool.execution_complete", toolCallId="write", success=True),
        ]
        with self.assertRaisesRegex(harnesses.EvidenceError, "forbidden_write_path"):
            harnesses.parse_evidence(jsonl(events), "candidate", "test-model", self.work)

    def test_supported_tasks_grade_independent_content_and_trace(self):
        for case_id in (7, 8):
            with self.subTest(case_id=case_id):
                self.fake_cli(task=True)
                result = run_harness_eval.run_one(self.task_case(case_id), "with_skill", self.skill, self.work / f"task-{case_id}", self.args)
                self.assertEqual(result["status"], "passed", result)
                run_dir = Path(result["run_dir"])
                persisted = json.loads((run_dir / "grading.json").read_text())
                self.assertEqual([e["text"] for e in persisted["expectations"]], ASSERTIONS[case_id])
                staged = Path(result["snapshot"]) / ".github/skills" / result["candidate"]
                self.assertFalse((staged / "evals").exists())
                self.assertTrue((Path(result["snapshot"]) / "inputs/simple-repository/.mcp.json").exists())
                self.assertFalse((Path(result["snapshot"]) / ".mcp.json").exists())

    def test_actual_cli_metadata_and_discovery_contamination(self):
        events = trace("candidate")
        events.extend([
            event("assistant.message_start"),
            event("assistant.tool_call_delta"),
            event("model.call_start"),
            event("model.call_finished"),
            event("model.call_final_result"),
            event("session.custom_agents_updated"),
            event("session.tools_updated"),
            event("session.usage_checkpoint"),
            event("assistant.idle"),
            {"type": "result", "exitCode": 0, "usage": {"premiumRequests": 1}},
        ])
        evidence = harnesses.parse_evidence(jsonl(events), "candidate", "test-model", self.work)
        self.assertTrue(evidence.candidate_loaded)
        discovered = next(item for item in events if item["type"] == "session.skills_loaded")
        discovered["data"]["skills"].append({"name": "personal", "source": "inherited", "enabled": True})
        with self.assertRaisesRegex(harnesses.EvidenceError, "unexpected_discovered_skill"):
            harnesses.parse_evidence(jsonl(events), "candidate", "test-model", self.work)

    def test_patch_editor_paths_and_operations_are_confined(self):
        events = trace("candidate")
        events[-2:-2] = [
            event("tool.execution_start", toolName="apply_patch", toolCallId="patch", arguments={"input": "*** Begin Patch\n*** Add File: outputs/AGENTS.md\n+Guidance\n*** End Patch\n"}),
            event("tool.execution_complete", toolCallId="patch", success=True),
        ]
        evidence = harnesses.parse_evidence(jsonl(events), "candidate", "test-model", self.work)
        self.assertIn("outputs/AGENTS.md", evidence.writes)
        for operation in ("Add File: ../grading.json", "Delete File: outputs/AGENTS.md", "Move to: outside"):
            with self.subTest(operation=operation), self.assertRaises(harnesses.EvidenceError):
                harnesses.patch_paths({"input": f"*** Begin Patch\n*** {operation}\n*** End Patch\n"}, self.work)

    def test_review_may_reference_root_validation_without_duplicating_it(self):
        out = self.work / "outputs"
        (out / ".github/skills/code-review").mkdir(parents=True)
        (out / "AGENTS.md").write_text(AGENTS)
        (out / ".github/skills/code-review/SKILL.md").write_text(REVIEW.replace("validate with npm test", "use the validation command in AGENTS.md"))
        evidence = harnesses.Evidence(candidate_loaded=True, views=sorted(REQUIRED_VIEWS | {"inputs/existing-code-review.md"}), writes=["outputs/AGENTS.md", "outputs/.github/skills/code-review/SKILL.md"])
        self.assertEqual(grade(7, ASSERTIONS[7], out, evidence)["status"], "passed")

    def test_plausible_instruction_regression_fails_content_not_existence(self):
        self.fake_cli("bad-content", task=True)
        result = run_harness_eval.run_one(self.task_case(), "with_skill", self.skill, self.work / "bad-task", self.args)
        self.assertEqual(result["status"], "failed")
        self.assertTrue((Path(result["run_dir"]) / "outputs/.github/skills/code-review/SKILL.md").is_file())

    def test_fixture_changes_fail_and_cannot_forge_grading(self):
        self.fake_cli("scope", task=True)
        result = run_harness_eval.run_one(self.task_case(), "with_skill", self.skill, self.work / "scope-task", self.args)
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["reason"], "write_scope_violation")

    def test_missing_ambiguous_and_incomplete_grades_never_pass(self):
        self.assertEqual(verify_grading({}, ASSERTIONS[8]), "error")
        self.assertEqual(verify_grading({"status": "passed", "expectations": []}, ASSERTIONS[8]), "error")
        self.assertEqual(verify_grading({"status": "passed", "expectations": [{"text": "x", "passed": True}]}, ["x"]), "error")
        out = self.work / "outputs"
        (out / ".github/skills/code-review").mkdir(parents=True)
        (out / "AGENTS.md").write_text(AGENTS)
        (out / ".github/skills/code-review/SKILL.md").write_text(REVIEW + "\nYou must obtain a certification.\n")
        evidence = harnesses.Evidence(candidate_loaded=True, views=sorted(REQUIRED_VIEWS), writes=["outputs/AGENTS.md", "outputs/.github/skills/code-review/SKILL.md"])
        result = grade(8, ASSERTIONS[8], out, evidence)
        self.assertEqual(result["status"], "not_run")
        self.assertIsNone(result["expectations"][4]["passed"])
        self.assertEqual(verify_grading(result, ASSERTIONS[8]), "not_run")
        self.assertEqual(grade(8, ["Unprovable"], out, evidence)["status"], "not_run")

    def test_invented_requirements_and_negated_commands_do_not_pass(self):
        out = self.work / "outputs"
        (out / ".github/skills/code-review").mkdir(parents=True)
        (out / "AGENTS.md").write_text(AGENTS)
        review = out / ".github/skills/code-review/SKILL.md"
        evidence = harnesses.Evidence(candidate_loaded=True, views=sorted(REQUIRED_VIEWS), writes=["outputs/AGENTS.md", "outputs/.github/skills/code-review/SKILL.md"])
        for addition in ("\nUse a PostgreSQL emulator for output.\n", "\nObtain legal signoff.\n"):
            review.write_text(REVIEW + addition)
            self.assertEqual(grade(8, ASSERTIONS[8], out, evidence)["status"], "not_run")
        review.write_text(REVIEW.replace("validate with npm test", "never run npm test"))
        self.assertEqual(grade(8, ASSERTIONS[8], out, evidence)["status"], "failed")

    def test_filters_reject_unknown_duplicate_unsupported_cases(self):
        for ids in ([99], [7, 7], [1]):
            with self.subTest(ids=ids), self.assertRaises(ValueError):
                run_harness_eval.load_evals(self.skill / "evals/evals.json", ids, self.skill)
        for indexes in ([-1], [999], [0, 0]):
            with self.subTest(indexes=indexes), self.assertRaises(ValueError):
                run_eval.load_queries(self.skill / "evals/trigger-evals.json", indexes)

    def test_entrypoints_aggregate_and_exit_nonzero_on_infrastructure_errors(self):
        self.fake_cli("nonzero")
        workspace = self.work / "artifacts"

        def isolated_test_workspace(path, skill):
            # The real boundary is separately tested. No real CLI is used here.
            path.mkdir(exist_ok=True)
            return path

        shared = ["--skill-path", str(self.skill), "--workspace", str(workspace),
                  "--approved", "--model", "test-model", "--max-calls", "2", "--cli", self.args.cli]
        with patch.object(run_eval, "validate_workspace", side_effect=isolated_test_workspace), contextlib.redirect_stdout(io.StringIO()):
            code = run_eval.main([*shared, "--eval-set", str(self.skill / "evals/trigger-evals.json"), "--query-index", "0"])
        self.assertEqual(code, 1)
        manifest_path = next(workspace.glob("trigger-*/execution_manifest.json"))
        manifest = json.loads(manifest_path.read_text())
        self.assertEqual(manifest["status"], "error")
        self.assertEqual(manifest["summary"]["errors"], 1)
        self.assertIsNone(manifest["results"][0]["trigger_rate"])
        with patch.object(run_harness_eval, "validate_workspace", side_effect=isolated_test_workspace), contextlib.redirect_stdout(io.StringIO()):
            code = run_harness_eval.main([*shared, "--evals", str(self.skill / "evals/evals.json"), "--case-id", "8"])
        self.assertEqual(code, 1)
        manifest = json.loads((workspace / "iteration-1/execution_manifest.json").read_text())
        self.assertEqual(manifest["status"], "error")
        self.assertFalse(list(workspace.glob("iteration-1/**/grading.json")))


if __name__ == "__main__":
    unittest.main()
