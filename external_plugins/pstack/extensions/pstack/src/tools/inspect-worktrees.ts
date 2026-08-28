import type { Tool } from "@github/copilot-sdk";
import type { PstackService } from "../service.ts";
import { json } from "./common.ts";

interface InspectWorktreesArgs {
  base_ref?: string;
}

export function createInspectWorktreesTool(
  service: PstackService,
): Tool<InspectWorktreesArgs> {
  return {
    name: "pstack_inspect_worktrees",
    description:
      "Inspect Git worktrees without fetching, deleting, or allocating temporary files. Results never grant deletion permission because active Copilot session use is unknown.",
    parameters: {
      type: "object",
      properties: {
        base_ref: { type: "string", description: "Optional trusted base ref. Otherwise origin/HEAD is used when available." },
      },
      additionalProperties: false,
    },
    handler: async (args) => json(await service.inspectWorktrees(args.base_ref)),
  };
}
