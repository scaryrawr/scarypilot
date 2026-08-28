import type { Tool } from "@github/copilot-sdk";
import type { PstackService } from "../service.ts";
import { json } from "./common.ts";

interface StatusArgs {
  store_dir?: string;
  watch_files?: string[];
  include_worktrees?: boolean;
  base_ref?: string;
}

export function createStatusTool(service: PstackService): Tool<StatusArgs> {
  return {
    name: "pstack_status",
    description:
      "Build a deterministic PstackSnapshot from existing orch, watch-pr, handoff, capability, and optional worktree facts. Read-only: the snapshot is a projection, not a new state store.",
    parameters: {
      type: "object",
      properties: {
        store_dir: { type: "string", description: "Existing orch store. Auto-detected only when exactly one store exists." },
        watch_files: { type: "array", items: { type: "string" }, description: "watch-pr NDJSON files to include." },
        include_worktrees: { type: "boolean", description: "Include read-only worktree inspection. Default false." },
        base_ref: { type: "string", description: "Optional trusted base ref for worktree merge checks." },
      },
      additionalProperties: false,
    },
    handler: async (args) =>
      json(
        await service.status({
          storeDir: args.store_dir,
          watchFiles: args.watch_files,
          includeWorktrees: args.include_worktrees,
          baseRef: args.base_ref,
        }),
      ),
  };
}
