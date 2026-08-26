import * as fs from "node:fs";
import { joinSession } from "@github/copilot-sdk/extension";
import { createCwdRef } from "./extension-context.ts";
import {
  defaultRuntimeState,
  loadPersistedRuntime,
  restoredMode,
} from "./state.ts";
import {
  autoresearchJsonlPath,
  resolveWorkDir,
} from "./paths.ts";
import { reconstructJsonlState } from "./jsonl.ts";
import { createInitTool } from "./tools-init.ts";
import { clearLastOutput, createRunTool } from "./tools-run.ts";
import { createLogTool } from "./tools-log.ts";
import { createAutoresearchCommand } from "./command.ts";
import { createAutoResumeScheduler } from "./auto-resume.ts";
import { buildAutoresearchAdditionalContext } from "./system-prompt.ts";
import { stopLiveDashboard } from "./dashboard.ts";

/**
 * Per-process state. Copilot CLI forks one extension process per session
 * (extensions are reloaded on `/clear` and on foreground-session replacement,
 * see node_modules/@github/copilot-sdk/docs/extensions.md), so module-level
 * state is per-session by construction.
 */
const cwdRef = createCwdRef(process.cwd());
const runtime = defaultRuntimeState();
let lastLoggedRun = 0;

// Forward references so the slash command (constructed before `joinSession`
// resolves so it can be passed via `commands: [...]`) and the `onSessionEnd`
// hook can reach the session and auto-resume scheduler once those are ready.
let sessionRef: import("@github/copilot-sdk").CopilotSession | null = null;
let autoResumeRef: ReturnType<typeof createAutoResumeScheduler> | null = null;

function refreshFromDisk(sessionId: string): void {
  const cwd = cwdRef.get();
  const workDir = resolveWorkDir(cwd);
  const jsonlPath = autoresearchJsonlPath(workDir);
  const persisted = loadPersistedRuntime(workDir, sessionId);
  if (!fs.existsSync(jsonlPath)) {
    runtime.autoresearchMode = restoredMode(
      persisted?.autoresearchMode,
      false,
      workDir !== cwd,
    );
    runtime.lastRunChecks = persisted?.lastRunChecks ?? null;
    runtime.lastRunDurationSeconds = persisted?.lastRunDurationSeconds ?? null;
    lastLoggedRun = 0;
    return;
  }
  try {
    const state = reconstructJsonlState(fs.readFileSync(jsonlPath, "utf-8"));
    lastLoggedRun = state.results.length;
    runtime.autoresearchMode = restoredMode(
      persisted?.autoresearchMode,
      true,
      workDir !== cwd,
    );
  } catch {
    // ignore
  }
  if (persisted) {
    if (typeof persisted.autoresearchMode === "boolean") {
      runtime.autoresearchMode = persisted.autoresearchMode;
    }
    if (persisted.lastRunChecks !== undefined) {
      runtime.lastRunChecks = persisted.lastRunChecks;
    }
    if (persisted.lastRunDurationSeconds !== undefined) {
      runtime.lastRunDurationSeconds = persisted.lastRunDurationSeconds;
    }
  }
}

const extensionSessionId = process.env.SESSION_ID;
if (extensionSessionId) refreshFromDisk(extensionSessionId);

const autoresearchCommand = createAutoresearchCommand({
  cwdRef,
  runtime,
  getSession: () => {
    if (!sessionRef) throw new Error("autoresearch command invoked before session is ready");
    return sessionRef;
  },
  resetAutoResume: () => autoResumeRef?.reset(),
});

const session = await joinSession({
  hooks: {
    onSessionStart: async (input, invocation) => {
      cwdRef.set(input.workingDirectory);
      refreshFromDisk(invocation.sessionId);
      autoResumeRef?.syncToCurrentRun();
      await session.log(
        `copilot-autoresearch loaded${runtime.autoresearchMode ? " — autoresearch mode ACTIVE" : ""}`,
        { ephemeral: true },
      );
      // First-turn context: only mention active mode when resuming an existing session.
      if (runtime.autoresearchMode && input.source === "resume") {
        const workDir = resolveWorkDir(cwdRef.get());
        return {
          additionalContext: buildAutoresearchAdditionalContext(workDir),
        };
      }
      return undefined;
    },
    onUserPromptSubmitted: async (input, invocation) => {
      cwdRef.set(input.workingDirectory);
      refreshFromDisk(invocation.sessionId);
      autoResumeRef?.syncToCurrentRun();
      if (!runtime.autoresearchMode) return;
      const workDir = resolveWorkDir(cwdRef.get());
      return {
        additionalContext: buildAutoresearchAdditionalContext(workDir),
      };
    },
    onPreToolUse: async (input) => {
      cwdRef.set(input.workingDirectory);
    },
    onPostToolUse: async (input) => {
      cwdRef.set(input.workingDirectory);
    },
    onSessionEnd: async () => {
      autoResumeRef?.cancel();
      clearLastOutput(runtime);
      await stopLiveDashboard();
    },
  },
  tools: [
    createInitTool({ cwdRef, runtime, log: (m) => void session.log(m) }),
    createRunTool({
      cwdRef,
      runtime,
      log: (m, level) => void session.log(m, level ? { level } : undefined),
      progress: (message) => void session.log(message, { ephemeral: true }),
    }),
    createLogTool({
      cwdRef,
      runtime,
      log: (m, level) => void session.log(m, level ? { level } : undefined),
      onLogged: (n) => {
        lastLoggedRun = Math.max(lastLoggedRun, n);
      },
    }),
  ],
  commands: [autoresearchCommand],
});
sessionRef = session;

const autoResume = createAutoResumeScheduler({
  cwdRef,
  runtime,
  session,
  getLastLoggedRun: () => lastLoggedRun,
});
autoResumeRef = autoResume;

session.on("session.idle", () => autoResume.onIdle());
