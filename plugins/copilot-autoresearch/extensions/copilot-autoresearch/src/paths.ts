import * as fs from "node:fs";
import * as path from "node:path";

export const AUTO_DIR = ".auto";

export type SessionFileKind =
  | "log"
  | "prompt"
  | "ideas"
  | "checks"
  | "measure"
  | "config"
  | "runtime"
  | "dashboard";
export type HookStage = "before" | "after";

const SESSION_FILE_NAMES: Record<
  SessionFileKind,
  { current: string; legacy: string }
> = {
  log: { current: "log.jsonl", legacy: "autoresearch.jsonl" },
  prompt: { current: "prompt.md", legacy: "autoresearch.md" },
  ideas: { current: "ideas.md", legacy: "autoresearch.ideas.md" },
  checks: { current: "checks.sh", legacy: "autoresearch.checks.sh" },
  measure: { current: "measure.sh", legacy: "autoresearch.sh" },
  config: { current: "config.json", legacy: "autoresearch.config.json" },
  runtime: { current: "runtime.json", legacy: "autoresearch.runtime.json" },
  dashboard: { current: "dashboard.html", legacy: "autoresearch.html" },
};

export interface SessionFileCandidates {
  current: string;
  legacy: string;
}

export function sessionFileCandidates(
  dir: string,
  kind: SessionFileKind,
): SessionFileCandidates {
  return {
    current: path.join(dir, AUTO_DIR, SESSION_FILE_NAMES[kind].current),
    legacy: path.join(dir, SESSION_FILE_NAMES[kind].legacy),
  };
}

function currentLayoutExists(dir: string): boolean {
  for (const kind of [
    "log",
    "prompt",
    "ideas",
    "checks",
    "measure",
    "config",
  ] as const) {
    if (fs.existsSync(sessionFileCandidates(dir, kind).current)) return true;
  }
  return fs.existsSync(path.join(dir, AUTO_DIR, "hooks"));
}

/**
 * New sessions write `.auto/*`. Existing flat sessions continue using their
 * legacy files until any `.auto/` directory exists, at which point the current
 * layout wins consistently and stale flat peers are ignored.
 */
export function sessionFilePath(dir: string, kind: SessionFileKind): string {
  const candidates = sessionFileCandidates(dir, kind);
  if (currentLayoutExists(dir)) return candidates.current;
  return fs.existsSync(candidates.legacy) ? candidates.legacy : candidates.current;
}

export function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export const autoresearchJsonlPath = (dir: string) => sessionFilePath(dir, "log");
export const autoresearchMdPath = (dir: string) => sessionFilePath(dir, "prompt");
export const autoresearchIdeasPath = (dir: string) => sessionFilePath(dir, "ideas");
export const autoresearchChecksPath = (dir: string) => sessionFilePath(dir, "checks");
export const autoresearchScriptPath = (dir: string) => sessionFilePath(dir, "measure");
export const autoresearchConfigPath = (dir: string) => sessionFilePath(dir, "config");
export const autoresearchRuntimePath = (dir: string) => sessionFilePath(dir, "runtime");
export const autoresearchHtmlPath = (dir: string) => sessionFilePath(dir, "dashboard");

export function autoresearchHookPath(dir: string, stage: HookStage): string {
  const current = path.join(dir, AUTO_DIR, "hooks", `${stage}.sh`);
  const legacy = path.join(dir, "autoresearch.hooks", `${stage}.sh`);
  if (currentLayoutExists(dir)) return current;
  return fs.existsSync(legacy) ? legacy : current;
}

export interface AutoresearchConfig {
  workingDir?: string;
  maxIterations?: number;
}

export function readConfig(cwd: string): AutoresearchConfig {
  try {
    const configPath = autoresearchConfigPath(cwd);
    if (!fs.existsSync(configPath)) return {};
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as AutoresearchConfig) : {};
  } catch {
    return {};
  }
}

export function readMaxIterations(cwd: string): number | null {
  const config = readConfig(cwd);
  return typeof config.maxIterations === "number" && config.maxIterations > 0
    ? Math.floor(config.maxIterations)
    : null;
}

/**
 * The config remains rooted in the session cwd. All other session files,
 * commands, and git operations use the configured working directory.
 */
export function resolveWorkDir(cwd: string): string {
  const config = readConfig(cwd);
  if (!config.workingDir) return cwd;
  return path.isAbsolute(config.workingDir)
    ? config.workingDir
    : path.resolve(cwd, config.workingDir);
}

export function validateWorkDir(cwd: string): string | null {
  const workDir = resolveWorkDir(cwd);
  if (workDir === cwd) return null;
  try {
    const stat = fs.statSync(workDir);
    if (!stat.isDirectory()) {
      return `workingDir "${workDir}" (from .auto/config.json) is not a directory.`;
    }
  } catch {
    return `workingDir "${workDir}" (from .auto/config.json) does not exist.`;
  }
  return null;
}
