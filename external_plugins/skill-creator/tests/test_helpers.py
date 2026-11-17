"""Model-free regression tests for the shipped skill-creator helpers."""

import contextlib
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import io
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch
import zipfile

SKILL = Path(__file__).resolve().parents[1] / "skills/skill-creator"
sys.path.insert(0, str(SKILL))

from scripts import aggregate_benchmark, generate_report, harnesses, package_skill, quick_validate, run_eval, run_harness_eval, run_loop

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

    def test_validation_requires_a_complete_closing_delimiter(self):
        for closing in ("---not-a-delimiter", "--- # not a delimiter"):
            with self.subTest(closing=closing):
                (self.skill / "SKILL.md").write_text(
                    f"---\nname: sample\ndescription: A workflow\n{closing}\nBody\n"
                )
                self.assertFalse(quick_validate.validate_skill(self.skill)[0])
        (self.skill / "SKILL.md").write_text("---\nname: sample\ndescription: A workflow\n---")
        self.assertTrue(quick_validate.validate_skill(self.skill)[0])

    def test_required_values_reject_plain_non_string_yaml_scalars(self):
        for value in ("null", "Null", "~", "true", "FALSE", "123", "1.5", "1e3", "0x10", ".NaN"):
            with self.subTest(value=value):
                (self.skill / "SKILL.md").write_text(f"---\nname: sample\ndescription: {value}\n---\n")
                self.assertFalse(quick_validate.validate_skill(self.skill)[0])
                (self.skill / "SKILL.md").write_text(f"---\nname: sample\ndescription: '{value}'\n---\n")
                self.assertTrue(quick_validate.validate_skill(self.skill)[0])
        for value, expected in (("123", False), ('"123"', True)):
            (self.skill / "SKILL.md").write_text(f"---\nname: {value}\ndescription: A workflow\n---\n")
            self.assertEqual(quick_validate.validate_skill(self.skill)[0], expected)

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

    def test_benchmark_reads_tokens_independently_of_duration(self):
        run = self.root / "eval-1/copilot_with_skill/run-1"
        run.mkdir(parents=True)
        for grading_timing, sibling_timing, expected_time, expected_tokens in (
            ({"total_duration_seconds": 2}, {"total_duration_seconds": 3, "total_tokens": 123}, 2, 123),
            ({"total_duration_seconds": 2, "total_tokens": 456}, {}, 2, 456),
            ({"total_tokens": 789}, {"total_duration_seconds": 3, "total_tokens": 123}, 3, 789),
            ({"total_duration_seconds": 2, "total_tokens": 0}, {"total_tokens": 123}, 2, 0),
        ):
            with self.subTest(grading_timing=grading_timing):
                (run / "grading.json").write_text(json.dumps({
                    "timing": grading_timing, "execution_metrics": {"output_chars": 9999},
                }))
                (run / "timing.json").write_text(json.dumps(sibling_timing))
                result = aggregate_benchmark.load_run_results(self.root)["copilot_with_skill"][0]
                self.assertEqual(result["time_seconds"], expected_time)
                self.assertEqual(result["tokens"], expected_tokens)

    def test_holdout_rejects_empty_training_sets(self):
        minimal = [{"query": "yes", "should_trigger": True}, {"query": "no", "should_trigger": False}]
        with self.assertRaisesRegex(ValueError, "training"):
            run_loop.split_eval_set(minimal, 0.4)
        self.assertEqual(run_loop.split_eval_set(minimal, 0), (minimal, []))
        training, held_out = run_loop.split_eval_set(minimal * 2, 0.4)
        self.assertEqual(len(training), 2)
        self.assertEqual(len(held_out), 2)

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

    def test_viewer_loads_metadata_from_the_task_eval_directory(self):
        run = self.root / "eval-7-example/copilot_with_skill/run-1"
        (run / "outputs").mkdir(parents=True)
        prompt = "Create a document.\n\n## Required section\n\nKeep this heading."
        (run.parent.parent / "eval_metadata.json").write_text(json.dumps({
            "eval_id": 7, "prompt": prompt,
        }))
        (run / "transcript.md").write_text("## Eval Prompt\n\n" + prompt + "\n\n## STDOUT\n\nDone")
        data = viewer.build_run(self.root, run)
        self.assertEqual(data["eval_id"], 7)
        self.assertEqual(data["prompt"], prompt)

    def test_timeout_stops_spawned_tools_before_they_write_later(self):
        marker = self.root / "late-write.txt"
        child = "import time,sys; from pathlib import Path; time.sleep(1); Path(sys.argv[1]).write_text('late')"
        parent = (
            "import subprocess,sys,time; "
            f"subprocess.Popen([sys.executable, '-c', {child!r}, {str(marker)!r}]); "
            "print('child started', flush=True); time.sleep(30)"
        )
        code, stdout, stderr, _ = harnesses.run_command(
            [sys.executable, "-c", parent], self.root, timeout=0.5,
        )
        self.assertEqual(code, 124)
        self.assertIn("child started", stdout)
        self.assertIn("Timed out", stderr)
        time.sleep(1.2)
        self.assertFalse(marker.exists(), "A spawned tool survived the eval timeout")

    def test_command_capture_preserves_stdin_environment_and_failure_details(self):
        code, stdout, stderr, _ = harnesses.run_command(
            [sys.executable, "-c",
             "import os,sys; print(sys.stdin.read() + os.environ['HELPER_CASE']); "
             "print('Failure detail', file=sys.stderr); sys.exit(3)"],
            self.root, timeout=5, stdin="Input: ", env={**os.environ, "HELPER_CASE": "value"},
        )
        self.assertEqual((code, stdout, stderr), (3, "Input: value\n", "Failure detail\n"))

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

    def run_viewer_script(self, assertions):
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
const downloads = [];
let responseStatus = 200;
let serverFeedback = { reviews: [] };
const document = {
  addEventListener() {},
  querySelector() { return { scrollTop: 0 }; },
  createElement() {
    return {
      textContent: "",
      get innerHTML() {
        return this.textContent.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      },
      click() {},
    };
  },
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, {
      value: "", style: {}, classList: { add() {}, remove() {} }, addEventListener() {},
    });
    return elements.get(id);
  },
};
const context = vm.createContext({
  document, Date, console,
  Blob,
  URL: { createObjectURL(blob) { downloads.push(blob); return "blob:test"; }, revokeObjectURL() {} },
  fetch: async (url, options) => {
    if (!options) return { ok: true, json: async () => serverFeedback };
    requests.push(JSON.parse(options.body));
    return { ok: responseStatus < 400, status: responseStatus };
  },
  setTimeout: (callback) => { const id = timers.size + 1; timers.set(id, callback); return id; },
  clearTimeout: (id) => timers.delete(id),
});
vm.runInContext(source, context);
""" + assertions
        result = subprocess.run(
            ["node", "-e", script, str(SKILL / "eval-viewer/viewer.html")],
            capture_output=True, text=True, timeout=15,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_dismissing_completion_preserves_submitted_reviews(self):
        self.run_viewer_script("""
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
""")

    def test_failed_feedback_writes_download_instead_of_claiming_success(self):
        self.run_viewer_script("""
(async () => {
  for (const status of [405, 500]) {
    responseStatus = status;
    vm.runInContext("saveCurrentFeedback()", context);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(document.getElementById("feedback-status").textContent, "Will download on submit");
    vm.runInContext("showDoneDialog()", context);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(downloads.length, status === 405 ? 1 : 2);
    const saved = JSON.parse(await downloads.at(-1).text());
    assert.equal(saved.status, "complete");
    assert.equal(saved.reviews.length, 2);
  }
})();
""")

    def test_current_feedback_is_loaded_when_previous_feedback_is_embedded(self):
        self.run_viewer_script("""
(async () => {
  serverFeedback = { reviews: [
    { run_id: "one", feedback: "Current first review" },
    { run_id: "two", feedback: "Current second review" },
  ] };
  vm.runInContext('EMBEDDED_DATA.previous_feedback = { one: "Old iteration review" }', context);
  await vm.runInContext("init()", context);
  assert.equal(document.getElementById("feedback").value, "Current first review");
  vm.runInContext("navigate(1)", context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(document.getElementById("feedback").value, "Current second review");
  assert.equal(requests[0].reviews.length, 2);
  assert.equal(requests[0].reviews[1].feedback, "Current second review");
})();
""")

    def test_benchmark_configuration_labels_are_text_not_markup(self):
        output = self.run_viewer_script("""
vm.runInContext(`EMBEDDED_DATA.benchmark = {
  runs: [{ eval_id: 1, configuration: "copilot_<img src=x onerror=unexpected()>", run_number: 1 }]
}; renderBenchmark();`, context);
console.log(JSON.stringify(document.getElementById("benchmark-content").innerHTML));
""")

        class Markup(HTMLParser):
            def __init__(self):
                super().__init__()
                self.tags = []
                self.text = []

            def handle_starttag(self, tag, attrs):
                self.tags.append(tag)

            def handle_data(self, data):
                self.text.append(data)

        parsed = Markup()
        parsed.feed(json.loads(output))
        self.assertNotIn("img", parsed.tags)
        self.assertEqual(parsed.text.count("Copilot <Img Src=X Onerror=Unexpected()>"), 2)

    def test_benchmark_evidence_remains_a_single_title_attribute(self):
        evidence = '" onmouseover="unexpected()" data-note="<unsafe>&'
        output = self.run_viewer_script("""
context.evidence = '" onmouseover="unexpected()" data-note="<unsafe>&';
vm.runInContext(`EMBEDDED_DATA.benchmark = {
  runs: [{ eval_id: 1, configuration: "with_skill", run_number: 1,
    expectations: [{ text: "A check", passed: true, evidence }] }]
}; renderBenchmark();`, context);
console.log(JSON.stringify(document.getElementById("benchmark-content").innerHTML));
""")

        class Attributes(HTMLParser):
            def __init__(self):
                super().__init__()
                self.spans = []

            def handle_starttag(self, tag, attrs):
                if tag == "span":
                    self.spans.append(dict(attrs))

        parsed = Attributes()
        parsed.feed(json.loads(output))
        titles = [attrs for attrs in parsed.spans if "title" in attrs]
        self.assertEqual(len(titles), 1)
        self.assertEqual(titles[0]["title"], "Run 1: " + evidence)
        self.assertNotIn("onmouseover", titles[0])


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
import json, os, pathlib, sys, time
root = pathlib.Path.cwd()
prompt = sys.argv[sys.argv.index('-p') + 1]
skills = sorted(p.name for p in (root / '.github/skills').glob('*'))
with open(os.environ['SKILL_CREATOR_TEST_LOG'], 'a') as log:
    log.write(json.dumps({{'root': str(root), 'skills': skills, 'query': prompt, 'dirty': (root / 'changed.txt').exists(), 'seed': (root / 'seed.txt').exists()}}) + '\\n')
(root / 'changed.txt').write_text('Agent mutation')
if prompt.startswith('slow-'):
    time.sleep(0.15)
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
print(json.dumps({{'usage': {{os.environ.get('SKILL_CREATOR_TOKEN_KEY', 'totalTokens'): 789}}}}))
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

    def test_empty_training_split_is_rejected_before_agent_execution(self):
        minimal = [{"query": "yes", "should_trigger": True}, {"query": "no", "should_trigger": False}]
        for eval_set, holdout in ((minimal, 0.4), ([], 0)):
            with self.subTest(holdout=holdout), self.assertRaisesRegex(ValueError, "training"):
                run_loop.run_loop(
                    eval_set, self.skill, None, 1, 5, 1, 1, 0.5, holdout, None, "copilot", False,
                )
        self.assertFalse(self.log.exists())

    def test_infrastructure_failures_abort_instead_of_passing_negative_cases(self):
        for query in ("failure", "timeout"):
            with self.subTest(query=query), self.assertRaises(RuntimeError):
                self.evaluate([(query, False)])

    def test_trigger_batch_cancels_queued_queries_on_failure(self):
        queries = [("failure", False)] + [(f"slow-{index}", True) for index in range(8)]
        with self.assertRaises(RuntimeError):
            self.evaluate(queries)
        calls = self.calls()
        self.assertLess(len(calls), len(queries))
        self.assertNotIn("slow-7", [call["query"] for call in calls])

    def test_task_usage_accepts_camel_and_snake_case_token_events(self):
        for key in ("totalTokens", "total_tokens"):
            with self.subTest(key=key), patch.dict(os.environ, {"SKILL_CREATOR_TOKEN_KEY": key}):
                run_dir = self.root / key
                run_harness_eval.run_one(
                    "copilot", {"prompt": "Do the task"}, "with_skill", self.skill,
                    self.project, run_dir, None, 5,
                )
                self.assertEqual(json.loads((run_dir / "timing.json").read_text())["total_tokens"], 789)

    def test_same_name_fixtures_keep_distinct_contents_and_basenames(self):
        references = ["evals/files/before/data.csv", "evals/files/after/data.csv"]
        for reference, contents in zip(references, ("before", "after")):
            path = self.skill / reference
            path.parent.mkdir(parents=True)
            path.write_text(contents)
        copied = run_harness_eval.copy_input_files(references, self.skill, self.root / "run")
        self.assertEqual([Path(path).read_text() for path in copied], ["before", "after"])
        self.assertEqual([Path(path).name for path in copied], ["data.csv", "data.csv"])
        self.assertEqual(len(set(copied)), 2)

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

    def test_task_run_refuses_existing_artifacts_and_grades(self):
        run_dir = self.root / "existing-run"
        (run_dir / "outputs").mkdir(parents=True)
        (run_dir / "outputs/old.txt").write_text("Old result")
        (run_dir / "grading.json").write_text('{"summary":{"pass_rate":1}}')
        with self.assertRaises(FileExistsError):
            run_harness_eval.run_one(
                "copilot", {"prompt": "Do the task"}, "with_skill", self.skill,
                self.project, run_dir, None, 5,
            )
        self.assertFalse(self.log.exists())
        self.assertEqual((run_dir / "outputs/old.txt").read_text(), "Old result")

    def test_task_cli_refuses_existing_iteration_before_agent_execution(self):
        workspace = self.root / "workspace"
        iteration = workspace / "iteration-1"
        iteration.mkdir(parents=True)
        metadata = iteration / "eval_metadata.json"
        metadata.write_text("Old metadata")
        evals = self.root / "evals.json"
        evals.write_text(json.dumps({"evals": [{"id": 1, "prompt": "Do the task"}]}))
        result = subprocess.run(
            [sys.executable, str(SKILL / "scripts/run_harness_eval.py"),
             "--evals", str(evals), "--skill-path", str(self.skill), "--workspace", str(workspace)],
            capture_output=True, text=True, timeout=15,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("FileExistsError", result.stderr)
        self.assertFalse(self.log.exists())
        self.assertEqual(metadata.read_text(), "Old metadata")


if __name__ == "__main__":
    unittest.main()
