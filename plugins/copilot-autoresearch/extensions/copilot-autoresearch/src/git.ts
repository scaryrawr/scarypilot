import { runShell } from "./spawn.ts";

export interface CommitResult {
  committed: boolean;
  /** New short SHA if a commit was made, otherwise null (clean tree or failure). */
  sha: string | null;
  /** First line of git output for display. */
  message: string;
  error: string | null;
}

/**
 * Stage all changes and commit with `<description>\n\nResult: <json>`.
 * If the working tree is clean, returns `committed: false` without error.
 */
export async function gitAutoCommit(
  workDir: string,
  description: string,
  resultData: Record<string, unknown>,
): Promise<CommitResult> {
  try {
    const add = await runShell("git add -A", { cwd: workDir, timeoutMs: 10_000 });
    if (add.exitCode !== 0) {
      return {
        committed: false,
        sha: null,
        message: "",
        error: `git add failed (exit ${add.exitCode}): ${add.combined.slice(0, 200)}`,
      };
    }

    const diff = await runShell("git diff --cached --quiet", {
      cwd: workDir,
      timeoutMs: 5_000,
    });
    if (diff.exitCode === 0) {
      return { committed: false, sha: null, message: "nothing to commit", error: null };
    }

    const commitMsg = `${description}\n\nResult: ${JSON.stringify(resultData)}`;
    const commit = await runShell(`git commit -m ${shellQuote(commitMsg)}`, {
      cwd: workDir,
      timeoutMs: 10_000,
    });
    if (commit.exitCode !== 0) {
      return {
        committed: false,
        sha: null,
        message: "",
        error: `git commit failed (exit ${commit.exitCode}): ${commit.combined.slice(0, 200)}`,
      };
    }

    const firstLine = commit.combined.split("\n")[0] ?? "";
    let sha: string | null = null;
    try {
      const rev = await runShell("git rev-parse --short=7 HEAD", {
        cwd: workDir,
        timeoutMs: 5_000,
      });
      const out = rev.stdout.trim();
      if (rev.exitCode === 0 && out.length >= 7) sha = out;
    } catch {
      // keep sha null
    }
    return { committed: true, sha, message: firstLine, error: null };
  } catch (e) {
    return {
      committed: false,
      sha: null,
      message: "",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Revert experiment changes while preserving the current `.auto/` session
 * directory and legacy flat autoresearch files.
 */
export async function gitRevertNonAutoresearch(workDir: string): Promise<{ ok: boolean; error: string | null }> {
  try {
    const script = `
      set -e
      git checkout -- . ':(exclude,glob)**/.auto' ':(exclude,glob)**/.auto/**' ':(exclude,glob)**/autoresearch.*' ':(exclude,glob)**/autoresearch.*/**'
      git clean -fd -e '.auto' -e '**/.auto/**' -e 'autoresearch.*' -e '**/autoresearch.*/**' >/dev/null 2>&1 || true
    `;
    const result = await runShell(script, { cwd: workDir, timeoutMs: 10_000 });
    if (result.exitCode !== 0) {
      return { ok: false, error: `git revert failed (exit ${result.exitCode}): ${result.combined.slice(0, 200)}` };
    }
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** POSIX-shell single-quote a string. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
