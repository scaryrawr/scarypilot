import * as fs from "node:fs";
import type { CommandDefinition, CopilotSession } from "@github/copilot-sdk";
import {
  autoresearchJsonlPath,
  autoresearchMdPath,
  resolveWorkDir,
  sessionFileCandidates,
  validateWorkDir,
} from "./paths.ts";
import {
  BENCHMARK_GUARDRAIL,
  buildRehydrationSummary,
} from "./system-prompt.ts";
import { openLiveDashboard, stopLiveDashboard } from "./dashboard.ts";
import {
  clearPersistedRuntime,
  savePersistedRuntime,
  type RuntimeState,
} from "./state.ts";
import {
  appendHookLogEntryIfConfigured,
  runHook,
  steerMessageFor,
} from "./hooks.ts";
import { reconstructJsonlState } from "./jsonl.ts";
import {
  findBaselineMetric,
  findBestMetric,
} from "./confidence.ts";
import type { CwdRef } from "./extension-context.ts";

type AutoresearchSession = Pick<CopilotSession, "abort" | "log" | "send">;

export interface CommandContextDeps {
  cwdRef: CwdRef;
  runtime: RuntimeState;
  /**
   * Lazy accessor for the joined session. The command is constructed before
   * `joinSession` resolves (so it can be passed via `commands: [...]`), so we
   * cannot capture the session value eagerly. Handlers always resolve it at
   * invocation time, after the session is ready.
   */
  getSession: () => AutoresearchSession;
  resetAutoResume: () => void;
}

const HELP = [
  "Usage: /autoresearch [<text>|off|clear|export|status]",
  "",
  "  /autoresearch <text>  Enter autoresearch mode and start (or resume) the loop.",
  "  /autoresearch off     Leave autoresearch mode (state files preserved).",
  "  /autoresearch clear   Delete .auto/log.jsonl and legacy autoresearch.jsonl, then turn the mode off.",
  "  /autoresearch export  Open a local live dashboard in your browser.",
  "  /autoresearch status  Print a rehydration summary built from autoresearch.* files.",
  "",
  "Examples:",
  "  /autoresearch optimize unit test runtime, monitor correctness",
  "  /autoresearch model training, run 5 minutes of train.py and note the loss ratio",
].join("\n");

export function createAutoresearchCommand(deps: CommandContextDeps): CommandDefinition {
  return {
    name: "autoresearch",
    description: "Start, stop, clear, export, or check the autoresearch experiment loop.",
    handler: async (cmdCtx) => {
      const session = deps.getSession();
      const args = (cmdCtx.args ?? "").trim();
      const sub = args.toLowerCase();
      const cwd = deps.cwdRef.get();
      const workDirError = validateWorkDir(cwd);
      if (workDirError) {
        await session.log(`/autoresearch: ${workDirError}`, { level: "error" });
        return;
      }
      const workDir = resolveWorkDir(cwd);

      if (!args) {
        await session.log(HELP);
        return;
      }

      if (sub === "off") {
        deps.runtime.autoresearchMode = false;
        deps.runtime.lastRunChecks = null;
        deps.runtime.lastRunDurationSeconds = null;
        deps.resetAutoResume();
        await stopLiveDashboard();
        savePersistedRuntime(workDir, cmdCtx.sessionId, deps.runtime);
        await abortActiveTurn(session);
        await session.log("Autoresearch mode OFF (state files preserved).");
        return;
      }

      if (sub === "export") {
        const result = await openLiveDashboard(workDir);
        if (result.error) {
          await session.log(`Export failed: ${result.error}`, { level: "error" });
          return;
        }
        await session.log(`Dashboard at ${result.url} (live updates).`);
        return;
      }

      if (sub === "status") {
        const summary = buildRehydrationSummary(workDir);
        await session.log(summary);
        return;
      }

      if (sub === "clear") {
        deps.runtime.autoresearchMode = false;
        deps.runtime.lastRunChecks = null;
        deps.runtime.lastRunDurationSeconds = null;
        deps.resetAutoResume();
        await stopLiveDashboard();
        clearPersistedRuntime(workDir, cmdCtx.sessionId);
        await abortActiveTurn(session);
        const jsonlPaths = sessionFileCandidates(workDir, "log");
        const existing = [...new Set(Object.values(jsonlPaths))].filter((p) => fs.existsSync(p));
        if (existing.length > 0) {
          try {
            for (const jsonlPath of existing) fs.unlinkSync(jsonlPath);
            await session.log(
              `Deleted ${existing.map((p) => p.replace(`${workDir}/`, "")).join(", ")}. Autoresearch mode OFF.`,
            );
          } catch (e) {
            await session.log(
              `Failed to delete session log: ${e instanceof Error ? e.message : String(e)}`,
              { level: "error" },
            );
          }
        } else {
          await session.log("No session log found. Autoresearch mode OFF.");
        }
        return;
      }

      // Anything else = activation prompt
      if (deps.runtime.autoresearchMode) {
        await session.log(
          "Autoresearch already active — use '/autoresearch off' first to start a fresh kickoff.",
        );
        return;
      }

      deps.runtime.autoresearchMode = true;
      deps.resetAutoResume();
      savePersistedRuntime(workDir, cmdCtx.sessionId, deps.runtime);

      const jsonlPath = autoresearchJsonlPath(workDir);
      const hasState = fs.existsSync(autoresearchMdPath(workDir));

      const state = reconstructJsonlState(
        fs.existsSync(jsonlPath) ? fs.readFileSync(jsonlPath, "utf-8") : "",
      );

      let prefix = "";
      const beforeHook = await runHook({
        event: "before",
        cwd: workDir,
        next_run: state.results.length + 1,
        last_run: lastRun(jsonlPath),
        session: {
          metric_name: state.metricName,
          metric_unit: state.metricUnit,
          direction: state.bestDirection,
          baseline_metric: findBaselineMetric(state.results, state.currentSegment),
          best_metric: findBestMetric(state.results, state.currentSegment, state.bestDirection),
          run_count: state.results.length,
          goal: state.name ?? "",
        },
      });
      appendHookLogEntryIfConfigured(workDir, "before", beforeHook);
      const beforeSteer = steerMessageFor("before", beforeHook);
      if (beforeSteer) prefix += `[before-hook]\n${beforeSteer}\n\n`;

      const kickoff = hasState
        ? [
            `Autoresearch mode active — resuming an existing session.`,
            ``,
            buildRehydrationSummary(workDir),
            ``,
            `User intent: ${args}`,
            BENCHMARK_GUARDRAIL,
          ].join("\n")
        : [
            `Start autoresearch: ${args}`,
            ``,
            `If .auto/prompt.md and .auto/measure.sh do not yet exist, invoke the autoresearch-create skill to set them up. Then call init_experiment, run the baseline with run_experiment, and start looping.`,
            BENCHMARK_GUARDRAIL,
          ].join("\n");

      await session.log(
        hasState
          ? "Autoresearch mode ON — rehydration summary sent to agent."
          : "Autoresearch mode ON — kickoff sent.",
      );
      await session.send({ prompt: prefix + kickoff });
    },
  };
}

async function abortActiveTurn(session: AutoresearchSession): Promise<void> {
  try {
    await session.abort();
  } catch (e) {
    await session.log(
      `Autoresearch mode changed, but the active turn could not be aborted: ${
        e instanceof Error ? e.message : String(e)
      }`,
      { level: "warning" },
    );
  }
}

function lastRun(jsonlPath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(jsonlPath)) return null;
    const lines = fs.readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed && typeof parsed === "object" && typeof parsed.run === "number") {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // skip
      }
    }
  } catch {
    // ignore
  }
  return null;
}
