import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validatePlanText } from "../../../skills/poteto-mode/scripts/plan-rules.mjs";

describe("validatePlanText", () => {
  it("supports a lightweight basic profile", () => {
    expect(validatePlanText("# Plan\n\n- [ ] Do the thing\n", "basic").findings).toEqual([]);
  });

  it("keeps verified-stack strict", () => {
    const result = validatePlanText("# Plan\n\n- [ ] Do the thing\n", "verified-stack");
    expect(result.findings.map((finding) => finding.rule)).toContain("how-to-read");
  });

  it("accepts hourly audits without invalidating saved 30-minute plans", () => {
    const legacy = readFileSync(
      new URL("./fixtures/plan-verified-stack-valid.md", import.meta.url),
      "utf8",
    );

    expect(validatePlanText(legacy, "verified-stack").findings).toEqual([]);
    const hourly = legacy.replace("30-minute", "hourly");
    expect(validatePlanText(hourly, "verified-stack").findings).toEqual([]);
    const missing = hourly.replace("hourly ", "");
    expect(validatePlanText(missing, "verified-stack").findings).toEqual([
      {
        line: 14,
        rule: "audit-cadence",
        message: 'Program checklist needs "hourly" or "30-minute" on the audit tick or status message line',
      },
    ]);
  });

  it("rejects unrelated or fenced cadence text in an unscheduled plan", () => {
    const legacy = readFileSync(
      new URL("./fixtures/plan-verified-stack-valid.md", import.meta.url),
      "utf8",
    );

    const missing = legacy.replace("30-minute ", "");

    for (const unrelated of [
      "- [ ] Reconcile hourly billing.",
      "- [ ] Reconcile 30-minute billing.",
      "```text\nhourly audit tick\n```",
      "   ```text\nhourly audit tick\n   ```",
      "~~~text\nhourly audit tick\n~~~",
      "   ~~~text\nhourly audit tick\n   ~~~",
      "````text\n```\nhourly audit tick\n````",
      "~~~text\n```\nhourly audit tick\n~~~",
      "```text\n~~~\nhourly audit tick\n```",
      "```text\n```not-a-close\nhourly audit tick\n```",
    ]) {
      const misleading = missing.replace("### Spawn owners", `${unrelated}\n\n### Spawn owners`);
      expect(validatePlanText(misleading, "verified-stack").findings).toEqual([{
        line: 14,
        rule: "audit-cadence",
        message: 'Program checklist needs "hourly" or "30-minute" on the audit tick or status message line',
      }]);
    }
  });

  it("tracks Markdown fence delimiters, lengths, indentation, and matching closes", () => {
    for (const delimiter of ["`", "~"]) {
      for (const indentation of ["", " ", "  ", "   "]) {
        const opening = `${indentation}${delimiter.repeat(4)}text`;
        const closing = `${indentation}${delimiter.repeat(5)} \t`;
        const plan = `# Plan\n- [ ] Verify fences.\n${opening}\ncode: ignored\n${closing}\nprose: checked\n`;

        expect(validatePlanText(plan, "basic").findings).toEqual([{
          line: 6,
          rule: "sentence-colon",
          message: "mid-sentence colon",
        }]);
      }
    }
  });

  it("keeps mismatched or unclosed fences in code until a valid close", () => {
    for (const [opening, invalidClose, closing] of [
      ["````text", "```", "````"],
      ["~~~text", "```", "~~~"],
      ["```text", "~~~", "```"],
      ["```text", "```not-a-close", "```"],
      ["~~~text", "    ~~~", "~~~"],
    ]) {
      const prefix = `# Plan\n- [ ] Verify fences.\n${opening}\n${invalidClose}\ncode: ignored\n`;

      expect(validatePlanText(prefix, "basic").findings).toEqual([]);
      expect(validatePlanText(`${prefix}${closing}\nprose: checked\n`, "basic").findings).toEqual([{
        line: 7,
        rule: "sentence-colon",
        message: "mid-sentence colon",
      }]);
    }
  });

  it("does not open a backtick fence with backticks in its info string", () => {
    expect(validatePlanText("# Plan\n- [ ] Verify fences.\n```text `invalid`\nprose: checked\n", "basic").findings).toEqual([{
      line: 4,
      rule: "sentence-colon",
      message: "mid-sentence colon",
    }]);
    expect(validatePlanText("# Plan\n- [ ] Verify fences.\n~~~text `valid`\ncode: ignored\n~~~\n", "basic").findings).toEqual([]);
  });
});
