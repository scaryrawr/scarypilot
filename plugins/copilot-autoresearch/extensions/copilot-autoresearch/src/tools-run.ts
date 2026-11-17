import type { Tool } from "@github/copilot-sdk";
import { RunSchema, nativeResult, type RunArgs } from "./operations.ts";
import { runExperiment } from "./operation-run.ts";
import { nativeContext, type NativeContext } from "./native-operations.ts";

export { clearLastOutput } from "./operation-run.ts";

export type { RunArgs } from "./operations.ts";

export type RunContext = NativeContext;

export function createRunTool(ctx: RunContext): Tool<RunArgs> {
  return {
    name: "run_experiment",
    description:
      "Run a shell experiment, timing the benchmark and parsing METRIC name=value lines. Uses .auto/measure.sh when present. Returns the last 10 lines / 4 KB. Runs .auto/checks.sh after a passing benchmark, excluding checks time from the metric. Default timeouts are 600s for benchmark and 300s for checks. Always follow with log_experiment.",
    parameters: RunSchema,
    handler: (args, invocation) =>
      nativeResult(() => runExperiment(nativeContext(ctx, invocation), args, invocation.signal)),
  };
}
