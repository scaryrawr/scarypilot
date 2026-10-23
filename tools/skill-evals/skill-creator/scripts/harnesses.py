"""Restricted Copilot adaptation of skill-creator's harnesses.py.

Copyright 2026 Anthropic, PBC. Apache-2.0, see ../LICENSE.txt.
See ../NOTICE.md and ../provenance.json for the adaptation lineage.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from scripts.utils import parse_skill_md


TOOLS = ("skill", "view", "create", "edit", "apply_patch")
AUTH_ENV = ("COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN")
MAX_FILES = 512
MAX_BYTES = 10 * 1024 * 1024
MAX_TRACE_BYTES = 20 * 1024 * 1024
EVENT_TYPES = {
    "session.start", "session.resume", "session.idle", "session.shutdown",
    "session.error", "session.info", "session.warning", "session.model_change",
    "session.usage_info", "session.compaction_start", "session.compaction_complete",
    "session.context_changed", "session.title_changed",
    "assistant.message", "assistant.message_delta", "assistant.reasoning",
    "assistant.reasoning_delta", "assistant.turn_start", "assistant.turn_end",
    "assistant.usage", "assistant.intent", "assistant.intent_delta",
    "user.message", "system.message",
    "tool.execution_start", "tool.execution_complete",
    "tool.execution_progress", "tool.execution_partial_result",
    "result", "error",
    "assistant.idle", "assistant.message_start", "assistant.tool_call_delta",
    "model.call_start", "model.call_finished", "model.call_final_result",
    "session.custom_agents_updated", "session.mcp_servers_loaded",
    "session.skills_loaded", "session.tools_updated", "session.usage_checkpoint",
}


class EvidenceError(ValueError):
    """An execution cannot establish a behavioral verdict."""


@dataclass
class Evidence:
    candidate_loaded: bool = False
    models: list[str] = field(default_factory=list)
    views: list[str] = field(default_factory=list)
    writes: list[str] = field(default_factory=list)
    tools: list[str] = field(default_factory=list)
    final_text: str = ""
    usage: dict | None = None


def patch_paths(arguments: object, sandbox: Path) -> list[str]:
    if isinstance(arguments, str):
        patch = arguments
    elif isinstance(arguments, dict):
        patch = arguments.get("input", arguments.get("patch"))
    else:
        patch = None
    if not isinstance(patch, str) or not patch.startswith("*** Begin Patch\n") or not patch.rstrip().endswith("*** End Patch"):
        raise EvidenceError("malformed_patch")
    paths = []
    for line in patch.splitlines():
        if not line.startswith("*** "):
            continue
        if line in {"*** Begin Patch", "*** End Patch", "*** End of File"}:
            continue
        match = re.fullmatch(r"\*\*\* (?:Add|Update) File: (.+)", line)
        if not match:
            raise EvidenceError("unsupported_patch_operation")
        path = Path(match[1])
        if path.is_absolute():
            if not path.is_relative_to(sandbox):
                raise EvidenceError("tool_path_escape")
            path = path.relative_to(sandbox)
        relative = path.as_posix()
        try:
            confined(sandbox, relative)
        except ValueError as error:
            raise EvidenceError("tool_path_escape") from error
        if relative not in {"outputs/AGENTS.md", "outputs/.github/skills/code-review/SKILL.md"}:
            raise EvidenceError("forbidden_write_path")
        paths.append(relative)
    if not paths:
        raise EvidenceError("empty_patch")
    return paths


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n")


def confined(root: Path, relative: str) -> Path:
    path = Path(relative)
    if not relative or path.is_absolute() or ".." in path.parts or "\\" in relative:
        raise ValueError(f"Unsafe relative path: {relative!r}")
    dest = root / path
    for part in [dest, *dest.parents]:
        if part == root.parent:
            break
        if part.is_symlink():
            raise ValueError(f"Symlink not allowed: {part}")
    if not dest.resolve().is_relative_to(root.resolve()):
        raise ValueError(f"Path escapes root: {relative}")
    return dest


def file_inventory(root: Path) -> dict[str, str]:
    """Validate an inert tree before copying or inspecting any of its files."""
    if any(part.is_symlink() for part in [root, *root.parents]) or not root.exists():
        raise ValueError(f"Missing or linked input: {root}")
    paths = root.rglob("*") if root.is_dir() else [root]
    total = 0
    result = {}
    names = set()
    for index, path in enumerate(paths):
        if index >= MAX_FILES * 2:
            raise ValueError("Input/output tree exceeds entry limit")
        if path.is_symlink():
            raise ValueError(f"Symlink not allowed: {path}")
        key = str(path.relative_to(root)) if root.is_dir() else root.name
        folded = key.casefold()
        if folded in names:
            raise ValueError(f"Case-insensitive path collision: {key}")
        names.add(folded)
        if path.is_dir():
            continue
        if not path.is_file():
            raise ValueError(f"Not a regular file: {path}")
        total += path.stat().st_size
        if total > MAX_BYTES or len(result) >= MAX_FILES:
            raise ValueError("Input/output tree exceeds file or byte limit")
        result[key] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def fixture_sources(files: list[str], skill_path: Path) -> list[Path]:
    sources = []
    names = set()
    total_bytes = 0
    total_files = 0
    for relative in files:
        source = confined(skill_path, relative)
        if not relative.startswith("evals/files/"):
            raise ValueError("Fixtures must be declared under evals/files/")
        inventory = file_inventory(source)
        total_files += len(inventory)
        total_bytes += sum(p.stat().st_size for p in source.rglob("*") if p.is_file()) if source.is_dir() else source.stat().st_size
        if total_files > MAX_FILES or total_bytes > MAX_BYTES:
            raise ValueError("Combined fixtures exceed file or byte limit")
        folded = source.name.casefold()
        if folded in names:
            raise ValueError(f"Fixture destination collision: {source.name}")
        names.add(folded)
        sources.append(source)
    return sources


def stage_skill(skill: Path, sandbox: Path, trigger: bool) -> tuple[str, Path]:
    name, description, content = parse_skill_md(skill)
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name) or not description:
        raise ValueError("Invalid candidate name or description")
    candidate = f"{name}-candidate-{uuid.uuid4().hex[:12]}"
    target = sandbox / ".github" / "skills" / candidate
    target.mkdir(parents=True)
    if trigger:
        body = f"# {candidate}\n\nHandle the user's request following this description.\n"
    else:
        inventory = file_inventory(skill)
        for relative in inventory:
            if Path(relative).parts[0] in {"evals", ".git", "node_modules", "__pycache__"}:
                continue
            if relative == "SKILL.md":
                continue
            dest = confined(target, relative)
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(skill / relative, dest, follow_symlinks=False)
        body = content.split("---", 2)[2]
    (target / "SKILL.md").write_text(
        f"---\nname: {candidate}\ndescription: |\n"
        + "\n".join(f"  {line}" for line in description.splitlines())
        + f"\n---\n{body}"
    )
    return candidate, target


def isolated_environment(run_dir: Path, auth_env: str | None) -> dict[str, str]:
    home = run_dir / "home"
    home.mkdir()
    copilot_home = run_dir / "copilot-home"
    copilot_home.mkdir()
    write_json(copilot_home / "settings.json", {
        "disableAllHooks": True,
        "ide": {"autoConnect": False},
    })
    env = {
        "PATH": os.environ.get("PATH", os.defpath),
        "HOME": str(home),
        "USERPROFILE": str(home),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "XDG_DATA_HOME": str(home / ".local" / "share"),
        "XDG_CACHE_HOME": str(home / ".cache"),
        "COPILOT_HOME": str(copilot_home),
        "COPILOT_AUTO_UPDATE": "false",
        "LANG": "en_US.UTF-8",
        "NO_COLOR": "1",
    }
    if auth_env:
        if auth_env not in AUTH_ENV or not os.environ.get(auth_env):
            raise ValueError("Explicit --auth-env must name an exported supported token")
        env[auth_env] = os.environ[auth_env]
    return env


def create_sandbox() -> Path:
    return Path(tempfile.mkdtemp(prefix="scarypilot-workspace-")).resolve()


def retain_sandbox(sandbox: Path, run_dir: Path) -> None:
    try:
        file_inventory(sandbox)
        shutil.copytree(sandbox, run_dir / "sandbox")
    finally:
        shutil.rmtree(sandbox)


def cli_fingerprint(executable: str) -> dict:
    resolved = shutil.which(executable)
    if resolved is None:
        return {"path": executable, "sha256": None}
    digest = hashlib.sha256()
    with Path(resolved).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return {"path": str(Path(resolved).resolve()), "sha256": digest.hexdigest()}


def copilot_command(prompt: str, model: str, sandbox: Path, executable: str = "copilot", writable_outputs: bool = False) -> list[str]:
    tools = TOOLS if writable_outputs else ("skill", "view")
    write_permissions = [
        f"--allow-tool=write({sandbox / 'outputs' / relative})"
        for relative in ("AGENTS.md", ".github/skills/code-review/SKILL.md")
    ] if writable_outputs else ["--deny-tool=write"]
    return [
        executable, "-C", str(sandbox), "-p", prompt, "--model", model,
        "--output-format", "json", "--no-custom-instructions", "--no-auto-update",
        "--disable-builtin-mcps", "--available-tools=" + ",".join(tools),
        "--allow-tool=skill", "--allow-tool=view", *write_permissions,
        "--secret-env-vars=" + ",".join(AUTH_ENV),
        "--disallow-temp-dir", "--no-ask-user",
        "--disable-client-telemetry", "--sync-session=off", "--no-bash-env",
        "--dynamic-retrieval", "skills=off",
        "--mode", "interactive", "--trust-folder",
    ]


def parse_evidence(raw: str, candidate: str | None, requested_model: str, sandbox: Path, tools: tuple[str, ...] = TOOLS) -> Evidence:
    evidence = Evidence()
    pending = {}
    requested = set()
    completed = set()
    loaded_source = False
    terminal = False
    assistant_seen = False
    discovery_seen = False
    mcp_seen = False
    messages = []
    if not raw.strip():
        raise EvidenceError("missing_events")
    for line in raw.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError as error:
            raise EvidenceError("malformed_jsonl") from error
        if not isinstance(event, dict) or not isinstance(event.get("type"), str) or not isinstance(event.get("data", {}), dict):
            raise EvidenceError("malformed_event")
        typ, data = event["type"], event.get("data", {})
        if typ not in EVENT_TYPES:
            raise EvidenceError("unsupported_event_type")
        if "toolName" in data and data["toolName"] not in tools:
            raise EvidenceError("forbidden_tool")
        if typ == "session.skills_loaded":
            discovery_seen = True
            skills = data.get("skills")
            if not isinstance(skills, list):
                raise EvidenceError("malformed_discovery")
            for skill in skills:
                if not isinstance(skill, dict):
                    raise EvidenceError("malformed_discovery")
                if skill.get("enabled", True) and skill.get("source") != "builtin" and skill.get("name") != candidate:
                    raise EvidenceError("unexpected_discovered_skill")
            if candidate is not None and not any(skill.get("name") == candidate and skill.get("enabled", True) for skill in skills):
                raise EvidenceError("candidate_not_discovered")
        if typ == "session.mcp_servers_loaded":
            mcp_seen = True
            servers = data.get("servers")
            if not isinstance(servers, list) or any(not isinstance(server, dict) or server.get("status") != "disabled" for server in servers):
                raise EvidenceError("unexpected_mcp_server")
        if typ in {"assistant.message", "user.message", "tool.execution_start", "tool.execution_complete"}:
            terminal = False
        if typ in {"session.error", "error"} or (typ == "result" and (event.get("is_error") or data.get("is_error") or data.get("isError") or data.get("error") or event.get("subtype") not in {None, "success"})):
            raise EvidenceError("model_error")
        for key in ("model", "selectedModel", "newModel"):
            model = data.get(key)
            if isinstance(model, str) and model not in evidence.models:
                evidence.models.append(model)
        if typ == "result" and event.get("subtype") != "success" and data.get("success") is not True and event.get("exitCode") != 0:
            raise EvidenceError("malformed_result")
        if typ == "result" and isinstance(event.get("usage"), dict):
            evidence.usage = event["usage"]
        if typ in {"session.idle", "session.shutdown", "result", "assistant.idle"}:
            terminal = True
        if typ == "assistant.message":
            assistant_seen = True
            if isinstance(data.get("content"), str):
                messages.append(data["content"])
            requests = data.get("toolRequests", []) or []
            if not isinstance(requests, list):
                raise EvidenceError("malformed_tool_requests")
            for request in requests:
                if not isinstance(request, dict) or request.get("name") not in tools:
                    raise EvidenceError("forbidden_tool")
                call_id = request.get("toolCallId") or request.get("id")
                if not isinstance(call_id, str):
                    raise EvidenceError("missing_tool_call_id")
                requested.add(call_id)
        if typ == "tool.execution_start":
            name, arguments = data.get("toolName"), data.get("arguments", {})
            call_id = data.get("toolCallId")
            if name not in tools:
                raise EvidenceError("forbidden_tool")
            if not isinstance(arguments, (dict, str)) or not isinstance(call_id, str) or call_id in pending:
                raise EvidenceError("malformed_tool_start")
            if name != "apply_patch" and not isinstance(arguments, dict):
                raise EvidenceError("malformed_tool_start")
            if name == "apply_patch":
                evidence.writes.extend(patch_paths(arguments, sandbox))
            if name == "skill" and (candidate is None or arguments.get("skill") != candidate):
                raise EvidenceError("unexpected_skill_load")
            if name in {"view", "create", "edit"}:
                path = arguments.get("path")
                if not isinstance(path, str):
                    raise EvidenceError("missing_tool_path")
                path_obj = Path(path)
                if path_obj.is_absolute():
                    if not path_obj.is_relative_to(sandbox):
                        raise EvidenceError("tool_path_escape")
                    relative = str(path_obj.relative_to(sandbox))
                else:
                    relative = path_obj.as_posix()
                try:
                    confined(sandbox, relative)
                except ValueError as error:
                    raise EvidenceError("tool_path_escape") from error
                if name == "view":
                    evidence.views.append(relative)
                elif relative not in {"outputs/AGENTS.md", "outputs/.github/skills/code-review/SKILL.md"}:
                    raise EvidenceError("forbidden_write_path")
                else:
                    evidence.writes.append(relative)
            pending[call_id] = (name, arguments)
            evidence.tools.append(name)
        if typ == "tool.execution_complete":
            call_id = data.get("toolCallId")
            if call_id not in pending or call_id in completed or data.get("success") is not True:
                raise EvidenceError("failed_or_unmatched_tool")
            completed.add(call_id)
            if pending[call_id][0] == "skill":
                evidence.candidate_loaded = True
        if typ == "user.message" and isinstance(data.get("source"), str) and data["source"].startswith("skill-"):
            if candidate is None or data["source"] != f"skill-{candidate}":
                raise EvidenceError("unexpected_skill_source")
            loaded_source = True
    if not terminal or not assistant_seen or requested - completed or set(pending) != completed:
        raise EvidenceError("incomplete_events")
    if not discovery_seen or not mcp_seen:
        raise EvidenceError("missing_discovery_evidence")
    if loaded_source and not evidence.candidate_loaded:
        raise EvidenceError("unverified_skill_load")
    if not evidence.models or any(model != requested_model for model in evidence.models):
        raise EvidenceError("model_mismatch")
    evidence.final_text = "\n".join(messages)
    return evidence


def run_command(args: list[str], sandbox: Path, run_dir: Path, timeout: float, env: dict[str, str]) -> tuple[int | None, str | None]:
    start = time.monotonic()
    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    code = None
    failure = None
    with (run_dir / "raw.jsonl").open("wb") as stdout, (run_dir / "stderr.txt").open("wb") as stderr:
        try:
            # No model-facing shell tools are admitted. This is the sole inference subprocess.
            with subprocess.Popen(args, cwd=sandbox, env=env, stdin=subprocess.DEVNULL,
                                  stdout=stdout, stderr=stderr) as process:
                while process.poll() is None:
                    if time.monotonic() - start >= timeout:
                        failure = "timeout"
                        break
                    if stdout.tell() + stderr.tell() > MAX_TRACE_BYTES:
                        failure = "trace_size_limit"
                        break
                    time.sleep(0.05)
                if failure:
                    process.kill()
                code = process.wait()
            if stdout.tell() + stderr.tell() > MAX_TRACE_BYTES:
                failure = "trace_size_limit"
            if failure is None and code != 0:
                failure = "cli_exit"
        except OSError:
            failure = "cli_unavailable"
    elapsed = time.monotonic() - start
    write_json(run_dir / "timing.json", {
        "executor_start": started, "executor_duration_seconds": elapsed,
        "executor_end": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "total_duration_seconds": elapsed, "duration_ms": round(elapsed * 1000),
        "exit_code": code, "total_tokens": None, "harness": "copilot",
    })
    return code, failure


def validate_workspace(path: Path, skill_path: Path) -> Path:
    for part in [path, *path.parents]:
        if part.is_symlink():
            raise ValueError("Workspace may not have symlink ancestors")
        if (part / ".git").exists():
            raise ValueError("Artifact workspace must be outside existing repositories")
        # The caller's personal home is replaced in the child environment.
        # Do not mistake its personal skill folders for an enclosing project.
        if part != Path.home() and any((part / marker).exists() for marker in (".github", ".agents", ".claude", ".mcp.json")):
            raise ValueError("Artifact workspace ancestors may not contain project configuration")
    resolved = path.resolve()
    if resolved == skill_path or resolved.is_relative_to(skill_path):
        raise ValueError("Workspace must be outside the candidate skill")
    resolved.mkdir(parents=True, exist_ok=True, mode=0o700)
    return resolved


def preflight(args: object, call_count: int) -> None:
    if not args.approved:
        raise ValueError("not_run: separate inference approval required (--approved)")
    if not args.model or not args.model.strip() or args.model.strip().lower() == "auto":
        raise ValueError("not_run: an explicit non-auto --model is required")
    if args.max_calls is None or args.max_calls < 1 or call_count > args.max_calls:
        raise ValueError(f"not_run: proposed {call_count} calls exceeds --max-calls")
    if call_count < 1 or not math.isfinite(args.timeout) or not 0 < args.timeout <= 900 or args.num_workers != 1:
        raise ValueError("Only positive run counts/timeouts and sequential --num-workers 1 are supported")
    if args.auth_env and (args.auth_env not in AUTH_ENV or not os.environ.get(args.auth_env)):
        raise ValueError("not_run: requested authentication environment variable is absent")


def common_arguments(parser: object) -> None:
    parser.add_argument("--skill-path", required=True)
    parser.add_argument("--workspace", required=True, help="Artifact directory outside any existing repository")
    parser.add_argument("--model")
    parser.add_argument("--approved", action="store_true", help="Operator approved this bounded inference invocation")
    parser.add_argument("--max-calls", type=int, help="Maximum CLI inference invocations, not provider requests or a monetary cap")
    parser.add_argument("--timeout", type=float, default=120, help="Per-call timeout in seconds, maximum 900")
    parser.add_argument("--num-workers", type=int, default=1, choices=[1])
    parser.add_argument("--harness", default="copilot", choices=["copilot"])
    parser.add_argument("--auth-env", choices=AUTH_ENV, help="Pass only this explicitly exported authentication token")
    parser.add_argument("--cli", default="copilot", help="Copilot executable; explicit fake executable seam for offline tests")
    parser.add_argument("--output", help="JSON summary path, defaults to stdout; parent must already exist")
