import * as fs from "node:fs";
import {
  autoresearchJsonlPath,
  ensureParentDir,
  readMaxIterations,
  resolveWorkDir,
  validateWorkDir,
} from "./paths.ts";
import {
  reconstructJsonlState,
  appendJsonlEntry,
  type JsonlEntry,
  type ReconstructedRun,
} from "./jsonl.ts";
import {
  computeConfidence,
  currentResults,
  findBaselineMetric,
  findBaselineSecondary,
} from "./confidence.ts";
import { formatDelta, formatNum } from "./format.ts";
import { gitAutoCommit, gitRevertNonAutoresearch } from "./git.ts";
import { isGitRepo } from "./state.ts";
import { inferMetricUnit } from "./jsonl.ts";
import { ExperimentError, type LogArgs, type OperationContext } from "./operations.ts";

export async function logExperiment(ctx: OperationContext, args: LogArgs): Promise<string> {
      if (!ctx.runtime.autoresearchMode) {
        throw new ExperimentError("❌ Autoresearch mode is off. Start it with `/autoresearch <goal>`.");
      }

      const cwd = ctx.cwdRef.get();
      const workDirError = validateWorkDir(cwd);

      if (workDirError) throw new ExperimentError(`❌ ${workDirError}`);
      const workDir = resolveWorkDir(cwd);

      // Gate: prevent 'keep' when checks failed in the most recent run_experiment
      if (
        args.status === "keep" &&
        ctx.runtime.lastRunChecks &&
        !ctx.runtime.lastRunChecks.pass
      ) {
        const tail = ctx.runtime.lastRunChecks.output.slice(-500);

        throw new ExperimentError([
          "❌ Cannot keep — .auto/checks.sh failed on the previous run_experiment.",
          "",
          tail,
          "",
          "Log as 'checks_failed' instead. The benchmark metric is valid but correctness checks did not pass.",
        ].join("\n"));
      }

      const jsonlPath = autoresearchJsonlPath(workDir);
      const before = reconstructJsonlState(fs.existsSync(jsonlPath) ? fs.readFileSync(jsonlPath, "utf-8") : "");

      // Validate secondary metrics consistency
      const provided = args.metrics ?? {};
      const knownNames = new Set(before.secondaryMetrics.map((m) => m.name));
      const providedNames = new Set(Object.keys(provided));

      if (knownNames.size > 0) {
        const missing = [...knownNames].filter((n) => !providedNames.has(n));

        if (missing.length > 0) {
          throw new ExperimentError(
            `❌ Missing secondary metrics: ${missing.join(", ")}\n\n` +
            `Once a metric is recorded, every log_experiment must include it. ` +
            `Expected: ${[...knownNames].join(", ")}\nGot: ${[...providedNames].join(", ") || "(none)"}.`
          );
        }

        const newMetrics = [...providedNames].filter((n) => !knownNames.has(n));

        if (newMetrics.length > 0 && !args.force) {
          throw new ExperimentError(
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
      const revisitsRun = args.asi?.revisits_run;

      if (
        revisitsRun !== undefined &&
        (typeof revisitsRun !== "number" ||
          !Number.isInteger(revisitsRun) ||
          revisitsRun <= 0 ||
          revisitsRun >= runNumber ||
          !before.results.some((run) => run.run === revisitsRun))
      ) {
        throw new ExperimentError(`❌ asi.revisits_run must be a positive integer referencing an earlier run; the current run is #${runNumber}.`);
      }

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

      if (typeof revisitsRun === "number") {
        lines.push(`↻ Revisiting #${revisitsRun}`);
      }

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
      ctx.onLogStarting?.(runNumber);

      if (ctx.git === "automatic" && args.status === "keep" && (await isGitRepo(workDir))) {
        const resultData: JsonlEntry = {
          status: args.status,
          [before.metricName || "metric"]: args.metric,
          ...provided,
        };

        const commitResult = await gitAutoCommit(workDir, args.description, resultData);

        if (commitResult.error) {
          ctx.onGitFailure?.(`Git commit error: ${commitResult.error}`);
          lines.push(`⚠️ Git commit error: ${commitResult.error}`);
        } else if (!commitResult.committed) {
          lines.push(`📝 Git: nothing to commit (working tree clean)`);
        } else {
          if (!commitResult.sha) ctx.onGitFailure?.("Git created a commit but could not confirm its SHA. Inspect Git state before recovery.");
          lines.push(`📝 Git: committed — ${commitResult.message}`);

          if (commitResult.sha) newRun.commit = commitResult.sha;
        }
      }

      if (ctx.git === "manual") lines.push("Manual Git policy. No files committed or reverted; the caller owns rollback and commit provenance.");

      // Append jsonl entry
      const jsonlEntry: JsonlEntry = {
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
        appendJsonlEntry(jsonlPath, jsonlEntry);
        ctx.changed?.(workDir);
      } catch (e) {
        throw new ExperimentError(
          `⚠️ Failed to append ${jsonlPath}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      // Auto-revert non-autoresearch files for non-keep
      if (ctx.git === "automatic" && args.status !== "keep" && (await isGitRepo(workDir))) {
        const revert = await gitRevertNonAutoresearch(workDir);

        if (revert.error) {
          ctx.onGitFailure?.(`Result #${runNumber} was appended, but Git revert failed: ${revert.error}. Inspect the journal and Git state before recovery.`);
          lines.push(`⚠️ Git revert failed: ${revert.error}`);
        } else {
          lines.push(`📝 Git: reverted changes (${args.status}) — autoresearch files preserved`);
        }
      }

      // Reset per-run gates
      ctx.runtime.lastRunChecks = null;
      ctx.runtime.lastRunDurationSeconds = null;
      ctx.persist();

      ctx.onLogged?.(runNumber);

      // Max-iterations stop
      if (maxIterations !== null && segCount >= maxIterations) {
        lines.push(
          "",
          `🛑 Maximum experiments reached (${maxIterations}). STOP the loop now.`,
        );
        ctx.runtime.autoresearchMode = false;
      } else if (ctx.runtime.autoresearchMode) {
        lines.push(
          "",
          "Before choosing the next experiment, consider whether this result invalidates a previous discard's rollback reason. If so, name what changed and weigh a targeted retry (set asi.revisits_run) against other candidates. Otherwise, move on — don't revive a discarded idea without a changed assumption. Verification reruns to resolve measurement noise are separate.",
        );
      }

      ctx.persist();

      ctx.log(`Logged ${args.status} #${runNumber}: ${args.description}`);

      return lines.join("\n");
}
