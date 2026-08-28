import type { ProcessPort } from "./io.ts";
import { processPort } from "./io.ts";
import type { WorktreeInfo, WorktreeProjection } from "./types.ts";

interface RawWorktree {
  path: string;
  head: string;
  branch: string | null;
}

function parseWorktreeList(raw: string): RawWorktree[] {
  return raw
    .trim()
    .split(/\r?\n\r?\n/)
    .filter(Boolean)
    .map((block) => {
      const values = new Map(
        block.split(/\r?\n/).map((line) => {
          const [key = "", ...rest] = line.split(" ");
          return [key, rest.join(" ")] as const;
        }),
      );
      const branch = values.get("branch");
      return {
        path: values.get("worktree") ?? "",
        head: values.get("HEAD") ?? "",
        branch: branch?.replace(/^refs\/heads\//, "") ?? null,
      };
    })
    .filter((entry) => entry.path !== "");
}

function parseStatus(raw: string): { tracked: number; untracked: number } {
  const lines = raw.split(/\r?\n/).filter(Boolean);
  return {
    tracked: lines.filter((line) => !line.startsWith("??")).length,
    untracked: lines.filter((line) => line.startsWith("??")).length,
  };
}

async function defaultBaseRef(repo: string, port: ProcessPort): Promise<string | null> {
  try {
    const result = await port.run(
      "git",
      ["-C", repo, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    );
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

async function pullRequests(repo: string, port: ProcessPort): Promise<Map<string, { number: number; state: string }>> {
  try {
    const result = await port.run(
      "gh",
      ["pr", "list", "--state", "all", "--limit", "1000", "--json", "number,state,headRefName"],
      { cwd: repo },
    );
    const rows = JSON.parse(result.stdout) as {
      number: number;
      state: string;
      headRefName: string;
    }[];
    return new Map(rows.map((row) => [row.headRefName, { number: row.number, state: row.state }]));
  } catch {
    return new Map();
  }
}

async function inspectOne(
  raw: RawWorktree,
  primaryPath: string,
  baseRef: string | null,
  prs: ReadonlyMap<string, { number: number; state: string }>,
  port: ProcessPort,
): Promise<WorktreeInfo> {
  const status = parseStatus((await port.run("git", ["-C", raw.path, "status", "--porcelain"])).stdout);
  let remote: WorktreeInfo["remote"] = raw.branch ? "no-remote" : "detached";
  let aheadBy: number | null = null;
  if (raw.branch) {
    try {
      const upstream = (
        await port.run("git", ["-C", raw.path, "rev-parse", "--abbrev-ref", `${raw.branch}@{upstream}`])
      ).stdout.trim();
      const counts = (
        await port.run("git", ["-C", raw.path, "rev-list", "--left-right", "--count", `${upstream}...HEAD`])
      ).stdout.trim().split(/\s+/).map(Number);
      const behind = counts[0] ?? 0;
      const ahead = counts[1] ?? 0;
      aheadBy = ahead;
      remote = behind > 0 && ahead > 0 ? "diverged" : ahead > 0 ? "ahead" : "pushed";
    } catch {
      remote = "no-remote";
    }
  }
  let mergedIntoBase: boolean | null = null;
  if (baseRef) {
    try {
      await port.run("git", ["-C", raw.path, "merge-base", "--is-ancestor", raw.head, baseRef]);
      mergedIntoBase = true;
    } catch {
      mergedIntoBase = false;
    }
  }
  const pullRequest = raw.branch ? prs.get(raw.branch) ?? null : null;
  const reasons: string[] = [];
  let disposition: WorktreeInfo["disposition"] = "review";
  if (status.tracked > 0) {
    disposition = "hold-wip";
    reasons.push(`${status.tracked} tracked change(s)`);
  } else if (pullRequest?.state === "OPEN") {
    disposition = "hold-open-pr";
    reasons.push(`PR #${pullRequest.number} is open`);
  } else if (mergedIntoBase === true || pullRequest?.state === "MERGED") {
    disposition = "candidate";
    reasons.push(mergedIntoBase ? `HEAD is contained in ${baseRef}` : `PR #${pullRequest?.number} is merged`);
  } else {
    reasons.push(baseRef ? `HEAD is not contained in ${baseRef}` : "base ref is unknown");
  }
  reasons.push("active Copilot session use is unknown");
  return {
    path: raw.path,
    branch: raw.branch,
    head: raw.head,
    primary: raw.path === primaryPath,
    trackedChanges: status.tracked,
    untrackedChanges: status.untracked,
    remote,
    aheadBy,
    mergedIntoBase,
    pullRequest,
    activeSessionUse: "unknown",
    disposition,
    deletionAllowed: false,
    reasons,
  };
}

export async function inspectWorktrees(
  repository: string,
  requestedBaseRef?: string,
  port: ProcessPort = processPort,
): Promise<WorktreeProjection> {
  const repo = (
    await port.run("git", ["-C", repository, "rev-parse", "--show-toplevel"])
  ).stdout.trim();
  const worktrees = parseWorktreeList(
    (await port.run("git", ["-C", repo, "worktree", "list", "--porcelain"])).stdout,
  );
  const baseRef = requestedBaseRef ?? (await defaultBaseRef(repo, port));
  const prs = await pullRequests(repo, port);
  const primaryPath = worktrees[0]?.path ?? repo;
  const inspected = await Promise.all(
    worktrees.map((worktree) => inspectOne(worktree, primaryPath, baseRef, prs, port)),
  );
  return {
    repository: repo,
    baseRef,
    worktrees: inspected.sort((left, right) => left.path.localeCompare(right.path)),
  };
}
