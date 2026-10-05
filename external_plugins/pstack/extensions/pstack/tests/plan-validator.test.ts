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
        rule: "program-marker",
        message: 'Program checklist lacks "/(?:30[- ]minute|hourly)/"',
      },
    ]);
  });
});
