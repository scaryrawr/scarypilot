import * as fs from "node:fs";
import type { CopilotSession } from "@github/copilot-sdk";
import type { CwdRef } from "./extension-context.ts";
import type { RuntimeState } from "./state.ts";
import { autoresearchJsonlPath, resolveWorkDir } from "./paths.ts";
import { buildRehydrationSummary, BENCHMARK_GUARDRAIL } from "./system-prompt.ts";
import { reconstructJsonlState, type ReconstructedRun } from "./jsonl.ts";

const SETTLE_WINDOW_MS = 800;
export const MAX_AUTO_RESUME_TURNS = 200;
export const CONSECUTIVE_FAILURE_LIMIT = 20;

export function countConsecutiveFailures(
  results: ReconstructedRun[],
  segment: number,
): number {
  let count = 0;
  for (let i = results.length - 1; i >= 0; i--) {
    const result = results[i];
    if (result.segment !== segment) break;
    if (result.status !== "discard" && result.status !== "crash") break;
    count += 1;
  }
  return count;
}

export interface AutoResumeDeps {
  cwdRef: CwdRef;
  runtime: RuntimeState;
  session: CopilotSession;
  /** Returns the highest run number ever logged in this session. */
  getLastLoggedRun: () => number;
}

/**
 * Schedule auto-resumes when the agent goes idle in autoresearch mode.
 *
 * To prevent infinite loops, an auto-resume only fires when:
 *  - autoresearch mode is active,
 *  - a `log_experiment` happened with a run number greater than the one we
 *    auto-resumed against last time,
 *  - the per-session cap (200 turns) has not been reached,
 *  - no more than 20 consecutive discards/crashes have accumulated.
 *
 * The settle window coalesces multiple `session.idle` events that fire in
 * quick succession (e.g. immediately after a tool call result arrives).
 */
export function createAutoResumeScheduler(deps: AutoResumeDeps) {
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let firing = false;

  const cancel = () => {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  };

  const reset = () => {
    cancel();
    deps.runtime.lastResumeAtRunNumber = deps.getLastLoggedRun();
    deps.runtime.autoResumeTurns = 0;
  };

  const fireIfReady = async () => {
    pendingTimer = null;
    if (firing) return;
    if (!deps.runtime.autoresearchMode) return;
    const last = deps.getLastLoggedRun();
    if (last <= deps.runtime.lastResumeAtRunNumber) return;
    if (deps.runtime.autoResumeTurns >= MAX_AUTO_RESUME_TURNS) {
      await deps.session.log(
        `Autoresearch auto-resume cap reached (${MAX_AUTO_RESUME_TURNS} turns). Send /autoresearch <next step> to continue.`,
        { level: "warning" },
      );
      return;
    }
    const workDir = resolveWorkDir(deps.cwdRef.get());
    const jsonlPath = autoresearchJsonlPath(workDir);
    const state = reconstructJsonlState(
      fs.existsSync(jsonlPath) ? fs.readFileSync(jsonlPath, "utf-8") : "",
    );
    const failures = countConsecutiveFailures(state.results, state.currentSegment);
    if (failures > CONSECUTIVE_FAILURE_LIMIT) {
      await deps.session.log(
        `Autoresearch auto-resume stopped — ${failures} consecutive discards/crashes.`,
        { level: "warning" },
      );
      return;
    }

    // Claim the run number atomically before awaiting anything so that a
    // concurrent settle-window timer fired between now and `session.send`
    // returning will see the gate already closed.
    deps.runtime.lastResumeAtRunNumber = last;
    deps.runtime.autoResumeTurns += 1;
    firing = true;

    try {
      const summary = buildRehydrationSummary(workDir);
      const prompt = [
        "Run the next iteration of the autoresearch loop now.",
        "Use the rehydration summary below as your source of truth — re-read .auto/prompt.md, the tail of .auto/log.jsonl, and .auto/ideas.md as needed before deciding the next experiment.",
        BENCHMARK_GUARDRAIL,
        "",
        summary,
      ].join("\n");
      await deps.session.send({ prompt });
    } catch (e) {
      await deps.session.log(
        `Auto-resume send failed: ${e instanceof Error ? e.message : String(e)}`,
        { level: "warning" },
      );
    } finally {
      firing = false;
    }
  };

  const onIdle = () => {
    if (!deps.runtime.autoresearchMode) return;
    if (firing) return;
    cancel();
    pendingTimer = setTimeout(() => {
      void fireIfReady();
    }, SETTLE_WINDOW_MS);
  };

  return { onIdle, cancel, reset };
}
