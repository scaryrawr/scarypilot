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
FIXTURE_VOCABULARY = set("""
a about add adding agent agents all also an and any applicable are as at avoid
be behavior behaviour before by can change changes changing check checks client
clients code code-review compatibility compatible concise configuration configured context
contract contributor contributors coverage covers create default describes
description developer development directory do does edit editing entry
entrypoint exact existing exported exports fast file files focus for format
from function general generated greeting greetings greet grounded guidance has
hello hosted if implementation in incident index initialize instructions is it
javascript js json keep local locally local-only maps match mcp md name names
no node not npm of on only or otherwise output outputs package paths preserve
preserving project pull repository request requests require required requires
review reviewing reviews root run running runs same see server skill skills
small source specific src structure test testing tests that the their them
these this to under use used uses using validate validation verified verify
when which with without workflow write github available unavailable cannot
must never always should ensure maintain update related relies rely relied
exactly unchanged api public exported return returns string strings example
""".split())


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


def unsupported_requirement(text: str) -> bool:
    # Unknown substantive vocabulary may be harmless, but is not independently
    # grounded by this small fixture. Leave the broad "no invented requirements"
    # assertion ungraded rather than treating a blacklist miss as proof.
    return bool(set(re.findall(r"[a-z]+(?:-[a-z]+)*", text.lower())) - FIXTURE_VOCABULARY)


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
    invalid_validation = bool(re.search(r"(?:do not|never|avoid|skip)\s+(?:run(?:ning)?\s+)?npm test", agents + "\n" + review, re.I))
    structure = structure and not invalid_validation
    mapping = mapping and not invalid_validation
    compatibility = (
        "Hello, <name>!" in review
        and bool(re.search(r"preserv|exact|compatib", review, re.I))
        and bool(re.search(r"client|contract|format", review, re.I))
        and not re.search(r"(?:do not|never|avoid)\s+(?:preserv|keep)", review, re.I)
    )
    no_hosted_claim = mcp_scope_check(agents + "\n" + review)
    only_expected = set(inventory) == EXPECTED_FILES
    ambiguous = unsupported_requirement(agents + "\n" + review)
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
        requirement_check = False if no_hosted_claim is False else None if ambiguous else no_hosted_claim
        checks = [structure, review_file in inventory, schema_ok, mapping, requirement_check, only_expected]
        reasons = [
            "Root guidance names src/index.js, test/index.test.js, and npm test",
            "Default review skill exists in repository-relative output",
            "Frontmatter name is code-review and description targets pull request review",
            "Review relates greeting source changes, the specific test, and npm test",
            "MCP/incident clauses deny access; all prose uses the bounded fixture contract vocabulary",
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
        "limitations": "Conservative lexical contracts, not a general semantic judge. Unknown vocabulary makes the broad no-invented-requirements assertion ungraded. No claim of verified command execution.",
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
