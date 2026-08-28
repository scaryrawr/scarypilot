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
});
