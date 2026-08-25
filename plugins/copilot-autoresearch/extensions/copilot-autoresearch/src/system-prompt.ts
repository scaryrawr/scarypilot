import * as fs from "node:fs";
import {
  autoresearchChecksPath,
  autoresearchIdeasPath,
  autoresearchJsonlPath,
  autoresearchMdPath,
  autoresearchScriptPath,
} from "./paths.ts";
import {
  reconstructJsonlState,
  type ReconstructedJsonlState,
  type ReconstructedRun,
} from "./jsonl.ts";
import {
  currentResults,
  findBaselineMetric,
  findBestMetric,
} from "./confidence.ts";
import { formatNum, formatDelta } from "./format.ts";

export const BENCHMARK_GUARDRAIL =
  "Be careful not to overfit to the benchmarks and do not cheat on the benchmarks.";

/**
 * Build the active-mode block injected on every user prompt while autoresearch
 * mode is on. Includes only short pointers — no file contents — so it stays
 * cache-friendly and short.
 */
export function buildAutoresearchAdditionalContext(workDir: string): string {
  const mdPath = autoresearchMdPath(workDir);
  const ideasPath = autoresearchIdeasPath(workDir);
  const checksPath = autoresearchChecksPath(workDir);
  const scriptPath = autoresearchScriptPath(workDir);

  const lines: string[] = [
    "## Autoresearch Mode (ACTIVE)",
    "You are in an autonomous experiment loop. Optimize the primary metric.",
    "Use the `init_experiment`, `run_experiment`, and `log_experiment` tools. Never stop until interrupted.",
    `Experiment rules: \`${mdPath}\` — read this file at the start of every session and after large context changes.`,
    `Append promising but deferred ideas to \`${ideasPath}\` — don't let good ideas get lost.`,
    BENCHMARK_GUARDRAIL,
    "If the user sends a follow-on message while an experiment is running, finish the current run_experiment + log_experiment cycle first, then address their message in the next iteration.",
  ];

  if (fileExists(scriptPath)) {
    lines.push(
      `Benchmark script: \`${scriptPath}\` — invoke it through \`run_experiment\` (custom commands will be rejected while it exists).`,
    );
  }

  if (fileExists(checksPath)) {
    lines.push(
      "",
      "## Backpressure Checks (ACTIVE)",
      `\`${checksPath}\` runs automatically after every passing benchmark.`,
      "If the benchmark passes but checks fail, log the result with status 'checks_failed' (no commit, code reverted).",
      "You cannot use status 'keep' when checks have failed.",
      "Checks execution time does NOT affect the primary metric.",
    );
  }

  if (fileExists(ideasPath)) {
    lines.push(
      "",
      `💡 Ideas backlog: \`${ideasPath}\` — review for promising experiment paths and prune stale entries.`,
    );
  }

  return lines.join("\n");
}

function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/**
 * Build a deterministic rehydration summary. Used both as the auto-resume
 * prompt body and (when requested) as `/autoresearch status`. Replaces what
 * `session_before_compact` did in pi-autoresearch.
 */
export function buildRehydrationSummary(workDir: string): string {
  const mdPath = autoresearchMdPath(workDir);
  const jsonlPath = autoresearchJsonlPath(workDir);
  const ideasPath = autoresearchIdeasPath(workDir);

  const state = readJsonlState(jsonlPath);
  return [
    headerSection(),
    sessionSection(state),
    rulesSection(mdPath),
    ideasSection(ideasPath),
    recentRunsSection(state),
    nextStepSection(),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function readJsonlState(jsonlPath: string): ReconstructedJsonlState {
  return reconstructJsonlState(readFileOrEmpty(jsonlPath));
}

function readFileOrEmpty(p: string): string {
  try {
    return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : "";
  } catch {
    return "";
  }
}

function headerSection(): string {
  return [
    "# Autoresearch Rehydration",
    "",
    "Use this snapshot of persisted autoresearch state to continue the loop without re-reading source files.",
  ].join("\n");
}

function sessionSection(state: ReconstructedJsonlState): string {
  const runs = currentResults(state.results, state.currentSegment);
  const baseline = findBaselineMetric(state.results, state.currentSegment);
  const best = findBestMetric(state.results, state.currentSegment, state.bestDirection);
  const lines: string[] = [
    "## Session",
    "",
    `Goal: ${state.name ?? "—"}`,
    `Metric: ${state.metricName} (${state.bestDirection} is better)`,
    `Runs (current segment): ${runs.length}`,
  ];
  if (baseline !== null) {
    lines.push(`Baseline: ${formatNum(baseline, state.metricUnit)}`);
  }
  if (best !== null && best !== baseline) {
    lines.push(`Best:     ${formatNum(best, state.metricUnit)}${formatDelta(best, baseline)}`);
  }
  return lines.join("\n");
}

function rulesSection(mdPath: string): string {
  const content = readFileOrEmpty(mdPath).trim();
  if (!content) return "";
  return `## Experiment Rules (${mdPath})\n\n${content}`;
}

function ideasSection(ideasPath: string): string {
  const content = readFileOrEmpty(ideasPath).trim();
  if (!content) return "";
  return `## Ideas Backlog (${ideasPath})\n\n${content}`;
}

const RECENT_RUN_LIMIT = 30;

function recentRunsSection(state: ReconstructedJsonlState): string {
  const runs = state.results.slice(-RECENT_RUN_LIMIT);
  if (runs.length === 0) {
    return "## Recent Runs\n\nNo runs yet — start with the first hypothesis.";
  }
  const lines = runs.map((r) => formatRunLine(r, baselineFor(r, state.results)));
  return [
    `## Recent Runs (last ${runs.length})`,
    "",
    "Format: `#run status metric (delta) | desc | hyp | next | rollback`",
    "",
    ...lines,
    "",
    "Read further entries from the persisted session log if needed.",
  ].join("\n");
}

function baselineFor(run: ReconstructedRun, all: ReconstructedRun[]): number | null {
  return all.find((other) => other.segment === run.segment)?.metric ?? null;
}

function formatRunLine(run: ReconstructedRun, baseline: number | null): string {
  const head = `#${run.run} ${padStatus(run.status)} ${run.metric}${formatDelta(run.metric, baseline)}`;
  const parts = [head];
  if (run.description) parts.push(`desc: ${run.description}`);
  if (run.asi) {
    for (const [key, label] of [
      ["hypothesis", "hyp"],
      ["next_action_hint", "next"],
      ["rollback_reason", "rollback"],
    ] as const) {
      const v = run.asi[key];
      if (typeof v === "string" && v.trim()) parts.push(`${label}: ${v.trim()}`);
    }
  }
  return parts.join(" | ");
}

const STATUS_WIDTH = "checks_failed".length;
function padStatus(status: ReconstructedRun["status"]): string {
  return status.padEnd(STATUS_WIDTH);
}

function nextStepSection(): string {
  return [
    "## Next Step",
    "",
    "Pick the most promising hypothesis from the ideas backlog or the most recent `next:` hints.",
    "Call `run_experiment` then `log_experiment`. Keep iterating.",
  ].join("\n");
}
