#!/usr/bin/env python3
"""Copilot-first agent harness helpers for skill-creator.

Modified from Anthropic's skill-creator distribution to support GitHub
Copilot CLI as the primary eval harness. Legacy helpers for pi, Claude Code,
and Codex remain available for explicit historical comparisons. Original
project copyright and Apache-2.0 license are retained in ../LICENSE.txt.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

from scripts.utils import parse_skill_md


SUPPORTED_HARNESSES = ("copilot", "pi", "claude", "codex")
DEFAULT_HARNESS = "copilot"


@dataclass(frozen=True)
class HarnessInfo:
    name: str
    executable: str
    supports_native_skills: bool
    supports_trigger_eval: bool
    notes: str


HARNESS_INFO: dict[str, HarnessInfo] = {
    "copilot": HarnessInfo(
        name="copilot",
        executable="copilot",
        supports_native_skills=True,
        supports_trigger_eval=True,
        notes="GitHub Copilot CLI loads project skills from .github/skills and personal skills from ~/.agents/skills.",
    ),
    "pi": HarnessInfo(
        name="pi",
        executable="pi",
        supports_native_skills=True,
        supports_trigger_eval=True,
        notes="pi supports explicit --skill paths and --no-skills for baseline runs.",
    ),
    "claude": HarnessInfo(
        name="claude",
        executable="claude",
        supports_native_skills=True,
        supports_trigger_eval=True,
        notes="Claude Code trigger eval uses temporary .claude/commands entries, matching the original skill-creator approach.",
    ),
    "codex": HarnessInfo(
        name="codex",
        executable="codex",
        supports_native_skills=False,
        supports_trigger_eval=False,
        notes="Codex CLI has no generally available SKILL.md trigger mechanism; task evals inject the skill by instructing Codex to read SKILL.md.",
    ),
}


def normalize_harness(name: str) -> str:
    name = name.lower().strip()
    aliases = {
        "auto": "auto",
        "all": "all",
        "github-copilot": "copilot",
        "gh-copilot": "copilot",
        "claude-code": "claude",
        "cluade": "claude",  # common typo
        "openai-codex": "codex",
    }
    normalized = aliases.get(name, name)
    if normalized not in (*SUPPORTED_HARNESSES, "auto", "all"):
        raise ValueError(f"Unknown harness '{name}'. Expected one of: {', '.join(SUPPORTED_HARNESSES)}, auto, all")
    return normalized


def command_exists(command: str) -> bool:
    return shutil.which(command) is not None


def available_harnesses(trigger_only: bool = False) -> list[str]:
    result = []
    for name in SUPPORTED_HARNESSES:
        info = HARNESS_INFO[name]
        if trigger_only and not info.supports_trigger_eval:
            continue
        if command_exists(info.executable):
            result.append(name)
    return result


def detect_current_harness() -> str | None:
    """Best-effort detection of the agent harness running this script."""
    env = os.environ
    if env.get("PI_CODING_AGENT"):
        return "pi"
    if env.get("CLAUDECODE") or env.get("CLAUDE_CODE"):
        return "claude"
    if env.get("CODEX_SANDBOX") or env.get("CODEX_HOME"):
        return "codex"
    # Copilot does not consistently set a public env marker in subprocesses.
    for key in env:
        if key.startswith("COPILOT_"):
            return "copilot"
    return None


def choose_harness(requested: str = "auto", trigger_only: bool = False) -> list[str]:
    requested = normalize_harness(requested)
    if requested == "all":
        selected = available_harnesses(trigger_only=trigger_only)
        if not selected:
            raise RuntimeError("No supported harness CLIs are available on PATH")
        return selected
    if requested == "auto":
        default_info = HARNESS_INFO[DEFAULT_HARNESS]
        if command_exists(default_info.executable):
            if not trigger_only or default_info.supports_trigger_eval:
                return [DEFAULT_HARNESS]
        current = detect_current_harness()
        if current and command_exists(HARNESS_INFO[current].executable):
            if not trigger_only or HARNESS_INFO[current].supports_trigger_eval:
                return [current]
        selected = available_harnesses(trigger_only=trigger_only)
        if not selected:
            raise RuntimeError("No supported harness CLIs are available on PATH")
        return [selected[0]]
    info = HARNESS_INFO[requested]
    if trigger_only and not info.supports_trigger_eval:
        raise RuntimeError(f"Harness '{requested}' does not support native trigger evals")
    if not command_exists(info.executable):
        raise RuntimeError(f"Harness executable not found on PATH: {info.executable}")
    return [requested]


def find_project_root(start: Path | None = None) -> Path:
    """Find a likely project root by walking up from start/cwd."""
    current = (start or Path.cwd()).resolve()
    markers = (".git", ".github", ".claude")
    for parent in [current, *current.parents]:
        if any((parent / marker).exists() for marker in markers):
            return parent
    return current


@contextmanager
def sandbox_project_root(prefix: str = "skill-eval-sandbox-") -> Iterator[Path]:
    """Yield an isolated throwaway git repo to run eval harness CLIs in.

    Eval harnesses launch real agent subprocesses with ``--allow-all`` that
    *carry out* each prompt and can mutate whatever git repo is the working
    directory (creating stray branches, remotes, fetched refs, or commits).
    Running inside a disposable, git-initialized sandbox keeps those side
    effects contained instead of hitting a real repository such as
    ``~/.agents`` or a project checkout. Cleaned up on exit.
    """
    with tempfile.TemporaryDirectory(prefix=prefix) as tmp:
        yield _init_sandbox_dir(Path(tmp).resolve())


def create_sandbox_project_root(prefix: str = "skill-eval-sandbox-") -> Path:
    """Create a persistent sandbox project root; the caller must clean it up.

    Use this when a context manager does not fit the call site (e.g. a long
    loop). See ``sandbox_project_root`` for why eval runs must be sandboxed.
    """
    return _init_sandbox_dir(Path(tempfile.mkdtemp(prefix=prefix)).resolve())


def _init_sandbox_dir(root: Path) -> Path:
    """Initialize a minimal isolated project root for eval subprocesses."""
    # A minimal git repo gives skill discovery a realistic project root
    # (matching find_project_root markers) and a contained place for any
    # git-oriented prompt to act without touching real repositories.
    subprocess.run(
        ["git", "init", "-q"],
        cwd=root,
        check=False,
        capture_output=True,
    )
    (root / ".github").mkdir(exist_ok=True)
    return root


@contextmanager
def resolve_eval_root(explicit: str | Path | None) -> Iterator[Path]:
    """Resolve the project root for an eval run.

    When ``explicit`` is provided it is used as-is (caller opts into a specific,
    possibly real, directory). Otherwise a disposable sandbox is created so the
    ``--allow-all`` agent subprocess cannot damage a real repo.
    """
    if explicit:
        yield Path(explicit).resolve()
    else:
        with sandbox_project_root() as root:
            yield root


@contextmanager
def temporary_skill_dir(skill_name: str, description: str, body: str | None = None) -> Iterator[Path]:
    """Create a temporary minimal skill directory for trigger evals."""
    with tempfile.TemporaryDirectory(prefix="skill-trigger-") as tmp:
        skill_dir = Path(tmp) / skill_name
        skill_dir.mkdir(parents=True, exist_ok=True)
        body = body or f"# {skill_name}\n\nThis skill handles: {description}\n"
        skill_dir.joinpath("SKILL.md").write_text(
            f"---\nname: {skill_name}\ndescription: |\n"
            + "\n".join(f"  {line}" for line in description.splitlines())
            + f"\n---\n\n{body}"
        )
        yield skill_dir


@contextmanager
def staged_copilot_skill(skill_path: Path, project_root: Path, unique_name: str | None = None, description: str | None = None) -> Iterator[tuple[str, Path]]:
    """Stage a skill under .github/skills so Copilot CLI can discover it.

    When unique_name/description are provided, only a minimal SKILL.md is staged
    for trigger evals. Otherwise the full skill directory is copied.
    """
    source_name, source_description, _ = parse_skill_md(skill_path)
    staged_name = unique_name or source_name
    staged_description = description or source_description
    skills_dir = project_root / ".github" / "skills"
    dest = skills_dir / staged_name
    if dest.exists():
        dest = skills_dir / f"{staged_name}-{uuid.uuid4().hex[:8]}"
        staged_name = dest.name
    skills_dir.mkdir(parents=True, exist_ok=True)
    try:
        if unique_name or description:
            dest.mkdir(parents=True, exist_ok=True)
            dest.joinpath("SKILL.md").write_text(
                f"---\nname: {staged_name}\ndescription: |\n"
                + "\n".join(f"  {line}" for line in staged_description.splitlines())
                + "\n---\n\n"
                + f"# {staged_name}\n\nThis temporary trigger-eval skill handles: {staged_description}\n"
            )
        else:
            shutil.copytree(skill_path, dest, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store"))
        yield staged_name, dest
    finally:
        if dest.exists():
            shutil.rmtree(dest, ignore_errors=True)


@contextmanager
def staged_claude_command(skill_name: str, description: str, project_root: Path) -> Iterator[str]:
    """Create a temporary Claude Code command used for trigger detection."""
    unique_name = f"{skill_name}-skill-{uuid.uuid4().hex[:8]}"
    commands_dir = project_root / ".claude" / "commands"
    command_file = commands_dir / f"{unique_name}.md"
    commands_dir.mkdir(parents=True, exist_ok=True)
    indented_desc = "\n  ".join(description.split("\n"))
    command_file.write_text(
        f"---\ndescription: |\n  {indented_desc}\n---\n\n"
        f"# {skill_name}\n\nThis skill handles: {description}\n"
    )
    try:
        yield unique_name
    finally:
        try:
            command_file.unlink()
        except FileNotFoundError:
            pass


def run_command(args: list[str], cwd: Path, timeout: int, stdin: str | None = None, env: dict[str, str] | None = None) -> tuple[int, str, str, float]:
    start = time.time()
    try:
        result = subprocess.run(
            args,
            input=stdin,
            capture_output=True,
            text=True,
            cwd=str(cwd),
            env=env,
            timeout=timeout,
        )
        elapsed = time.time() - start
        return result.returncode, result.stdout, result.stderr, elapsed
    except subprocess.TimeoutExpired as e:
        elapsed = time.time() - start
        stdout = e.stdout.decode("utf-8", errors="replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
        stderr = e.stderr.decode("utf-8", errors="replace") if isinstance(e.stderr, bytes) else (e.stderr or "")
        return 124, stdout, stderr + f"\nTimed out after {timeout}s", elapsed


def copilot_command(prompt: str, model: str | None = None) -> list[str]:
    args = [
        "copilot",
        "-p", prompt,
        "--output-format", "json",
        "--silent",
        "--allow-all",
        "--no-custom-instructions",
        "--no-auto-update",
    ]
    if model:
        args.extend(["--model", model])
    return args


def pi_command(prompt: str, skill_path: Path | None = None, model: str | None = None, no_skills: bool = False) -> list[str]:
    args = ["pi", "--no-session", "--no-context-files", "--mode", "json"]
    if no_skills:
        args.append("--no-skills")
    if skill_path:
        args.extend(["--skill", str(skill_path)])
    if model:
        args.extend(["--model", model])
    args.extend(["-p", prompt])
    return args


def claude_command(prompt: str, model: str | None = None) -> tuple[list[str], dict[str, str]]:
    args = [
        "claude",
        "-p", prompt,
        "--output-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
    ]
    if model:
        args.extend(["--model", model])
    # Allow nested programmatic claude -p inside Claude Code.
    env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}
    return args, env


def codex_command(prompt: str, model: str | None = None, cwd: Path | None = None) -> list[str]:
    args = ["codex", "exec", "--json", "--skip-git-repo-check", "--sandbox", "workspace-write"]
    if cwd:
        args.extend(["-C", str(cwd)])
    if model:
        args.extend(["--model", model])
    args.append(prompt)
    return args


def triggered_from_output(harness: str, stdout: str, skill_name: str, skill_path: Path | None = None) -> bool:
    """Detect whether the harness actually loaded/used the skill."""
    if harness == "copilot":
        for line in stdout.splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            typ = event.get("type")
            data = event.get("data", {})
            if typ == "assistant.message":
                for tool in data.get("toolRequests", []) or []:
                    if tool.get("name") == "skill" and tool.get("arguments", {}).get("skill") == skill_name:
                        return True
            if typ == "tool.execution_start" and data.get("toolName") == "skill":
                if data.get("arguments", {}).get("skill") == skill_name:
                    return True
            if typ == "user.message" and data.get("source") == f"skill-{skill_name}":
                return True
        return False

    if harness == "pi":
        skill_path_text = str(skill_path.resolve()) if skill_path else skill_name
        for line in stdout.splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            blob = json.dumps(event)
            if '"name": "skill"' in blob and skill_name in blob:
                return True
            if '"name":"skill"' in blob and skill_name in blob:
                return True
            if '"name": "read"' in blob or '"name":"read"' in blob:
                if "SKILL.md" in blob and (skill_path_text in blob or skill_name in blob):
                    return True
        return False

    if harness == "claude":
        pending_tool_name = None
        accumulated_json = ""
        for line in stdout.splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") == "stream_event":
                se = event.get("event", {})
                se_type = se.get("type", "")
                if se_type == "content_block_start":
                    cb = se.get("content_block", {})
                    if cb.get("type") == "tool_use":
                        tool_name = cb.get("name", "")
                        if tool_name in ("Skill", "Read"):
                            pending_tool_name = tool_name
                            accumulated_json = ""
                        else:
                            pending_tool_name = None
                elif se_type == "content_block_delta" and pending_tool_name:
                    delta = se.get("delta", {})
                    if delta.get("type") == "input_json_delta":
                        accumulated_json += delta.get("partial_json", "")
                        if skill_name in accumulated_json:
                            return True
                elif se_type in ("content_block_stop", "message_stop"):
                    if pending_tool_name and skill_name in accumulated_json:
                        return True
                    pending_tool_name = None
            elif event.get("type") == "assistant":
                message = event.get("message", {})
                for content_item in message.get("content", []):
                    if content_item.get("type") != "tool_use":
                        continue
                    tool_name = content_item.get("name", "")
                    tool_input = content_item.get("input", {})
                    if tool_name == "Skill" and skill_name in tool_input.get("skill", ""):
                        return True
                    if tool_name == "Read" and skill_name in tool_input.get("file_path", ""):
                        return True
        return False

    return False


def extract_final_text(harness: str, stdout: str) -> str:
    """Best-effort final assistant text extraction for task eval transcripts."""
    if harness == "copilot":
        final = []
        for line in stdout.splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") == "assistant.message":
                data = event.get("data", {})
                if data.get("phase") == "final_answer" or data.get("content"):
                    content = data.get("content", "")
                    if content:
                        final.append(content)
        return "\n".join(final).strip() or stdout.strip()

    if harness == "pi":
        final = []
        for line in stdout.splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") in {"message_end", "turn_end"}:
                message = event.get("message", {})
                if message.get("role") == "assistant":
                    chunks = []
                    for item in message.get("content", []) or []:
                        if item.get("type") == "text":
                            chunks.append(item.get("text", ""))
                    if chunks:
                        final = ["".join(chunks)]
        return "\n".join(final).strip() or stdout.strip()

    # Claude and Codex text extraction is more version-dependent; keep the raw
    # transcript available and use stdout as fallback final text.
    return stdout.strip()


def build_task_prompt(prompt: str, outputs_dir: Path, input_files: list[str] | None = None, skill_path: Path | None = None, harness: str | None = None) -> str:
    input_files = input_files or []
    lines = [
        "Execute this evaluation task as an independent run.",
    ]
    if skill_path:
        lines.extend([
            f"Use the skill at: {skill_path.resolve()}",
            "Read its SKILL.md first if your harness does not load skills natively, then follow it.",
        ])
    else:
        lines.append("Do not intentionally use a task-specific skill; solve the task from the prompt and files alone.")
    if input_files:
        lines.append("Input files:")
        lines.extend(f"- {f}" for f in input_files)
    else:
        lines.append("Input files: none")
    lines.extend([
        f"Save all artifacts the user would care about under: {outputs_dir.resolve()}",
        "Also write a concise final answer. If you create no files, write your final answer to outputs/final_answer.md.",
        "",
        "Task prompt:",
        prompt,
    ])
    return "\n".join(lines)
