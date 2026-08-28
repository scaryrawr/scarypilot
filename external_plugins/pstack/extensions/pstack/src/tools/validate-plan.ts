import type { Tool } from "@github/copilot-sdk";
import type { PstackService } from "../service.ts";
import { json, requiredString } from "./common.ts";

interface ValidatePlanArgs {
  plan_path: string;
  profile?: "basic" | "verified-stack";
}

export function createValidatePlanTool(service: PstackService): Tool<ValidatePlanArgs> {
  return {
    name: "pstack_validate_plan",
    description:
      "Validate a Markdown plan with a named pstack profile and return structured rule findings. Use basic for ordinary checklist plans and verified-stack for pstack multi-PR plans.",
    parameters: {
      type: "object",
      properties: {
        plan_path: { type: "string", description: "Path to the Markdown plan." },
        profile: {
          type: "string",
          enum: ["basic", "verified-stack"],
          description: "Validation profile. Default verified-stack.",
        },
      },
      required: ["plan_path"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const result = await service.validatePlan(
        requiredString(args.plan_path, "plan_path"),
        args.profile,
      );
      return json({ ok: result.findings.length === 0, ...result });
    },
  };
}
