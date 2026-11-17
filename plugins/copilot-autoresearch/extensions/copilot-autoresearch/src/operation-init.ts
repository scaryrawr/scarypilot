import * as fs from "node:fs";
import {
  autoresearchJsonlPath,
  ensureParentDir,
  readMaxIterations,
  resolveWorkDir,
  validateWorkDir,
} from "./paths.ts";
import { ExperimentError, type InitArgs, type OperationContext } from "./operations.ts";
import { appendJsonlEntry } from "./jsonl.ts";

export async function initExperiment(ctx: OperationContext, args: InitArgs): Promise<string> {
  if (!ctx.runtime.autoresearchMode) {
    throw new ExperimentError("❌ Autoresearch mode is off. Start it with `/autoresearch <goal>`.");
  }

  const cwd = ctx.cwdRef.get();
  const workDirError = validateWorkDir(cwd);

  if (workDirError) throw new ExperimentError(`❌ ${workDirError}`);
  const workDir = resolveWorkDir(cwd);

  const jsonlPath = autoresearchJsonlPath(workDir);
  const jsonlExists = fs.existsSync(jsonlPath);
  const direction = args.direction === "higher" ? "higher" : "lower";

  const configEntry = {
    type: "config" as const,
    name: args.name,
    metricName: args.metric_name,
    metricUnit: args.metric_unit ?? "",
    bestDirection: direction,
    timestamp: Date.now(),
  };

  try {
    ensureParentDir(jsonlPath);
    appendJsonlEntry(jsonlPath, configEntry);
  } catch (error) {
    throw new ExperimentError(`❌ Failed to write ${jsonlPath}: ${
      error instanceof Error ? error.message : String(error)
    }`);
  }

  ctx.changed?.(workDir);
  ctx.runtime.lastRunChecks = null;
  ctx.runtime.lastRunDurationSeconds = null;
  ctx.persist();

  const maxIterations = readMaxIterations(cwd);
  const limitNote = maxIterations !== null ? `\nMax iterations: ${maxIterations}` : "";

  const reinitNote = jsonlExists
    ? " (re-initialized — previous results archived in earlier segment)"
    : "";

  const workDirNote = workDir !== cwd ? `\nWorking directory: ${workDir}` : "";
  ctx.log(`Autoresearch initialized: ${args.name}`);

  return (
    `✅ Experiment initialized: "${args.name}"${reinitNote}\n` +
    `Metric: ${args.metric_name} (${args.metric_unit || "unitless"}, ${direction} is better)` +
    `${limitNote}${workDirNote}\n` +
    `Config written to ${jsonlPath}. Now run the baseline with run_experiment.`
  );
}
