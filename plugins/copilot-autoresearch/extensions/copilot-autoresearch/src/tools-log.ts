import type { Tool } from "@github/copilot-sdk";
import { LogSchema, nativeResult, type LogArgs } from "./operations.ts";
import { logExperiment } from "./operation-log.ts";
import { nativeContext, type NativeContext } from "./native-operations.ts";

export type { LogArgs } from "./operations.ts";

export type LogContext = NativeContext & { onLogged: (run: number) => void };

export function createLogTool(ctx: LogContext): Tool<LogArgs> {
  return {
    name: "log_experiment",
    description:
      "Record an experiment result. Keep auto-commits all changes and replaces the placeholder commit with the SHA; discard/crash/checks_failed auto-revert code, preserving .auto/** and legacy autoresearch files. Use metric 0 for crashes/timeouts. Tracks secondary metrics consistently (force permits new metrics). Computes advisory confidence after 3+ runs. Always include asi.hypothesis; on discard/crash also rollback_reason and next_action_hint. For a retry after changed assumptions, set asi.revisits_run to an earlier run and explain the change.",
    parameters: {
      ...LogSchema,
      properties: {
        ...LogSchema.properties,
        asi: {
          type: "object",
          additionalProperties: true,
          description:
            "Actionable side information. Include hypothesis and, on discard/crash, rollback_reason and next_action_hint. revisits_run names an earlier run.",
        },
      },
    },
    handler: (args, invocation) =>
      nativeResult(() => logExperiment(nativeContext(ctx, invocation), args)),
  };
}
