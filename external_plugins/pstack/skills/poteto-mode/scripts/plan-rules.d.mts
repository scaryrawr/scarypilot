export interface PlanFinding {
  readonly line: number;
  readonly rule: string;
  readonly message: string;
}

export interface PlanValidation {
  readonly profile: string;
  readonly findings: readonly PlanFinding[];
  readonly report: readonly string[];
}

export const PLAN_PROFILES: readonly ["basic", "verified-stack"];
export function validatePlanText(rawText: string, profile?: string): PlanValidation;
