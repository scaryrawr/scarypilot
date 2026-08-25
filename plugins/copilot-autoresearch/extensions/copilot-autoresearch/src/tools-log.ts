import * as fs from "node:fs";
import type { Tool } from "@github/copilot-sdk";
import {
  autoresearchJsonlPath,
  ensureParentDir,
  readMaxIterations,
  resolveWorkDir,
  validateWorkDir,
} from "./paths.ts";
import {
  reconstructJsonlState,
  type ReconstructedRun,
  type Direction,
} from "./jsonl.ts";
import {
  computeConfidence,
  currentResults,
  findBaselineMetric,
  findBaselineSecondary,
} from "./confidence.ts";
import { formatDelta, formatNum } from "./format.ts";
import { gitAutoCommit, gitRevertNonAutoresearch } from "./git.ts";
import {
  appendHookLogEntryIfConfigured,
  runHook,
  steerMessageFor,
} from "./hooks.ts";
import {
  clearPersistedRuntime,
  isGitRepo,
  savePersistedRuntime,
  type RuntimeState,
} from "./state.ts";
import type { CwdRef } from "./extension-context.ts";
import { inferMetricUnit } from "./jsonl.ts";
import { broadcastDashboardUpdate } from "./dashboard.ts";

export interface LogArgs {
  commit: string;
  metric: number;
  status: "keep" | "discard" | "crash" | "checks_failed";
  description: string;
  metrics?: Record<string, number>;
  force?: boolean;
  asi?: Record<string, unknown>;
}

export interface LogContext {
  cwdRef: CwdRef;
  runtime: RuntimeState;
  log: (message: string, level?: "info" | "warning" | "error") => void;
  /**
   * Called when a new run is logged so the extension's auto-resume scheduler
   * can decide whether to fire a follow-up `Run the next iteration now` prompt.
   */
  onLogged: (newRunNumber: number) => void;
}

export function createLogTool(ctx: LogContext): Tool<LogArgs> {
  return {
    name: "log_experiment",
    description:
      "Record an experiment result. On 'keep' it auto-runs `git add -A && git commit`. On 'discard'/'crash'/'checks_failed' it auto-reverts code changes (`.auto/**` and legacy autoresearch files are preserved). Computes a session confidence score after 3+ runs (best improvement / median absolute deviation). Always include the asi parameter — at minimum {\"hypothesis\": \"what you tried\"}; on discard/crash also rollback_reason and next_action_hint.",
    parameters: {
      type: "object",
      properties: {
        commit: {
          type: "string",
          description:
            "Git commit hash (short, 7 chars) — used as a placeholder before this experiment is committed. Will be replaced with the actual SHA when status='keep'.",
        },
        metric: {
          type: "number",
          description:
            "The primary optimization metric value. 0 for crashes/timeouts.",
        },
        status: {
          type: "string",
          enum: ["keep", "discard", "crash", "checks_failed"],
          description:
            "'keep' if the primary metric improved, 'discard' if worse/unchanged, 'crash' if the benchmark failed, 'checks_failed' if benchmark passed but .auto/checks.sh failed.",
        },
        description: {
          type: "string",
          description: "Short human description of what this experiment tried.",
        },
        metrics: {
          type: "object",
          additionalProperties: { type: "number" },
          description:
            "Additional secondary metrics as { name: value } pairs. These are tracked for tradeoff monitoring; once a metric is recorded once, every subsequent log_experiment must include it.",
        },
        force: {
          type: "boolean",
          description:
            "Set true to allow adding a new secondary metric that wasn't tracked before in the current segment.",
        },
        asi: {
          type: "object",
          additionalProperties: true,
          description:
            "Actionable Side Information — free-form structured diagnostics. At minimum: hypothesis. On discard/crash: also rollback_reason and next_action_hint.",
        },
      },
      required: ["commit", "metric", "status", "description"],
      additionalProperties: false,
    },
    handler: async (args) => {
      if (!ctx.runtime.autoresearchMode) {
        return "❌ Autoresearch mode is off. Start it with `/autoresearch <goal>`.";
      }
      const cwd = ctx.cwdRef.get();
      const workDirError = validateWorkDir(cwd);
      if (workDirError) return `❌ ${workDirError}`;
      const workDir = resolveWorkDir(cwd);

      // Gate: prevent 'keep' when checks failed in the most recent run_experiment
      if (
        args.status === "keep" &&
        ctx.runtime.lastRunChecks &&
        !ctx.runtime.lastRunChecks.pass
      ) {
        const tail = ctx.runtime.lastRunChecks.output.slice(-500);
        return [
          "❌ Cannot keep — .auto/checks.sh failed on the previous run_experiment.",
          "",
          tail,
          "",
          "Log as 'checks_failed' instead. The benchmark metric is valid but correctness checks did not pass.",
        ].join("\n");
      }

      const jsonlPath = autoresearchJsonlPath(workDir);
      const before = reconstructJsonlState(safeRead(jsonlPath));

      // Validate secondary metrics consistency
      const provided = args.metrics ?? {};
      const knownNames = new Set(before.secondaryMetrics.map((m) => m.name));
      const providedNames = new Set(Object.keys(provided));
      if (knownNames.size > 0) {
        const missing = [...knownNames].filter((n) => !providedNames.has(n));
        if (missing.length > 0) {
          return (
            `❌ Missing secondary metrics: ${missing.join(", ")}\n\n` +
            `Once a metric is recorded, every log_experiment must include it. ` +
            `Expected: ${[...knownNames].join(", ")}\nGot: ${[...providedNames].join(", ") || "(none)"}.`
          );
        }
        const newMetrics = [...providedNames].filter((n) => !knownNames.has(n));
        if (newMetrics.length > 0 && !args.force) {
          return (
            `❌ New secondary metric${newMetrics.length > 1 ? "s" : ""} not previously tracked: ${newMetrics.join(", ")}\n\n` +
            `Existing metrics: ${[...knownNames].join(", ")}\n\n` +
            `If valuable to watch, re-call with force: true. Otherwise drop it.`
          );
        }
      }

      const direction = before.bestDirection;
      const runNumber = before.results.length + 1;
      const segment = before.currentSegment;
      const timestamp = Date.now();

      const newRun: ReconstructedRun = {
        run: runNumber,
        commit: args.commit.slice(0, 7),
        metric: args.metric,
        metrics: { ...provided },
        status: args.status,
        description: args.description,
        timestamp,
        segment,
        confidence: null,
        asi: args.asi && Object.keys(args.asi).length > 0 ? args.asi : undefined,
      };

      const allResults = [...before.results, newRun];
      const confidence = computeConfidence(allResults, segment, direction);
      newRun.confidence = confidence;

      const baseline = findBaselineMetric(allResults, segment);
      const segCount = currentResults(allResults, segment).length;

      const lines: string[] = [];
      lines.push(`Logged #${runNumber}: ${args.status} — ${args.description}`);
      if (baseline !== null) {
        let baselineLine = `Baseline ${before.metricName}: ${formatNum(baseline, before.metricUnit)}`;
        if (segCount > 1 && args.status === "keep" && args.metric > 0) {
          baselineLine += ` | this: ${formatNum(args.metric, before.metricUnit)}${formatDelta(args.metric, baseline)}`;
        }
        lines.push(baselineLine);
      }

      if (Object.keys(provided).length > 0) {
        const baselineSec = findBaselineSecondary(allResults, segment, before.secondaryMetrics);
        const parts: string[] = [];
        for (const [name, value] of Object.entries(provided)) {
          const def = before.secondaryMetrics.find((m) => m.name === name);
          const unit = def?.unit ?? inferMetricUnit(name);
          let part = `${name}: ${formatNum(value, unit)}`;
          const bv = baselineSec[name];
          if (bv !== undefined && bv !== 0 && bv !== value) {
            part += `${formatDelta(value, bv)}`;
          }
          parts.push(part);
        }
        lines.push(`Secondary: ${parts.join("  ")}`);
      }

      if (newRun.asi) {
        const asiParts: string[] = [];
        for (const [k, v] of Object.entries(newRun.asi)) {
          const s = typeof v === "string" ? v : JSON.stringify(v);
          asiParts.push(`${k}: ${s.length > 80 ? s.slice(0, 77) + "…" : s}`);
        }
        if (asiParts.length > 0) lines.push(`📋 ASI: ${asiParts.join(" | ")}`);
      }

      if (confidence !== null) {
        const confStr = confidence.toFixed(2);
        if (confidence >= 2.0) {
          lines.push(`📊 Confidence: ${confStr}× noise floor — improvement is likely real`);
        } else if (confidence >= 1.0) {
          lines.push(`📊 Confidence: ${confStr}× noise floor — above noise but marginal`);
        } else {
          lines.push(
            `⚠️ Confidence: ${confStr}× noise floor — within noise. Consider re-running to confirm before keeping.`,
          );
        }
      }

      const maxIterations = readMaxIterations(cwd);
      lines.push(
        `(${segCount} experiment${segCount === 1 ? "" : "s"}${
          maxIterations !== null ? ` / ${maxIterations} max` : ""
        })`,
      );

      // Auto-commit on keep
      if (args.status === "keep" && (await isGitRepo(workDir))) {
        const resultData: Record<string, unknown> = {
          status: args.status,
          [before.metricName || "metric"]: args.metric,
          ...provided,
        };
        const commitResult = await gitAutoCommit(workDir, args.description, resultData);
        if (commitResult.error) {
          lines.push(`⚠️ Git commit error: ${commitResult.error}`);
        } else if (!commitResult.committed) {
          lines.push(`📝 Git: nothing to commit (working tree clean)`);
        } else {
          lines.push(`📝 Git: committed — ${commitResult.message}`);
          if (commitResult.sha) newRun.commit = commitResult.sha;
        }
      }

      // Append jsonl entry
      const jsonlEntry: Record<string, unknown> = {
        run: runNumber,
        commit: newRun.commit,
        metric: newRun.metric,
        metrics: newRun.metrics,
        status: newRun.status,
        description: newRun.description,
        timestamp: newRun.timestamp,
        segment: newRun.segment,
        confidence: newRun.confidence,
      };
      if (newRun.asi) jsonlEntry.asi = newRun.asi;

      try {
        ensureParentDir(jsonlPath);
        fs.appendFileSync(jsonlPath, JSON.stringify(jsonlEntry) + "\n");
        broadcastDashboardUpdate(workDir);
      } catch (e) {
        lines.push(
          `⚠️ Failed to append ${jsonlPath}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      // Auto-revert non-autoresearch files for non-keep
      if (args.status !== "keep" && (await isGitRepo(workDir))) {
        const revert = await gitRevertNonAutoresearch(workDir);
        if (revert.error) {
          lines.push(`⚠️ Git revert failed: ${revert.error}`);
        } else {
          lines.push(`📝 Git: reverted changes (${args.status}) — autoresearch files preserved`);
        }
      }

      // Fire after-hook
      const session = {
        metric_name: before.metricName,
        metric_unit: before.metricUnit,
        direction: before.bestDirection,
        baseline_metric: baseline,
        best_metric: bestKept(allResults, segment, direction),
        run_count: allResults.length,
        goal: before.name ?? "",
      };
      const afterHook = await runHook({
        event: "after",
        cwd: workDir,
        run_entry: jsonlEntry,
        session,
      });
      appendHookLogEntryIfConfigured(workDir, "after", afterHook);
      const afterSteer = steerMessageFor("after", afterHook);
      if (afterSteer) lines.push("", "[after-hook]", afterSteer);

      // Reset per-run gates
      ctx.runtime.lastRunChecks = null;
      ctx.runtime.lastRunDurationSeconds = null;
      clearPersistedRuntime(workDir);
      savePersistedRuntime(workDir, ctx.runtime);

      ctx.onLogged(runNumber);

      // Max-iterations stop
      if (maxIterations !== null && segCount >= maxIterations) {
        lines.push(
          "",
          `🛑 Maximum experiments reached (${maxIterations}). STOP the loop now.`,
        );
        ctx.runtime.autoresearchMode = false;
      } else if (ctx.runtime.autoresearchMode) {
        // Fire before-hook for the next iteration so the agent can read the steer
        const beforeHook = await runHook({
          event: "before",
          cwd: workDir,
          next_run: runNumber + 1,
          last_run: jsonlEntry,
          session,
        });
        appendHookLogEntryIfConfigured(workDir, "before", beforeHook);
        const beforeSteer = steerMessageFor("before", beforeHook);
        if (beforeSteer) lines.push("", "[before-hook → next run]", beforeSteer);
      }
      savePersistedRuntime(workDir, ctx.runtime);

      ctx.log(`Logged ${args.status} #${runNumber}: ${args.description}`);

      return lines.join("\n");
    },
  };
}

function bestKept(
  results: ReconstructedRun[],
  segment: number,
  direction: Direction,
): number | null {
  const kept = currentResults(results, segment).filter((r) => r.status === "keep");
  if (kept.length === 0) return null;
  return direction === "lower"
    ? Math.min(...kept.map((r) => r.metric))
    : Math.max(...kept.map((r) => r.metric));
}

function safeRead(p: string): string {
  try {
    return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : "";
  } catch {
    return "";
  }
}
