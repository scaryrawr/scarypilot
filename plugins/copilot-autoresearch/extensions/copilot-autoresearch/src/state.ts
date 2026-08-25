import * as fs from "node:fs";
import { runShell } from "./spawn.ts";
import {
  autoresearchRuntimePath,
  autoresearchChecksPath,
  autoresearchScriptPath,
  autoresearchMdPath,
  autoresearchJsonlPath,
  autoresearchIdeasPath,
  autoresearchHookPath,
  ensureParentDir,
  sessionFileCandidates,
} from "./paths.ts";

/** State shared between init/run/log within a session, persisted as a sidecar. */
export interface RuntimeState {
  /** True when the user has activated autoresearch or a session log implies it. */
  autoresearchMode: boolean;
  /** Last `run_experiment` checks result (null = no checks ran). */
  lastRunChecks: { pass: boolean; output: string; durationSeconds: number } | null;
  /** Last `run_experiment` wall-clock duration, used for log_experiment context. */
  lastRunDurationSeconds: number | null;
  /** Run number after which auto-resume last sent. Used to gate further resumes. */
  lastResumeAtRunNumber: number;
  /** Number of auto-resume turns already used this session (cap defends against runaways). */
  autoResumeTurns: number;
  /** Temporary overflow output retained for the current run. */
  lastOutputPath: string | null;
}

export function defaultRuntimeState(): RuntimeState {
  return {
    autoresearchMode: false,
    lastRunChecks: null,
    lastRunDurationSeconds: null,
    lastResumeAtRunNumber: 0,
    autoResumeTurns: 0,
    lastOutputPath: null,
  };
}

export function restoredMode(
  persistedMode: boolean | undefined,
  hasSessionLog: boolean,
  usesRedirectedWorkDir: boolean,
): boolean {
  if (persistedMode !== undefined) return persistedMode;
  return hasSessionLog && !usesRedirectedWorkDir;
}

interface PersistedRuntime {
  autoresearchMode?: boolean;
  lastRunChecks?: RuntimeState["lastRunChecks"];
  lastRunDurationSeconds?: number | null;
}

/**
 * Persist a small subset of runtime state to disk so that `log_experiment`'s
 * "checks must pass before keep" gate survives a process restart between the
 * `run_experiment` and `log_experiment` calls. Auto-resume counters stay in
 * memory because they are session-scoped, not iteration-scoped.
 */
export function loadPersistedRuntime(
  workDir: string,
  sessionId: string,
): PersistedRuntime | null {
  try {
    const p = autoresearchRuntimePath(workDir, sessionId);
    if (!fs.existsSync(p)) return null;
    const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as PersistedRuntime;
  } catch {
    return null;
  }
}

export function savePersistedRuntime(
  workDir: string,
  sessionId: string,
  runtime: RuntimeState,
): void {
  try {
    const runtimePath = autoresearchRuntimePath(workDir, sessionId);
    ensureParentDir(runtimePath);
    const data: PersistedRuntime = {
      autoresearchMode: runtime.autoresearchMode,
      lastRunChecks: runtime.lastRunChecks,
      lastRunDurationSeconds: runtime.lastRunDurationSeconds,
    };
    fs.writeFileSync(runtimePath, JSON.stringify(data));
  } catch {
    // best-effort; never throw from persistence
  }
}

export function clearPersistedRuntime(workDir: string, sessionId: string): void {
  const legacyPaths = Object.values(sessionFileCandidates(workDir, "runtime"));
  for (const runtimePath of [
    autoresearchRuntimePath(workDir, sessionId),
    ...legacyPaths,
  ]) {
    try {
      if (fs.existsSync(runtimePath)) fs.unlinkSync(runtimePath);
    } catch {
      // best-effort; stale runtime state must not block the active session
    }
  }
}

/** Detect a clean repo so log_experiment knows whether commits are possible. */
export async function isGitRepo(workDir: string): Promise<boolean> {
  try {
    const result = await runShell("git rev-parse --is-inside-work-tree", {
      cwd: workDir,
      timeoutMs: 5_000,
    });
    return result.exitCode === 0 && result.stdout.trim() === "true";
  } catch {
    return false;
  }
}

export function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

export function workDirArtifacts(workDir: string, sessionId: string) {
  return {
    runtimePath: autoresearchRuntimePath(workDir, sessionId),
    checksPath: autoresearchChecksPath(workDir),
    scriptPath: autoresearchScriptPath(workDir),
    mdPath: autoresearchMdPath(workDir),
    jsonlPath: autoresearchJsonlPath(workDir),
    ideasPath: autoresearchIdeasPath(workDir),
    beforeHookPath: autoresearchHookPath(workDir, "before"),
    afterHookPath: autoresearchHookPath(workDir, "after"),
  };
}
