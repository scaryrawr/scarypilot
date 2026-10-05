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
    ]) {
      const misleading = missing.replace("### Spawn owners", `${unrelated}\n\n### Spawn owners`);
      expect(validatePlanText(misleading, "verified-stack").findings).toEqual([{
        line: 14,
        rule: "audit-cadence",
        message: 'Program checklist needs "hourly" or "30-minute" on the audit tick or status message line',
      }]);
    }
  });
});
