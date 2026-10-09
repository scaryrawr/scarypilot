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
import { reconstructJsonlState } from "./jsonl.ts";
import { openLiveDashboard, stopLiveDashboard } from "./dashboard.ts";
import {
  clearPersistedRuntime,
  savePersistedRuntime,
  type RuntimeState,
} from "./state.ts";
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
  "Usage: /autoresearch [<text>|off|finalize|clear|export|status|help]",
  "",
  "  /autoresearch <text>  Enter autoresearch mode and start (or resume) the loop.",
  "  /autoresearch off     Leave autoresearch mode (state files preserved).",
  "  /autoresearch finalize Stop the loop and load the autoresearch-finalize skill.",
  "  /autoresearch clear   Delete .auto/log.jsonl and legacy autoresearch.jsonl, then turn the mode off.",
  "  /autoresearch export  Open a local live dashboard in your browser.",
  "  /autoresearch status  Print a rehydration summary built from autoresearch.* files.",
  "  /autoresearch help    Show this help (--help and -h also work).",
  "",
  "Examples:",
  "  /autoresearch optimize unit test runtime, monitor correctness",
  "  /autoresearch model training, run 5 minutes of train.py and note the loss ratio",
].join("\n");

export function createAutoresearchCommand(deps: CommandContextDeps): CommandDefinition {
  return {
    name: "autoresearch",
    description: "Start, stop, finalize, clear, export, or check the autoresearch experiment loop.",
    handler: async (cmdCtx) => {
      const session = deps.getSession();
      const args = (cmdCtx.args ?? "").trim();
      const sub = args.toLowerCase();

      if (!args || ["help", "--help", "-h"].includes(sub)) {
        await session.log(HELP);

        return;
      }

      const cwd = deps.cwdRef.get();
      const workDirError = validateWorkDir(cwd);

      if (workDirError) {
        await session.log(`/autoresearch: ${workDirError}`, { level: "error" });

        return;
      }

      const workDir = resolveWorkDir(cwd);

      const stopLoop = async (): Promise<boolean> => {
        deps.runtime.autoresearchMode = false;
        deps.runtime.lastRunChecks = null;
        deps.runtime.lastRunDurationSeconds = null;
        deps.resetAutoResume();
        await stopLiveDashboard();
        savePersistedRuntime(workDir, cmdCtx.sessionId, deps.runtime);

        return abortActiveTurn(session);
      };

      if (sub === "off") {
        await stopLoop();
        await session.log("Autoresearch mode OFF (state files preserved).");

        return;
      }

      if (sub === "finalize") {
        const jsonlPath = autoresearchJsonlPath(workDir);
        let hasLoggedExperiment: boolean;

        try {
          hasLoggedExperiment =
            fs.existsSync(jsonlPath) &&
            reconstructJsonlState(fs.readFileSync(jsonlPath, "utf-8")).results.length > 0;
        } catch (error) {
          await session.log(
            `Failed to read experiment log ${jsonlPath}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            { level: "error" },
          );

          return;
        }

        if (!hasLoggedExperiment) {
          await session.log(
            "No logged experiments to finalize — use '/autoresearch <goal>' to start a session.",
            { level: "error" },
          );

          return;
        }

        if (!(await stopLoop())) return;
        await session.log("Autoresearch mode OFF — loading autoresearch-finalize skill.");
        await session.send({
          prompt:
            `Invoke the autoresearch-finalize skill in working directory ${JSON.stringify(workDir)} to turn the kept experiments in ${JSON.stringify(jsonlPath)} into reviewable branches.`,
        });

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

      const hasState = fs.existsSync(autoresearchMdPath(workDir));

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
      await session.send({ prompt: kickoff });
    },
  };
}

async function abortActiveTurn(session: AutoresearchSession): Promise<boolean> {
  try {
    await session.abort();

    return true;
  } catch (e) {
    await session.log(
      `Autoresearch mode changed, but the active turn could not be aborted: ${
        e instanceof Error ? e.message : String(e)
      }`,
      { level: "warning" },
    );

    return false;
  }
}
