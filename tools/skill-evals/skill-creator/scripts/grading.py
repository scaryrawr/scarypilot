"""Independent, conservative contracts for better-init's fixture-backed tasks.

These are lexical semantic contracts, not a general prose judge. Unknown assertions
and unsupported requirement sentences remain ungraded rather than passing.
"""

from __future__ import annotations

import re
from pathlib import Path

from scripts.harnesses import Evidence, file_inventory
from scripts.utils import parse_skill_md


ASSERTIONS = {
    7: [
        "AGENTS.md describes the verified repository structure and npm test command.",
        ".github/skills/code-review/SKILL.md exists without an explicit request to add review guidance.",
        "The code-review skill preserves the existing exact greeting output compatibility check.",
        "The code-review skill maps src/index.js changes to test/index.test.js and applicable validation.",
        "The code-review skill does not claim hosted review access to the local-only incident MCP server configured in .mcp.json.",
    ],
    8: [
        "AGENTS.md describes src/index.js, test/index.test.js, and npm test.",
        ".github/skills/code-review/SKILL.md exists without the prompt mentioning review.",
        "The review skill has name: code-review and a description explicitly targeting pull request review.",
        "The review skill maps changes in src/index.js to greeting behavior and test/index.test.js with applicable validation.",
        "The review skill does not invent unusual requirements or claim hosted access to the local incident MCP configuration.",
        "No unnecessary Copilot instructions, additional skills, or custom agents are created.",
    ],
}
EXPECTED_FILES = {"AGENTS.md", ".github/skills/code-review/SKILL.md"}
REQUIRED_VIEWS = {
    "inputs/simple-repository/package.json",
    "inputs/simple-repository/src/index.js",
    "inputs/simple-repository/test/index.test.js",
    "inputs/simple-repository/.mcp.json",
}
def sentences(text: str) -> list[str]:
    return re.split(r"(?<=[.!?])\s+|\n+", text.lower())


def mcp_scope_check(text: str) -> bool | None:
    ambiguous = False
    for sentence in sentences(text):
        if not re.search(r"\b(mcp|incident|hosted)\b", sentence):
            continue
        sentence = sentence.strip(" .`")
        if re.fullmatch(
            r"(?:the )?(?:incident )?mcp (?:server|configuration) is local[- ]only"
            r"(?:,? (?:and )?(?:not available|unavailable) (?:in|to|for) hosted review)?",
            sentence,
        ):
            continue
        if re.fullmatch(r"(?:do not|never) (?:use|consult|access) (?:the )?(?:local[- ]only )?incident mcp (?:server|configuration) (?:in|for) hosted review", sentence):
            continue
        if "hosted" in sentence and re.search(r"\b(can|must|should|available|access|use|consult)\b", sentence) and not re.search(r"\b(not|no|never|cannot|unavailable)\b", sentence):
            return False
        ambiguous = True
    return None if ambiguous else True


def grade(case_id: int, assertions: list[str], outputs: Path, evidence: Evidence, require_candidate: bool = True) -> dict:
    if assertions != ASSERTIONS.get(case_id):
        return {
            "status": "not_run", "reason": "No deterministic contract for these exact assertions",
            "expectations": [{"text": text, "passed": None, "evidence": "Unsupported assertion"} for text in assertions],
        }
    inventory = file_inventory(outputs)
    agents = (outputs / "AGENTS.md").read_text() if "AGENTS.md" in inventory else ""
    review_path = outputs / ".github/skills/code-review"
    review_file = ".github/skills/code-review/SKILL.md"
    review = (outputs / review_file).read_text() if review_file in inventory else ""
    normalized_review = re.sub(r"[`*_~]", "", review)
    normalized_guidance = re.sub(r"[`*_~]", "", agents) + "\n" + normalized_review
    schema_ok = False
    if review:
        try:
            name, description, _ = parse_skill_md(review_path)
            schema_ok = name == "code-review" and bool(re.search(r"pull requests?", description, re.I)) and bool(re.search(r"review", description, re.I))
        except ValueError:
            pass
    structure = all(word in agents for word in ("src/index.js", "test/index.test.js", "npm test"))
    mapping = all(word in review for word in ("src/index.js", "test/index.test.js"))
    mapping = mapping and ("npm test" in review or ("AGENTS.md" in review and bool(re.search(r"validat|test command", review, re.I))))
    mapping = mapping and bool(re.search(r"chang|review", review, re.I)) and bool(re.search(r"greeting", review, re.I))
    invalid_validation = bool(re.search(r"(?:do not|never|avoid|skip)\s+(?:run(?:ning)?\s+)?npm test", normalized_guidance, re.I))
    structure = structure and not invalid_validation
    mapping = mapping and not invalid_validation
    compatibility = (
        "Hello, <name>!" in review
        and bool(re.search(r"preserv|exact|compatib", review, re.I))
        and bool(re.search(r"client|contract|format", review, re.I))
        and not re.search(r"(?:do not|never|avoid)\s+(?:preserv|keep)", normalized_review, re.I)
    )
    no_hosted_claim = mcp_scope_check(normalized_guidance)
    only_expected = set(inventory) == EXPECTED_FILES
    required_views = REQUIRED_VIEWS | ({"inputs/existing-code-review.md"} if case_id == 7 else set())
    candidate_ok = evidence.candidate_loaded if require_candidate else not evidence.candidate_loaded
    trace_ok = candidate_ok and required_views.issubset(set(evidence.views))
    writes_ok = {f"outputs/{path}" for path in EXPECTED_FILES}.issubset(set(evidence.writes))
    if case_id == 7:
        checks = [structure, review_file in inventory and schema_ok, compatibility, mapping, no_hosted_claim]
        reasons = [
            "Root guidance names the fixture's source, test, and npm test command",
            "Default review file has review-targeted frontmatter",
            "Review explicitly preserves the exact Hello, <name>! client format",
            "Review relates greeting source changes, the specific test, and npm test",
            "All MCP/incident clauses explicitly deny access or describe local-only scope",
        ]
    else:
        # Lexical checks cannot establish that arbitrary requirements are grounded,
        # even when all their words occur in the fixture.
        requirement_check = False if no_hosted_claim is False else None
        checks = [structure, review_file in inventory, schema_ok, mapping, requirement_check, only_expected]
        reasons = [
            "Root guidance names src/index.js, test/index.test.js, and npm test",
            "Default review skill exists in repository-relative output",
            "Frontmatter name is code-review and description targets pull request review",
            "Review relates greeting source changes, the specific test, and npm test",
            "The broad no-invented-requirements assertion needs independent semantic grading; lexical matches cannot establish it",
            "Exactly AGENTS.md and the code-review SKILL.md were generated",
        ]
    expectations = [
        {"text": text, "passed": check, "evidence": reason if check else f"Not established: {reason}"}
        for text, check, reason in zip(assertions, checks, reasons)
    ]
    passed = sum(item["passed"] is True for item in expectations)
    failed = sum(item["passed"] is False for item in expectations)
    status = "failed" if failed or not trace_ok or not writes_ok or not only_expected else "not_run" if passed != len(assertions) else "passed"
    return {
        "status": status, "grader": "better-init-file-contract-v1",
        "expectations": expectations,
        "summary": {"passed": passed, "failed": failed, "total": len(assertions), "pass_rate": passed / len(assertions)},
        "execution_checks": {"expected_skill_usage": candidate_ok, "required_fixture_views": trace_ok, "expected_output_writes": writes_ok, "output_scope": only_expected},
        "limitations": "Conservative lexical contracts, not a general semantic judge. The broad no-invented-requirements assertion stays ungraded unless a hosted-access contradiction is detected. No claim of verified command execution.",
    }


def verify_grading(grading: dict, assertions: list[str]) -> str:
    expectations = grading.get("expectations")
    if not assertions or not isinstance(expectations, list) or len(expectations) != len(assertions):
        return "error"
    if [item.get("text") for item in expectations if isinstance(item, dict)] != assertions:
        return "error"
    values = [item.get("passed") for item in expectations]
    if any(value is not None and type(value) is not bool for value in values):
        return "error"
    if grading.get("status") == "passed":
        checks = grading.get("execution_checks")
        if all(value is True for value in values) and isinstance(checks, dict) and checks and all(value is True for value in checks.values()):
            return "passed"
        return "error"
    if grading.get("status") == "failed":
        return "failed"
    return "not_run"
