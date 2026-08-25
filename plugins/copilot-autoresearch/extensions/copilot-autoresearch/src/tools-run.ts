import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { Tool } from "@github/copilot-sdk";
import {
  autoresearchChecksPath,
  autoresearchJsonlPath,
  autoresearchScriptPath,
  readMaxIterations,
  resolveWorkDir,
  validateWorkDir,
} from "./paths.ts";
import { runShell, runShellStreaming } from "./spawn.ts";
import { isAutoresearchShCommand, parseMetricLines } from "./metric.ts";
import { reconstructJsonlState } from "./jsonl.ts";
import { findBaselineMetric } from "./confidence.ts";
import { formatNum, formatElapsed } from "./format.ts";
import { savePersistedRuntime, type RuntimeState } from "./state.ts";
import type { CwdRef } from "./extension-context.ts";

const MAX_LINES = 10;
const MAX_BYTES = 4 * 1024;
const STREAM_MAX_BYTES = 32 * 1024;
const STREAM_MAX_LINES = 200;
const DEFAULT_TIMEOUT_S = 600;
const DEFAULT_CHECKS_TIMEOUT_S = 300;

export interface RunArgs {
  command: string;
  timeout_seconds?: number;
  checks_timeout_seconds?: number;
}

export interface RunContext {
  cwdRef: CwdRef;
  runtime: RuntimeState;
  log: (message: string, level?: "info" | "warning" | "error") => void;
  progress?: (message: string) => void;
}

export function createRunTool(ctx: RunContext): Tool<RunArgs> {
  return {
    name: "run_experiment",
    description:
      `Run an autoresearch experiment as a shell command. Times wall-clock duration, captures stdout+stderr, detects pass/fail via exit code, parses 'METRIC name=value' lines automatically. Output is truncated to the last ${MAX_LINES} lines / ${MAX_BYTES / 1024}KB for the model. If .auto/checks.sh exists, it runs after a passing benchmark; the wall-clock time of checks does NOT affect the primary metric. Always follow with log_experiment.`,
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "Shell command (e.g. './.auto/measure.sh', 'pnpm test', 'uv run train.py').",
        },
        timeout_seconds: {
          type: "number",
          description: `Kill the experiment after this many seconds. Default: ${DEFAULT_TIMEOUT_S}.`,
        },
        checks_timeout_seconds: {
          type: "number",
          description: `Kill .auto/checks.sh after this many seconds. Default: ${DEFAULT_CHECKS_TIMEOUT_S}.`,
        },
      },
      required: ["command"],
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
      const state = reconstructJsonlState(safeRead(autoresearchJsonlPath(workDir)));
      const maxIterations = readMaxIterations(cwd);
      const segmentRuns = state.results.filter(
        (run) => run.segment === state.currentSegment,
      ).length;
      if (maxIterations !== null && segmentRuns >= maxIterations) {
        ctx.runtime.autoresearchMode = false;
        savePersistedRuntime(workDir, ctx.runtime);
        return `🛑 Maximum experiments reached (${maxIterations}). Start a new segment with init_experiment before running again.`;
      }

      // Benchmark-script gate — when present, the agent MUST invoke it.
      const scriptPath = autoresearchScriptPath(workDir);
      if (fs.existsSync(scriptPath) && !isAutoresearchShCommand(args.command)) {
        return [
          `❌ ${scriptPath} exists — you must run it instead of a custom command.`,
          ``,
          `Found: ${scriptPath}`,
          `Your command: ${args.command}`,
          ``,
          `Use: run_experiment({ command: "bash ${scriptPath}" })`,
        ].join("\n");
      }

      const timeoutMs = (args.timeout_seconds ?? DEFAULT_TIMEOUT_S) * 1000;
      clearLastOutput(ctx.runtime);

      ctx.log(`Running experiment: ${args.command}`);
      ctx.progress?.(`Autoresearch · running 0s · ${args.command}`);

      let result;
      try {
        result = await runShellStreaming(args.command, {
          cwd: workDir,
          timeoutMs,
          maxBytes: STREAM_MAX_BYTES,
          maxLines: STREAM_MAX_LINES,
          onTick: ctx.progress
            ? (elapsedMs, tail) => {
                const latest = latestOutputLine(tail);
                const suffix = latest ? ` · ${latest}` : "";
                ctx.progress?.(`Autoresearch · running ${formatElapsed(elapsedMs)}${suffix}`);
              }
            : undefined,
        });
      } catch (e) {
        return `💥 Failed to spawn: ${e instanceof Error ? e.message : String(e)}`;
      }

      const durationSeconds = result.durationMs / 1000;
      const benchmarkPassed = result.exitCode === 0 && !result.killed;
      const fullOutputPath = ensureFullOutput(result);
      ctx.runtime.lastOutputPath = fullOutputPath ?? null;

      // Backpressure checks
      let checksPass: boolean | null = null;
      let checksTimedOut = false;
      let checksOutput = "";
      let checksDurationSeconds = 0;
      const checksPath = autoresearchChecksPath(workDir);
      if (benchmarkPassed && fs.existsSync(checksPath)) {
        const checksTimeoutMs = (args.checks_timeout_seconds ?? DEFAULT_CHECKS_TIMEOUT_S) * 1000;
        try {
          const checksResult = await runShell({ script: checksPath }, {
            cwd: workDir,
            timeoutMs: checksTimeoutMs,
          });
          checksDurationSeconds = checksResult.durationMs / 1000;
          checksTimedOut = checksResult.killed;
          checksPass = checksResult.exitCode === 0 && !checksResult.killed;
          checksOutput = checksResult.combined;
        } catch (e) {
          checksPass = false;
          checksOutput = e instanceof Error ? e.message : String(e);
        }
      }

      ctx.runtime.lastRunChecks =
        checksPass === null
          ? null
          : { pass: checksPass, output: checksOutput, durationSeconds: checksDurationSeconds };
      ctx.runtime.lastRunDurationSeconds = durationSeconds;
      savePersistedRuntime(workDir, ctx.runtime);

      // Parse METRIC lines
      const parsed = parseMetricLines(result.stdout);
      const baseline = findBaselineMetric(state.results, state.currentSegment);
      const parsedPrimary = parsed.get(state.metricName) ?? null;
      const secondary = [...parsed.entries()].filter(([k]) => k !== state.metricName);

      let header: string;
      if (result.killed) {
        header = `⏰ TIMEOUT after ${durationSeconds.toFixed(1)}s`;
      } else if (!benchmarkPassed) {
        header = `💥 FAILED (exit ${result.exitCode}) in ${durationSeconds.toFixed(1)}s`;
      } else if (checksTimedOut) {
        header = `✅ Benchmark PASSED in ${durationSeconds.toFixed(1)}s\n⏰ CHECKS TIMEOUT (${checksPath}) after ${checksDurationSeconds.toFixed(1)}s\nLog this as 'checks_failed' — the benchmark metric is valid but checks timed out.`;
      } else if (checksPass === false) {
        header = `✅ Benchmark PASSED in ${durationSeconds.toFixed(1)}s\n💥 CHECKS FAILED (${checksPath}) in ${checksDurationSeconds.toFixed(1)}s\nLog this as 'checks_failed' — the benchmark metric is valid but correctness checks did not pass.`;
      } else if (checksPass === true) {
        header = `✅ PASSED in ${durationSeconds.toFixed(1)}s\n✅ Checks passed in ${checksDurationSeconds.toFixed(1)}s`;
      } else {
        header = `✅ PASSED in ${durationSeconds.toFixed(1)}s`;
      }

      const lines: string[] = [header];

      if (baseline !== null) {
        lines.push(`📊 Current baseline ${state.metricName}: ${formatNum(baseline, state.metricUnit)}`);
      }

      if (parsed.size > 0) {
        lines.push("");
        const summary: string[] = [];
        if (parsedPrimary !== null) {
          summary.push(`★ ${state.metricName}=${formatNum(parsedPrimary, state.metricUnit)}`);
        }
        for (const [name, value] of secondary) {
          const def = state.secondaryMetrics.find((m) => m.name === name);
          summary.push(`${name}=${formatNum(value, def?.unit ?? "")}`);
        }
        lines.push(`📐 Parsed metrics: ${summary.join("  ")}`);
        const secondaryJson = secondary.map(([k, v]) => `"${k}": ${v}`).join(", ");
        lines.push(
          `Use directly in log_experiment → metric: ${parsedPrimary ?? "?"}, metrics: { ${secondaryJson} }`,
        );
      }

      lines.push("", llmTail(result.stdout));

      if (result.totalLines > MAX_LINES || result.totalBytes > MAX_BYTES) {
        lines.push(
          "",
          `[Showing last ${MAX_LINES} lines (of ${result.totalLines}) — output is ${formatBytes(result.totalBytes)}${fullOutputPath ? `; retained${result.fullOutputTruncated ? " first 100 MB" : " in full"} at ${fullOutputPath}` : ""}]`,
        );
      }

      if (checksPass === false) {
        const tail = checksOutput.split("\n").slice(-80).join("\n");
        lines.push("", "── Checks output (last 80 lines) ──", tail);
      }
      ctx.log(`Experiment ${benchmarkPassed ? "passed" : "failed"} in ${formatElapsed(result.durationMs)}`);

      return lines.join("\n");
    },
  };
}

export function clearLastOutput(runtime: RuntimeState): void {
  if (!runtime.lastOutputPath) return;
  try {
    fs.unlinkSync(runtime.lastOutputPath);
  } catch {
    // Temporary output may already have been removed by the OS or user.
  }
  runtime.lastOutputPath = null;
}

function safeRead(p: string): string {
  try {
    return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : "";
  } catch {
    return "";
  }
}

function llmTail(output: string): string {
  const allLines = output.split("\n");
  let tail = allLines.slice(-MAX_LINES).join("\n");
  if (Buffer.byteLength(tail, "utf-8") > MAX_BYTES) {
    tail = tail.slice(tail.length - MAX_BYTES);
    const nl = tail.indexOf("\n");
    if (nl !== -1) tail = tail.slice(nl + 1);
  }
  return tail;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function latestOutputLine(output: string): string {
  const line = output
    .split("\n")
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .at(-1) ?? "";
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

function ensureFullOutput(
  result: Awaited<ReturnType<typeof runShellStreaming>>,
): string | undefined {
  if (result.fullOutputPath) return result.fullOutputPath;
  if (result.totalLines <= MAX_LINES && result.totalBytes <= MAX_BYTES) return undefined;
  try {
    const outputPath = path.join(
      tmpdir(),
      `copilot-autoresearch-${crypto.randomBytes(8).toString("hex")}.log`,
    );
    fs.writeFileSync(outputPath, result.stdout);
    return outputPath;
  } catch {
    return undefined;
  }
}
