#!/usr/bin/env python3
"""Improve a skill description based on eval results.

Modified from Anthropic's skill-creator distribution to call Copilot CLI by
default instead of requiring `claude -p`. Legacy non-Copilot harnesses remain
available when explicitly selected. Original project copyright and Apache-2.0
license are retained in ../LICENSE.txt.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.harnesses import choose_harness, codex_command, copilot_command, pi_command, run_command
from scripts.utils import parse_skill_md


def _call_agent(prompt: str, model: str | None, harness: str = "copilot", timeout: int = 300) -> str:
    """Run the requested harness non-interactively and return text output."""
    selected = choose_harness(harness, trigger_only=False)[0]
    cwd = Path.cwd()

    if selected == "copilot":
        args = copilot_command(prompt, model=model)
        code, stdout, stderr, _ = run_command(args, cwd=cwd, timeout=timeout)
        if code != 0:
            raise RuntimeError(f"copilot exited {code}\nstderr: {stderr}")
        # In text mode extraction is unnecessary because copilot_command emits JSON;
        # pull the last assistant content if possible.
        chunks: list[str] = []
        for line in stdout.splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") == "assistant.message":
                content = event.get("data", {}).get("content", "")
                if content:
                    chunks.append(content)
        return "\n".join(chunks).strip() or stdout

    if selected == "pi":
        args = pi_command(prompt, model=model, no_skills=True)
        code, stdout, stderr, _ = run_command(args, cwd=cwd, timeout=timeout)
        if code != 0:
            raise RuntimeError(f"pi exited {code}\nstderr: {stderr}")
        chunks: list[str] = []
        for line in stdout.splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") in {"message_end", "turn_end"}:
                msg = event.get("message", {})
                if msg.get("role") == "assistant":
                    texts = [c.get("text", "") for c in msg.get("content", []) if c.get("type") == "text"]
                    if texts:
                        chunks = ["".join(texts)]
        return "\n".join(chunks).strip() or stdout

    if selected == "codex":
        args = codex_command(prompt, model=model, cwd=cwd)
        code, stdout, stderr, _ = run_command(args, cwd=cwd, timeout=timeout)
        if code != 0:
            raise RuntimeError(f"codex exited {code}\nstderr: {stderr}")
        # Codex --json shape may change; raw stdout is acceptable because the
        # parser below only needs the <new_description> tags.
        return stdout

    # Claude fallback: import here to avoid circular import at module import time.
    from scripts.harnesses import claude_command

    args, env = claude_command(prompt, model=model)
    # For improvement we prefer text output; claude_command is stream-json for
    # trigger detection, so use the simpler command directly.
    args = ["claude", "-p", "--output-format", "text"] + (["--model", model] if model else [])
    code, stdout, stderr, _ = run_command(args, cwd=cwd, timeout=timeout, stdin=prompt, env=env)
    if code != 0:
        raise RuntimeError(f"claude -p exited {code}\nstderr: {stderr}")
    return stdout


def improve_description(
    skill_name: str,
    skill_content: str,
    current_description: str,
    eval_results: dict,
    history: list[dict],
    model: str | None = None,
    test_results: dict | None = None,
    log_dir: Path | None = None,
    iteration: int | None = None,
    harness: str = "copilot",
) -> str:
    """Call an agent harness to improve the description based on eval results."""
    failed_triggers = [r for r in eval_results["results"] if r["should_trigger"] and not r["pass"]]
    false_triggers = [r for r in eval_results["results"] if not r["should_trigger"] and not r["pass"]]

    train_score = f"{eval_results['summary']['passed']}/{eval_results['summary']['total']}"
    if test_results:
        test_score = f"{test_results['summary']['passed']}/{test_results['summary']['total']}"
        scores_summary = f"Train: {train_score}, Test: {test_score}"
    else:
        scores_summary = f"Train: {train_score}"

    prompt = f"""You are optimizing a skill description for an agent skill called "{skill_name}". A skill is a self-contained folder with a SKILL.md file. The harness sees only the skill name and description when deciding whether to load the full skill.

The description appears in the harness's available-skills list. When a user sends a query, the harness decides whether to invoke the skill based solely on the title and this description. Your goal is to write a description that triggers for relevant queries and does not trigger for irrelevant ones.

Current description:
<current_description>
{current_description}
</current_description>

Current scores ({scores_summary}):
"""
    if failed_triggers:
        prompt += "FAILED TO TRIGGER (should have triggered but didn't):\n"
        for r in failed_triggers:
            prompt += f'  - "{r["query"]}" (triggered {r["triggers"]}/{r["runs"]} times, harness={r.get("harness", "?")})\n'
        prompt += "\n"

    if false_triggers:
        prompt += "FALSE TRIGGERS (triggered but shouldn't have):\n"
        for r in false_triggers:
            prompt += f'  - "{r["query"]}" (triggered {r["triggers"]}/{r["runs"]} times, harness={r.get("harness", "?")})\n'
        prompt += "\n"

    if history:
        prompt += "PREVIOUS ATTEMPTS (do NOT repeat these — try something structurally different):\n\n"
        for h in history:
            train_s = f"{h.get('train_passed', h.get('passed', 0))}/{h.get('train_total', h.get('total', 0))}"
            test_s = f"{h.get('test_passed', '?')}/{h.get('test_total', '?')}" if h.get('test_passed') is not None else None
            score_str = f"train={train_s}" + (f", test={test_s}" if test_s else "")
            prompt += f'<attempt {score_str}>\n'
            prompt += f'Description: "{h["description"]}"\n'
            if "results" in h:
                prompt += "Train results:\n"
                for r in h["results"]:
                    status = "PASS" if r["pass"] else "FAIL"
                    prompt += f'  [{status}] "{r["query"][:80]}" (triggered {r["triggers"]}/{r["runs"]})\n'
            if h.get("note"):
                prompt += f'Note: {h["note"]}\n'
            prompt += "</attempt>\n\n"

    prompt += f"""
Skill content (for context on what the skill does):
<skill_content>
{skill_content}
</skill_content>

Based on the failures, write a new and improved description that is more likely to trigger correctly. Avoid overfitting to the exact queries. Generalize to broader user intents and situations where this skill is useful or not useful.

Description constraints:
- 100-200 words is fine, shorter is better.
- Hard limit: 1024 characters.
- Phrase it as an imperative, e.g. "Use this skill for...".
- Focus on user intent and outcomes, not implementation details.
- Make it distinctive so it competes well with other skills.

Respond with only the new description text in <new_description> tags, nothing else.
"""

    text = _call_agent(prompt, model, harness=harness)
    match = re.search(r"<new_description>(.*?)</new_description>", text, re.DOTALL)
    description = match.group(1).strip().strip('"') if match else text.strip().strip('"')

    transcript: dict = {
        "iteration": iteration,
        "harness": choose_harness(harness, trigger_only=False)[0],
        "prompt": prompt,
        "response": text,
        "parsed_description": description,
        "char_count": len(description),
        "over_limit": len(description) > 1024,
    }

    if len(description) > 1024:
        shorten_prompt = (
            f"{prompt}\n\n---\n\nA previous attempt produced this description, which at "
            f"{len(description)} characters is over the 1024-character hard limit:\n\n"
            f'"{description}"\n\nRewrite it under 1024 characters while keeping the most important trigger words. '
            f"Respond with only the new description in <new_description> tags."
        )
        shorten_text = _call_agent(shorten_prompt, model, harness=harness)
        match = re.search(r"<new_description>(.*?)</new_description>", shorten_text, re.DOTALL)
        shortened = match.group(1).strip().strip('"') if match else shorten_text.strip().strip('"')
        transcript["rewrite_prompt"] = shorten_prompt
        transcript["rewrite_response"] = shorten_text
        transcript["rewrite_description"] = shortened
        transcript["rewrite_char_count"] = len(shortened)
        description = shortened

    transcript["final_description"] = description

    if log_dir:
        log_dir.mkdir(parents=True, exist_ok=True)
        log_file = log_dir / f"improve_iter_{iteration or 'unknown'}.json"
        log_file.write_text(json.dumps(transcript, indent=2))

    return description


def main() -> None:
    parser = argparse.ArgumentParser(description="Improve a skill description based on eval results")
    parser.add_argument("--eval-results", required=True, help="Path to eval results JSON (from run_eval.py)")
    parser.add_argument("--skill-path", required=True, help="Path to skill directory")
    parser.add_argument("--history", default=None, help="Path to history JSON (previous attempts)")
    parser.add_argument("--model", default=None, help="Model for improvement")
    parser.add_argument("--harness", default="copilot", help="Harness for improvement: copilot (default), or legacy: auto, pi, claude, codex")
    parser.add_argument("--verbose", action="store_true", help="Print progress to stderr")
    args = parser.parse_args()

    skill_path = Path(args.skill_path)
    if not (skill_path / "SKILL.md").exists():
        print(f"Error: No SKILL.md found at {skill_path}", file=sys.stderr)
        sys.exit(1)

    eval_results = json.loads(Path(args.eval_results).read_text())
    history = json.loads(Path(args.history).read_text()) if args.history else []

    name, _, content = parse_skill_md(skill_path)
    current_description = eval_results["description"]

    if args.verbose:
        print(f"Current: {current_description}", file=sys.stderr)
        print(f"Score: {eval_results['summary']['passed']}/{eval_results['summary']['total']}", file=sys.stderr)

    new_description = improve_description(
        skill_name=name,
        skill_content=content,
        current_description=current_description,
        eval_results=eval_results,
        history=history,
        model=args.model,
        harness=args.harness,
    )

    if args.verbose:
        print(f"Improved: {new_description}", file=sys.stderr)

    output = {
        "description": new_description,
        "history": history + [{
            "description": current_description,
            "passed": eval_results["summary"]["passed"],
            "failed": eval_results["summary"]["failed"],
            "total": eval_results["summary"]["total"],
            "results": eval_results["results"],
        }],
    }
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
