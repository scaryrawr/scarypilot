"""Restricted Better-init pilot using native Codex and a local oMLX provider."""

import argparse
from collections import deque
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import selectors
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request


ROOT = Path(__file__).resolve().parents[2]
SKILL = ROOT / "plugins/better-init/skills/better-init"
MODEL = "Qwen3.6-35B-A3B-oQ6e-mtp"
PROFILE = "guidance"


@dataclass(frozen=True)
class Case:
    kind: str
    identifier: int
    prompt: str
    fixtures: tuple[Path, ...]
    expectations: tuple[str, ...] = ()
    should_trigger: bool | None = None


def load_cases() -> list[Case]:
    triggers = json.loads((SKILL / "evals/trigger-evals.json").read_text())
    tasks = {case["id"]: case for case in json.loads(
        (SKILL / "evals/evals.json").read_text()
    )["evals"]}
    cases = []
    for kind, identifier in (("trigger", 8), ("trigger", 6), ("task", 108), ("task", 109)):
        source = triggers[identifier] if kind == "trigger" else tasks[identifier]
        fixtures = []
        for value in source.get("files", []):
            fixture = SKILL / value
            if not fixture.resolve().is_relative_to(SKILL / "evals/files"):
                raise ValueError(f"Fixture escaped its declared root: {value}")
            entries = [fixture, *fixture.rglob("*")] if fixture.is_dir() else [fixture]
            if not fixture.exists() or any(entry.is_symlink() for entry in entries):
                raise ValueError(f"Missing or symlinked fixture: {value}")
            fixtures.append(fixture)
        if len({fixture.name for fixture in fixtures}) != len(fixtures):
            raise ValueError("Flattened fixture-name collision")
        cases.append(Case(kind, identifier, source.get("query", source.get("prompt")),
                          tuple(fixtures), tuple(source.get("expectations", [])),
                          source.get("should_trigger")))
    return cases


def hashes(directory: Path, excluded: str | None = None) -> dict[str, str]:
    result = {}
    for entry in sorted(directory.rglob("*")):
        relative = entry.relative_to(directory)
        if excluded and relative.parts[0] == excluded:
            continue
        if entry.is_symlink():
            raise ValueError(f"Unexpected symlink: {relative}")
        if entry.is_file():
            result[str(relative)] = hashlib.sha256(entry.read_bytes()).hexdigest()
    return result


def configure(home: Path, project: Path, codex: Path) -> dict[str, str]:
    grants = {
        ":minimal": "read",
        str(project): "read",
        str(project / "outputs"): "write",
        str(project / "outputs/.agents"): "write",
        str(codex): "read",
        "/bin": "read",
        "/usr/bin": "read",
        "/usr/lib": "read",
        "/System/Library": "read",
        "/Library/Apple/System/Library": "read",
        "/private/tmp": "deny",
        "/private/var/tmp": "deny",
        "/Application[s]": "deny",
        "/Applications/**": "deny",
    }
    config = [
        f'default_permissions = "{PROFILE}"',
        'approval_policy = "never"',
        'web_search = "disabled"',
        'check_for_update_on_startup = false',
        '[analytics]',
        'enabled = false',
        '[feedback]',
        'enabled = false',
        '[history]',
        'persistence = "none"',
        '[agents]',
        'enabled = false',
        '[features]',
        *[f"{feature} = false" for feature in (
            "apps", "plugins", "hooks", "multi_agent_v2", "memories",
            "shell_snapshot", "skill_mcp_dependency_install",
            "remote_models", "enable_request_compression",
        )],
        '[model_providers.omlx]',
        'name = "oMLX"',
        'request_max_retries = 0',
        'stream_max_retries = 0',
        f'[permissions.{PROFILE}.filesystem]',
        *[f"{json.dumps(path)} = {json.dumps(access)}" for path, access in grants.items()],
        f'[permissions.{PROFILE}.network]',
        'enabled = false',
    ]
    (home / "config.toml").write_text("\n".join(config) + "\n")
    return grants


def verify_file_access(codex: Path, project: Path, env: dict[str, str], artifacts: Path) -> dict:
    output = project / "outputs"
    candidate = project / ".agents/skills/better-init/SKILL.md"
    original = candidate.read_bytes()
    canary = project.parent / "private-canary.txt"
    canary.write_text("private native control\n")
    escape = project.parent / "escape.txt"
    read_link = project / "read-control"
    read_link.symlink_to(canary)
    write_link = output / "write-control"
    write_link.symlink_to(project.parent, target_is_directory=True)
    write_guidance = (
        'mkdir -p "$1/.agents/skills/code-review" "$1/.agents/skills/review-contracts"'
        ' && printf control > "$1/AGENTS.md"'
        ' && printf control > "$1/.agents/skills/code-review/SKILL.md"'
        ' && printf control > "$1/.agents/skills/review-contracts/SKILL.md"'
    )
    probes = [
        ("candidate_read", ["/bin/cat", str(candidate)], True),
        ("native_guidance_write", ["/bin/sh", "-c", write_guidance, "control", str(output)], True),
        ("input_write", ["/bin/sh", "-c", 'printf changed > "$1"', "control", str(candidate)], False),
        ("outside_read", ["/bin/cat", str(canary)], False),
        ("outside_write", ["/bin/sh", "-c", 'printf escaped > "$1"', "control", str(escape)], False),
        ("symlink_read_escape", ["/bin/cat", str(read_link)], False),
        ("symlink_write_escape", ["/bin/sh", "-c", 'printf escaped > "$1/escape.txt"',
                                  "control", str(write_link)], False),
        ("loopback_network", ["/usr/bin/curl", "--noproxy", "*", "--connect-timeout", "2",
                              "--max-time", "3", "--fail", "--silent", "--show-error",
                              "http://127.0.0.1:8000/health"], False),
    ]
    report = {"inference_calls": 0, "probes": [], "status": "error"}
    try:
        for name, command, permitted in probes:
            process = subprocess.run(
                [str(codex), "sandbox", "-P", PROFILE, "-C", str(project), "--", *command],
                cwd=project, env=env, capture_output=True, timeout=15,
            )
            passed = process.returncode == 0 if permitted else 0 < process.returncode < 128
            if name == "candidate_read":
                passed = passed and process.stdout == original
            report["probes"].append({
                "name": name, "exit_code": process.returncode, "passed": passed,
                "stderr": process.stderr.decode(errors="replace")[:2000],
            })
        report["integrity"] = {
            "candidate_unchanged": candidate.read_bytes() == original,
            "canary_unchanged": canary.read_text() == "private native control\n",
            "no_escape": not escape.exists(),
            "exact_guidance_destinations_writable": all(
                (output / name).is_file() and (output / name).read_text() == "control"
                for name in ("AGENTS.md", ".agents/skills/code-review/SKILL.md",
                             ".agents/skills/review-contracts/SKILL.md")
            ),
        }
        if not (all(probe["passed"] for probe in report["probes"])
                and all(report["integrity"].values())):
            raise RuntimeError("Native filesystem/network controls failed; see file-access.json")
        report["status"] = "passed"
        return report
    finally:
        (artifacts / "file-access.json").write_text(json.dumps(report, indent=2) + "\n")
        read_link.unlink()
        shutil.rmtree(output)
        output.mkdir()


class NativeSession:
    def __init__(self, command: list[str], project: Path, env: dict[str, str],
                 artifacts: Path, timeout: float):
        self.deadline = time.monotonic() + timeout
        self.next_id = 0
        self.events = []
        self.lines = deque()
        self.buffer = b""
        self.received = 0
        self.launcher_notes = []
        self.stderr = (artifacts / "stderr.txt").open("wb")
        self.stdout = (artifacts / "stdout.bin").open("wb")
        self.trace = (artifacts / "native-rpc.jsonl").open("w")
        self.process = subprocess.Popen(
            command, cwd=project, env=env, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=self.stderr, start_new_session=True,
        )
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)

    def send(self, message: dict):
        self.trace.write(json.dumps({"direction": "client", "message": message}) + "\n")
        self.trace.flush()
        self.process.stdin.write((json.dumps(message) + "\n").encode())
        self.process.stdin.flush()

    def receive(self) -> dict:
        while not self.lines:
            remaining = self.deadline - time.monotonic()
            if remaining <= 0 or not self.selector.select(remaining):
                raise TimeoutError("Native Codex invocation exceeded its deadline")
            data = os.read(self.process.stdout.fileno(), 65536)
            self.stdout.write(data)
            self.stdout.flush()
            if not data:
                raise RuntimeError(f"Native Codex exited before completion: {self.process.poll()}")
            self.received += len(data)
            if self.received > 32 * 1024 * 1024:
                raise RuntimeError("Native trace exceeded the 32 MiB safety bound")
            parts = (self.buffer + data).split(b"\n")
            self.buffer = parts.pop()
            self.lines.extend(parts)
        line = self.lines.popleft().decode()
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            # The oMLX launcher prints a startup banner before exec'ing Codex.
            if self.next_id == 1 and line.startswith((
                "Starting with ", "Launching Codex with model ",
                "Warning: could not read the built-in instructions of ",
            )):
                self.trace.write(json.dumps({"direction": "launcher", "text": line}) + "\n")
                self.launcher_notes.append(line)
                return self.receive()
            raise RuntimeError("Non-JSON native protocol output; see retained trace") from None
        self.trace.write(json.dumps({"direction": "server", "message": message}) + "\n")
        self.trace.flush()
        if not isinstance(message, dict):
            raise ValueError("Native protocol returned a non-object")
        if "id" in message and "method" in message:
            raise RuntimeError(f"Unexpected server request: {message['method']}")
        if message.get("method") in ("error", "model/rerouted"):
            raise RuntimeError(f"Native execution error: {message['params']}")
        return message

    def rpc(self, method: str, params: dict) -> dict:
        self.next_id += 1
        identifier = self.next_id
        self.send({"jsonrpc": "2.0", "id": identifier, "method": method, "params": params})
        while True:
            message = self.receive()
            if message.get("id") == identifier:
                if "error" in message:
                    raise RuntimeError(f"{method}: {message['error']}")
                return message["result"]
            self.events.append(message)

    def complete(self, turn_id: str) -> dict:
        index = 0
        while True:
            if index == len(self.events):
                self.events.append(self.receive())
            message = self.events[index]
            index += 1
            if message.get("method") == "turn/completed":
                turn = message["params"]["turn"]
                if turn["id"] != turn_id or turn["status"] != "completed":
                    raise RuntimeError(f"Unsuccessful native turn: {turn}")
                return turn

    def close(self):
        self.selector.close()
        if self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGTERM)
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait(timeout=5)
        self.process.stdin.close()
        self.process.stdout.close()
        self.stderr.close()
        self.stdout.close()
        self.trace.close()


def verify_startup(start: dict, discovery: dict, project: Path, candidate: Path):
    if start.get("model") != MODEL or start.get("modelProvider") != "omlx":
        raise ValueError("Native selected model/provider differs from the approved local selection")
    if start.get("activePermissionProfile") != {"id": PROFILE, "extends": None}:
        raise ValueError("Native thread did not acknowledge the named permission profile")
    if start.get("approvalPolicy") != "never" or Path(start["cwd"]).resolve() != project:
        raise ValueError("Native approval policy or working directory mismatch")
    rows = [entry for entry in discovery["data"] if Path(entry["cwd"]).resolve() == project]
    if len(rows) != 1 or rows[0]["errors"]:
        raise ValueError("Missing or invalid native skill discovery")
    candidates = []
    for skill in rows[0]["skills"]:
        if not skill.get("enabled", True):
            continue
        if Path(skill["path"]).resolve() == candidate:
            candidates.append(skill)
        elif skill.get("scope") != "system":
            raise ValueError(f"Unexpected enabled non-system skill: {skill['name']}")
    if len(candidates) != 1 or candidates[0]["name"] != "better-init":
        raise ValueError("The exact staged candidate was not discovered")


def observed_load(events: list[dict], candidate: Path) -> bool:
    for event in events:
        if event.get("method") != "item/completed":
            continue
        item = event["params"]["item"]
        if item.get("type") != "commandExecution" or item.get("exitCode") != 0:
            continue
        words = shlex.split(item.get("command", ""))
        if (len(words) == 3 and words[0] in ("/bin/sh", "/bin/bash", "/bin/zsh")
                and words[1] in ("-c", "-lc")):
            words = shlex.split(words[2])
        if (len(words) == 2 and words[0] in ("cat", "/bin/cat")
                and (Path(item.get("cwd") or candidate.parents[3]) / words[1]).resolve() == candidate):
            return True
    return False


def grade(case: Case, project: Path, loaded: bool) -> dict:
    output = project / "outputs"
    actual = set(hashes(output))
    if case.kind == "trigger":
        if actual:
            return {"status": "failed", "reason": "Discovery-only case wrote output files"}
        if loaded:
            return {"status": "passed" if case.should_trigger else "failed",
                    "candidate_load": "observed successful native cat"}
        return {"status": "not_run", "candidate_load": "not observed by the conservative parser",
                "reason": "Absence of the admitted read shape does not prove no native skill loading."}
    owner = ".agents/skills/review-contracts/SKILL.md" if case.identifier == 108 else ".agents/skills/code-review/SKILL.md"
    expected = {"AGENTS.md", owner}
    checks = [
        {"assertion": "Only expected native guidance paths were generated.",
         "status": "passed" if actual == expected else "failed", "actual": sorted(actual)},
    ]
    review = (output / owner).read_text() if (output / owner).is_file() else ""
    validation = review
    if "AGENTS.md" in review and (output / "AGENTS.md").is_file():
        validation += (output / "AGENTS.md").read_text()
    checks.append({
        "assertion": "Lexical source/test mapping and validation reference.",
        "status": "passed" if all(value in review for value in (
            "src/index.js", "test/index.test.js",
        )) and any(command in validation for command in ("npm test", "node --test")) else "failed",
    })
    checks.extend({"assertion": expectation, "status": "not_run",
                   "reason": "Requires independent semantic review of retained fixtures and outputs."}
                  for expectation in case.expectations)
    return {"status": "failed" if any(check["status"] == "failed" for check in checks) else "not_run",
            "checks": checks, "limitations": [
                "Native explicit skill input is submitted for tasks, not organic discovery evidence.",
                "Native shell tools are sandboxed, not an exclusive file-tool allowlist.",
                "Lexical output checks do not prove semantic grounding or actual fixture reads.",
            ]}


def run_case(case: Case, artifacts: Path, codex: Path, omlx: Path,
             timeout: int, preflight: bool, result: dict):
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="cedar-") as temporary:
        root = Path(temporary).resolve()
        project = root / "project"
        project.mkdir()
        for parent in project.parents:
            if (parent / ".agents/skills").exists():
                raise ValueError("Ancestor native skills would contaminate discovery")
        home, codex_home = root / "home", root / "codex-home"
        home.mkdir()
        codex_home.mkdir()
        (project / "outputs").mkdir()
        for fixture in case.fixtures:
            target = project / fixture.name
            if fixture.is_dir():
                shutil.copytree(fixture, target)
            else:
                shutil.copyfile(fixture, target)
        candidate = project / ".agents/skills/better-init/SKILL.md"
        candidate.parent.mkdir(parents=True)
        body = (SKILL / "SKILL.md").read_text()
        if case.kind == "trigger":
            frontmatter, separator, _ = body.partition("\n---\n")
            if not separator:
                raise ValueError("Missing candidate frontmatter")
            body = frontmatter + separator + "\nFollow the user's requested scope. Do not write files.\n"
        candidate.write_text(body)
        before = hashes(project, "outputs")
        grants = configure(codex_home, project, codex)
        result.update({
            "input_hashes": before, "source_skill_sha256": hashlib.sha256(
                (SKILL / "SKILL.md").read_bytes()).hexdigest(),
            "grants": grants, "prompt": case.prompt, "expectations": case.expectations,
            "requested_model": MODEL,
        })
        env = {
            "HOME": str(home), "CODEX_HOME": str(codex_home),
            "PATH": os.pathsep.join(dict.fromkeys((str(omlx.parent), str(codex.parent),
                                                  "/usr/bin", "/bin"))),
            "LANG": "en_US.UTF-8", "PYTHONUNBUFFERED": "1",
        }
        command = [
            str(omlx), "launch", "codex", "--model", MODEL,
            "--host", "127.0.0.1", "--port", "8000",
            "--api-key", "local-evaluation", "--", "app-server", "--stdio",
        ]
        session = None
        try:
            result["file_access"] = verify_file_access(codex, project, env, artifacts)
            remaining = timeout - (time.monotonic() - started)
            if remaining <= 0:
                raise TimeoutError("Native preflight exhausted the invocation deadline")
            session = NativeSession(command, project, env, artifacts, remaining)
            result["initialize"] = session.rpc("initialize", {
                "clientInfo": {"name": "guidance", "version": "0.1.0"},
                "capabilities": {"experimentalApi": True},
            })
            session.send({"jsonrpc": "2.0", "method": "initialized"})
            discovery = session.rpc("skills/list", {"cwds": [str(project)], "forceReload": True})
            result["discovery"] = discovery
            servers = session.rpc("mcpServerStatus/list", {})
            if servers.get("data") != []:
                raise ValueError("Native MCP servers are not empty")
            start = session.rpc("thread/start", {
                "cwd": str(project), "model": MODEL, "modelProvider": "omlx",
                "permissions": PROFILE, "approvalPolicy": "never",
                "allowProviderModelFallback": False, "ephemeral": True,
            })
            result["native_start"] = start
            verify_startup(start, discovery, project, candidate)
            result["preflight"] = "passed"
            if preflight:
                result.update(status="not_run", reason="Model-free native preflight only")
                return
            inputs = [{"type": "text", "text": case.prompt}]
            if case.kind == "task":
                inputs.append({"type": "skill", "name": "better-init", "path": str(candidate)})
            result["invocation_started"] = True
            (artifacts / "result.json").write_text(json.dumps(result, indent=2) + "\n")
            turn = session.rpc("turn/start", {"threadId": start["thread"]["id"], "input": inputs})
            result["turn"] = session.complete(turn["turn"]["id"])
            result["candidate_load_observed"] = observed_load(session.events, candidate)
            if hashes(project, "outputs") != before:
                raise ValueError("Read-only input tree changed")
            result["grading"] = grade(case, project, result["candidate_load_observed"])
            result["status"] = result["grading"]["status"]
        finally:
            if session:
                result["launcher_notes"] = session.launcher_notes
                session.close()
            shutil.copytree(project, artifacts / "project", symlinks=True)
            shutil.copyfile(codex_home / "config.toml", artifacts / "config.toml")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--model", required=True, choices=[MODEL])
    parser.add_argument("--approved", action="store_true")
    parser.add_argument("--native-sandbox-approved", action="store_true")
    parser.add_argument("--preflight-only", action="store_true")
    parser.add_argument("--tasks-only", action="store_true",
                        help="Submit only the two task cases; obtain approval for this scope")
    parser.add_argument("--max-calls", type=int, default=4, choices=[2, 4])
    parser.add_argument("--timeout", type=int, default=300, choices=range(1, 301),
                        metavar="SECONDS")
    args = parser.parse_args()
    if not args.preflight_only and not (args.approved and args.native_sandbox_approved):
        parser.error("Both model-budget approval and separate native-sandbox approval are required")
    if args.max_calls != (2 if args.tasks_only else 4):
        parser.error("--max-calls must match the selected scope: 2 for --tasks-only, otherwise 4")
    workspace = args.workspace.resolve()
    if workspace.is_relative_to(ROOT) or ROOT.is_relative_to(workspace):
        parser.error("Use a fresh private artifact directory outside the checkout")
    if sys.platform != "darwin":
        parser.error("This reviewed native policy is macOS-only")
    binaries = {name: shutil.which(name) for name in ("codex", "omlx")}
    if not all(binaries.values()):
        parser.error("Existing codex and omlx executables are required; do not install automatically")
    codex, omlx = (Path(binaries[name]).resolve() for name in ("codex", "omlx"))
    cases = load_cases()
    if args.tasks_only:
        cases = [case for case in cases if case.kind == "task"]
    workspace.mkdir(mode=0o700)
    report = {
        "harness": "codex-omlx", "policy": "native-sandbox-macos",
        "model": MODEL, "endpoint": "http://127.0.0.1:8000",
        "preflight_only": args.preflight_only, "max_invocations": args.max_calls,
        "runner_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "planned_cases": [{"kind": case.kind, "id": case.identifier} for case in cases],
        "repetitions": 1, "baseline": False, "timeout_seconds": args.timeout,
        "invocations_started": 0, "cases": [],
        "limitations": [
            "Client-side oMLX instruction/catalog probes do not invoke the model.",
            "One invocation can contain multiple model requests; this is not a request/token cap.",
            "Native configured model identity is acknowledged; server-side served identity needs independent evidence.",
            "This is a restricted local Qwen pilot, not hosted Codex or marketplace-wide coverage.",
        ],
    }
    try:
        version = subprocess.run([str(codex), "--version"], capture_output=True,
                                 text=True, timeout=15, check=True).stdout.strip()
        if version != "codex-cli 0.169.0":
            raise ValueError(f"Unreviewed native CLI version: {version}")
        report["codex_version"] = version
        report["codex_sha256"] = hashlib.sha256(codex.read_bytes()).hexdigest()
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open("http://127.0.0.1:8000/v1/models/status", timeout=10) as response:
            metadata = json.load(response)
        selected = [model for model in metadata["models"] if model["id"] == MODEL]
        if len(selected) != 1 or selected[0].get("loaded") is not True:
            raise ValueError("The exact approved local model must already be loaded")
        report["local_model_status"] = {
            key: selected[0].get(key) for key in
            ("id", "loaded", "max_context_window", "max_tokens", "engine_type")
        }
        for case in cases[:1] if args.preflight_only else cases:
            artifacts = workspace / f"{case.kind}-{case.identifier}"
            artifacts.mkdir()
            result = {"kind": case.kind, "id": case.identifier, "status": "error",
                      "invocation_started": False}
            report["cases"].append(result)
            try:
                run_case(case, artifacts, codex, omlx, args.timeout, args.preflight_only, result)
            except (OSError, ValueError, RuntimeError, TimeoutError, KeyError, TypeError) as error:
                result.update(status="error", error=str(error))
                break
            finally:
                report["unstarted_cases"] = [
                    {"kind": case.kind, "id": case.identifier, "status": "not_run"}
                    for case in cases if not any(
                        result["kind"] == case.kind and result["id"] == case.identifier
                        and result["invocation_started"] for result in report["cases"]
                    )
                ]
                report["invocations_started"] += int(result["invocation_started"])
                (artifacts / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    except (OSError, ValueError, RuntimeError, KeyError, TypeError, subprocess.SubprocessError) as error:
        report["error"] = str(error)
    finally:
        report["status"] = "error" if report.get("error") or any(
            case["status"] == "error" for case in report["cases"]
        ) else "not_run" if args.preflight_only or any(
            case["status"] == "not_run" for case in report["cases"]
        ) else "failed" if any(case["status"] == "failed" for case in report["cases"]) else "passed"
        (workspace / "results.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"status": report["status"], "invocations_started": report["invocations_started"],
                      "report": str(workspace / "results.json")}))
    return int(report["status"] == "error")


if __name__ == "__main__":
    raise SystemExit(main())
