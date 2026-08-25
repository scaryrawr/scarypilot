import * as fs from "node:fs";
import type { Tool } from "@github/copilot-sdk";
import {
  autoresearchJsonlPath,
  ensureParentDir,
  readMaxIterations,
  resolveWorkDir,
  validateWorkDir,
} from "./paths.ts";
import type { CwdRef } from "./extension-context.ts";
import type { RuntimeState } from "./state.ts";
import { savePersistedRuntime } from "./state.ts";
import { broadcastDashboardUpdate } from "./dashboard.ts";

export interface InitArgs {
  name: string;
  metric_name: string;
  metric_unit?: string;
  direction?: "lower" | "higher";
}

export interface InitContext {
  cwdRef: CwdRef;
  runtime: RuntimeState;
  log: (message: string) => void;
}

export function createInitTool(ctx: InitContext): Tool<InitArgs> {
  return {
    name: "init_experiment",
    description:
      "Initialize the autoresearch session. Call once before the first run_experiment to set the name, primary metric, unit, and direction. Writes a config header to .auto/log.jsonl (or the active legacy log). Re-call to start a new segment with a fresh baseline (previous results are preserved).",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Human-readable name for this experiment session (e.g. 'Speed up vitest unit tests').",
        },
        metric_name: {
          type: "string",
          description:
            "Display name for the primary metric (e.g. 'total_µs', 'bundle_kb', 'val_bpb').",
        },
        metric_unit: {
          type: "string",
          description:
            "Unit for the primary metric. One of 'µs', 'ms', 's', 'kb', 'mb', or '' for unitless. Default: ''.",
        },
        direction: {
          type: "string",
          enum: ["lower", "higher"],
          description: "Whether 'lower' or 'higher' is better. Default: 'lower'.",
        },
      },
      required: ["name", "metric_name"],
      additionalProperties: false,
    },
    handler: async (args, invocation) => {
      if (!ctx.runtime.autoresearchMode) {
        return "❌ Autoresearch mode is off. Start it with `/autoresearch <goal>`.";
      }
      const cwd = ctx.cwdRef.get();
      const workDirError = validateWorkDir(cwd);
      if (workDirError) return `❌ ${workDirError}`;
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
        const line = JSON.stringify(configEntry) + "\n";
        if (jsonlExists) fs.appendFileSync(jsonlPath, line);
        else fs.writeFileSync(jsonlPath, line);
      } catch (e) {
        return `❌ Failed to write ${jsonlPath}: ${
          e instanceof Error ? e.message : String(e)
        }`;
      }
      broadcastDashboardUpdate(workDir);

      ctx.runtime.lastRunChecks = null;
      ctx.runtime.lastRunDurationSeconds = null;
      savePersistedRuntime(workDir, invocation.sessionId, ctx.runtime);

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
    },
  };
}
