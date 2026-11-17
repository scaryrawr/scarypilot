"""Model-free regression tests for the shipped skill-creator helpers."""

import contextlib
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
import zipfile

SKILL = Path(__file__).resolve().parents[1] / "skills/skill-creator"
sys.path.insert(0, str(SKILL))

from scripts import generate_report, harnesses, package_skill, quick_validate, run_eval, run_harness_eval

spec = importlib.util.spec_from_file_location("review_viewer", SKILL / "eval-viewer/generate_review.py")
viewer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(viewer)


class HelperTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="skill-creator-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.skill = self.root / "sample"
        self.skill.mkdir()
        (self.skill / "SKILL.md").write_text("---\nname: sample\ndescription: A sample workflow.\n---\n")

    def test_validation_rejects_empty_required_values(self):
        for field in ("name", "description"):
            for value in ("", "   ", '""', "'   '", "|\n  "):
                with self.subTest(field=field, value=value):
                    fields = {"name": "sample", "description": "A workflow"}
                    fields[field] = value
                    (self.skill / "SKILL.md").write_text(
                        f"---\nname: {fields['name']}\ndescription: {fields['description']}\n---\n"
                    )
                    self.assertFalse(quick_validate.validate_skill(self.skill)[0])

    def test_validation_rejects_unsupported_or_invalid_yaml(self):
        for description in ("Clean CSV: normalize headers", '"unterminated', "'unterminated", "[a, b]", "{a: b}"):
            with self.subTest(description=description):
                (self.skill / "SKILL.md").write_text(f"---\nname: sample\ndescription: {description}\n---\n")
                self.assertFalse(quick_validate.validate_skill(self.skill)[0])
        for extra in ("\n  nested: value", "\nname: duplicate", "\ninvalid line"):
            with self.subTest(extra=extra):
                (self.skill / "SKILL.md").write_text(f"---\nname: sample\ndescription: A workflow{extra}\n---\n")
                self.assertFalse(quick_validate.validate_skill(self.skill)[0])

    def test_validation_accepts_supported_scalar_styles(self):
        for description in ('"Clean CSV: normalize headers"', "'Clean CSV: normalize headers'", "|\n  Clean CSV: normalize headers", ">-\n  Clean CSV\n  safely"):
            with self.subTest(description=description):
                (self.skill / "SKILL.md").write_text(f"---\nname: sample\ndescription: {description}\n---\n")
                self.assertTrue(quick_validate.validate_skill(self.skill)[0])

    def test_packaging_does_not_include_its_destination(self):
        for destination in (self.skill, self.skill / "dist"):
            with self.subTest(destination=destination), contextlib.redirect_stdout(io.StringIO()):
                archive = package_skill.package_skill(self.skill, destination)
                self.assertIsNotNone(archive)
                with zipfile.ZipFile(archive) as zipped:
                    self.assertNotIn(f"sample/{archive.relative_to(self.skill).as_posix()}", zipped.namelist())
                    self.assertIn("sample/SKILL.md", zipped.namelist())
                archive.unlink()
        with contextlib.chdir(self.skill), contextlib.redirect_stdout(io.StringIO()):
            archive = package_skill.package_skill(self.skill)
            with zipfile.ZipFile(archive) as zipped:
                self.assertEqual(zipped.namelist(), ["sample/SKILL.md"])

    def test_report_handles_null_test_results(self):
        result = {"query": "Create a skill", "should_trigger": True, "runs": 1, "triggers": 1, "pass": True}
        page = generate_report.generate_html({
            "holdout": 0,
            "history": [{"iteration": 1, "train_results": [result], "test_results": None, "train_passed": 1}],
        })
        self.assertIn("Create a skill", page)

    def test_viewer_embeds_nested_outputs_with_relative_names(self):
        run = self.root / "run-1"
        outputs = run / "outputs"
        for relative in ("sample/SKILL.md", "sample/evals/evals.json", "other/SKILL.md", "transcript.md"):
            file = outputs / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(relative)
        data = viewer.build_run(self.root, run)
        self.assertEqual(
            {file["name"] for file in data["outputs"]},
            {"sample/SKILL.md", "sample/evals/evals.json", "other/SKILL.md"},
        )

    def test_viewer_data_cannot_close_the_script_element(self):
        text = "</ScRiPt><script>unexpected()</script><!--"
        runs = [{"id": "run-1", "prompt": text, "outputs": [{"name": "sample.html", "type": "text", "content": text}]}]
        page = viewer.generate_html(runs, text)
        embedded = re.search(r"const EMBEDDED_DATA = (.*);", page).group(1)
        self.assertNotIn("<", embedded)
        self.assertEqual(json.loads(embedded)["runs"], runs)

    def test_viewer_occupied_port_does_not_terminate_processes(self):
        (self.root / "outputs").mkdir()
        server = Mock()
        server.server_address = ("127.0.0.1", 43117)
        server.serve_forever.side_effect = KeyboardInterrupt
        process_result = subprocess.CompletedProcess([], 0, stdout="12345\n", stderr="")
        with (
            patch.object(sys, "argv", ["generate_review.py", str(self.root)]),
            patch.object(viewer, "HTTPServer", side_effect=[OSError("occupied"), server]) as bind,
            patch.object(viewer.webbrowser, "open"),
            patch("subprocess.run", return_value=process_result),
            patch("os.kill") as kill,
            contextlib.redirect_stdout(io.StringIO()),
        ):
            viewer.main()
        kill.assert_not_called()
        self.assertEqual(bind.call_args_list[1].args[0], ("127.0.0.1", 0))

    def test_dismissing_completion_preserves_submitted_reviews(self):
        script = """
const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const template = fs.readFileSync(process.argv[1], "utf8");
const source = template.split("<script>")[1].split("// ---- Start ----")[0]
  .replace("/*__EMBEDDED_DATA__*/", 'const EMBEDDED_DATA = { runs: [{ id: "one" }, { id: "two" }] };');
const requests = [];
const timers = new Map();
const elements = new Map();
const document = {
  addEventListener() {},
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, { value: "", classList: { add() {}, remove() {} } });
    return elements.get(id);
  },
};
const context = vm.createContext({
  document, Date, console,
  fetch: async (url, options) => { requests.push(JSON.parse(options.body)); },
  setTimeout: (callback) => { const id = timers.size + 1; timers.set(id, callback); return id; },
  clearTimeout: (id) => timers.delete(id),
});
vm.runInContext(source, context);
(async () => {
  vm.runInContext("showDoneDialog()", context);
  await new Promise(resolve => setImmediate(resolve));
  vm.runInContext("closeDoneDialog()", context);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].status, "complete");
  assert.equal(requests[0].reviews.length, 2);
  assert.ok(requests[0].reviews.every(review => review.feedback === ""));
  vm.runInContext("saveTimeout = setTimeout(() => saveCurrentFeedback(), 800); showDoneDialog()", context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(timers.size, 0);
  assert.equal(requests.at(-1).status, "complete");
})();
"""
        result = subprocess.run(
            ["node", "-e", script, str(SKILL / "eval-viewer/viewer.html")],
            capture_output=True, text=True, timeout=15,
        )
        self.assertEqual(result.returncode, 0, result.stderr)


class EvalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="skill-eval-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.skill = self.root / "sample"
        self.skill.mkdir()
        (self.skill / "SKILL.md").write_text("---\nname: sample\ndescription: A sample workflow.\n---\n")
        self.project = self.root / "project"
        self.project.mkdir()
        (self.project / "seed.txt").write_text("Seed context")
        self.log = self.root / "calls.jsonl"
        executable = self.root / "copilot"
        executable.write_text(f"""#!{sys.executable}
import json, os, pathlib, sys
root = pathlib.Path.cwd()
prompt = sys.argv[sys.argv.index('-p') + 1]
skills = sorted(p.name for p in (root / '.github/skills').glob('*'))
with open(os.environ['SKILL_CREATOR_TEST_LOG'], 'a') as log:
    log.write(json.dumps({{'root': str(root), 'skills': skills, 'dirty': (root / 'changed.txt').exists(), 'seed': (root / 'seed.txt').exists()}}) + '\\n')
(root / 'changed.txt').write_text('Agent mutation')
if prompt in ('failure', 'timeout'):
    print('Synthetic execution failure', file=sys.stderr)
    sys.exit(124 if prompt == 'timeout' else 1)
if prompt == 'original':
    candidate = 'sample'
else:
    candidate = skills[0] if skills else None
if candidate and prompt != 'negative':
    print(json.dumps({{'type': 'tool.execution_start', 'data': {{'toolName': 'skill', 'arguments': {{'skill': candidate}}}}}}))
print(json.dumps({{'type': 'assistant.message', 'data': {{'content': 'Done'}}}}))
""")
        executable.chmod(0o755)
        env = patch.dict(os.environ, {
            "PATH": str(self.root) + os.pathsep + os.environ.get("PATH", ""),
            "SKILL_CREATOR_TEST_LOG": str(self.log),
        })
        env.start()
        self.addCleanup(env.stop)

    def evaluate(self, queries, workers=1):
        return run_eval.run_eval(
            [{"query": query, "should_trigger": expected} for query, expected in queries],
            "sample", self.skill, "A candidate description", workers, 5, self.project,
        )

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def test_seed_context_keeps_dependencies_without_sharing_links_or_git_metadata(self):
        dependency = self.project / "node_modules/example/index.js"
        dependency.parent.mkdir(parents=True)
        dependency.write_text("export const value = 1;")
        shared = self.root / "shared.txt"
        shared.write_text("Original")
        (self.project / "linked.txt").symlink_to(shared)
        (self.project / ".git").write_text("gitdir: /not-the-eval-repository")
        with harnesses.resolve_eval_root(self.project) as root:
            self.assertEqual((root / "node_modules/example/index.js").read_text(), dependency.read_text())
            self.assertFalse((root / "linked.txt").is_symlink())
            (root / "linked.txt").write_text("Changed")
            self.assertTrue((root / ".git").is_dir())
        self.assertEqual(shared.read_text(), "Original")
        self.assertEqual((self.project / ".git").read_text(), "gitdir: /not-the-eval-repository")

    def test_original_installed_skill_is_not_candidate_evidence(self):
        report = self.evaluate([("original", True)])
        self.assertEqual(report["results"][0]["triggers"], 0)
        self.assertFalse(report["results"][0]["pass"])

    def test_infrastructure_failures_abort_instead_of_passing_negative_cases(self):
        for query in ("failure", "timeout"):
            with self.subTest(query=query), self.assertRaises(RuntimeError):
                self.evaluate([(query, False)])

    def test_staging_failure_aborts_instead_of_passing_negative_case(self):
        missing = self.root / "missing"
        with self.assertRaises(FileNotFoundError):
            run_eval.run_eval([{"query": "negative", "should_trigger": False}],
                              "missing", missing, "A candidate", 1, 5, self.project)

    def test_parallel_and_serial_trigger_runs_have_fresh_discovery_roots(self):
        for workers in (1, 3):
            with self.subTest(workers=workers):
                report = self.evaluate([("positive-one", True), ("positive-two", True), ("negative", False)], workers)
                self.assertEqual(report["summary"]["passed"], 3)
        calls = self.calls()
        self.assertEqual(len({call["root"] for call in calls}), 6)
        self.assertTrue(all(len(call["skills"]) == 1 and not call["dirty"] and call["seed"] for call in calls))
        self.assertFalse((self.project / "changed.txt").exists())

    def test_task_runs_do_not_share_candidate_or_mutations(self):
        def run(index, config):
            return run_harness_eval.run_one(
                "copilot", {"prompt": "Do the task", "files": []}, config, self.skill,
                self.project, self.root / f"run-{index}", None, 5,
            )

        run(0, "with_skill")
        run(1, "without_skill")
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(run, 2, "with_skill"), executor.submit(run, 3, "without_skill")]
            for future in futures:
                self.assertEqual(future.result()["exit_code"], 0)
        calls = self.calls()
        self.assertEqual(len({call["root"] for call in calls}), 4)
        self.assertEqual(sorted(len(call["skills"]) for call in calls), [0, 0, 1, 1])
        self.assertTrue(all(not call["dirty"] and call["seed"] for call in calls))
        self.assertFalse((self.project / "changed.txt").exists())


if __name__ == "__main__":
    unittest.main()
