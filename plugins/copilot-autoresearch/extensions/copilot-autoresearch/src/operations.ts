import { Type, type Static } from "@sinclair/typebox";
import type { CwdRef } from "./extension-context.ts";
import type { ExperimentRuntime } from "./state.ts";
import { JsonlEntrySchema } from "./jsonl.ts";

export const InitSchema = Type.Object({
  name: Type.String({ description: "Human-readable experiment session name." }),
  metric_name: Type.String({ description: "Primary metric name, matching METRIC output." }),
  metric_unit: Type.Optional(Type.String({ description: "Display unit; default is unitless." })),
  direction: Type.Optional(Type.Union([Type.Literal("lower"), Type.Literal("higher")])),
}, { additionalProperties: false });

export const RunSchema = Type.Object({
  command: Type.String({ description: "Bash shell command. Invoke the benchmark script when present." }),
  timeout_seconds: Type.Optional(Type.Number({ description: "Benchmark timeout in seconds. Default 600." })),
  checks_timeout_seconds: Type.Optional(Type.Number({ description: "Checks timeout in seconds. Default 300." })),
}, { additionalProperties: false });

export const LogSchema = Type.Object({
  commit: Type.String({ description: "Commit SHA placeholder, replaced by the actual SHA on automatic keep." }),
  metric: Type.Number({ description: "Primary metric value. Use 0 for crashes and timeouts." }),
  status: Type.Union([
    Type.Literal("keep"), Type.Literal("discard"),
    Type.Literal("crash"), Type.Literal("checks_failed"),
  ]),
  description: Type.String({ description: "Short description of what this experiment tried." }),
  metrics: Type.Optional(Type.Record(Type.String(), Type.Number(), {
    description: "Secondary metrics. Include every metric already tracked in the current segment.",
  })),
  force: Type.Optional(Type.Boolean({ description: "Permit a new secondary metric in the current segment." })),
  asi: Type.Optional(JsonlEntrySchema),
}, { additionalProperties: false });

export type InitArgs = Static<typeof InitSchema>;

export type RunArgs = Static<typeof RunSchema>;

export type LogArgs = Static<typeof LogSchema>;

export type RunOutcome = "passed" | "failed" | "timeout" | "checks_failed" | "aborted";

export interface OperationContext {
  cwdRef: CwdRef;
  runtime: ExperimentRuntime;
  log: (message: string, level?: "info" | "warning" | "error") => void;
  persist: () => void;
  changed?: (workDir: string) => void;
  progress?: (message: string) => void;
  onLogged?: (run: number) => void;
  onRunStarting?: (command: string) => void;
  onLogStarting?: (run: number) => void;
  onGitFailure?: (message: string) => void;
  onRunCompleted?: (outcome: RunOutcome) => void;
  git: "automatic" | "manual";
}

export class ExperimentError extends Error {}

export async function nativeResult(operation: () => Promise<string>): Promise<string> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ExperimentError) return error.message;
    throw error;
  }
}
