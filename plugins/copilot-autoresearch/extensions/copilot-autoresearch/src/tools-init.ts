import type { Tool } from "@github/copilot-sdk";
import { InitSchema, nativeResult, type InitArgs } from "./operations.ts";
import { initExperiment } from "./operation-init.ts";
import { nativeContext, type NativeContext } from "./native-operations.ts";

export type { InitArgs } from "./operations.ts";

export type InitContext = NativeContext;

export function createInitTool(ctx: InitContext): Tool<InitArgs> {
  return {
    name: "init_experiment",
    description:
      "Initialize the autoresearch session before the baseline. Sets name, primary metric, unit (default unitless), and direction (default lower). Appends config to .auto/log.jsonl or the active legacy log. Re-call for a new segment and fresh baseline; previous results remain.",
    parameters: InitSchema,
    handler: (args, invocation) =>
      nativeResult(() => initExperiment(nativeContext(ctx, invocation), args)),
  };
}
