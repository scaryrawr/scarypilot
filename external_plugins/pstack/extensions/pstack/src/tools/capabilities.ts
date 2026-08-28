import type { Tool } from "@github/copilot-sdk";
import type { PstackService } from "../service.ts";
import { json } from "./common.ts";

export function createCapabilitiesTool(service: PstackService): Tool<Record<string, never>> {
  return {
    name: "pstack_capabilities",
    description:
      "Report which pstack dependencies are available, unavailable, or host-controlled and unknown. Unknown capabilities must be treated as unavailable until the host proves them.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: async () => json(await service.capabilities()),
  };
}
