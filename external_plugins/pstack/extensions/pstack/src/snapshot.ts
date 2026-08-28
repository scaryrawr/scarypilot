import { sha256, stableJson } from "./io.ts";
import type {
  HandoffSummary,
  NowItem,
  OrchProjection,
  PstackCapabilities,
  PstackSnapshot,
  SourceDigest,
  SourceWarning,
  WatchProjection,
  WorktreeProjection,
} from "./types.ts";

export interface SnapshotInput {
  readonly capabilities: PstackCapabilities;
  readonly sources: readonly SourceDigest[];
  readonly orch: OrchProjection | null;
  readonly watch: readonly WatchProjection[];
  readonly worktrees: WorktreeProjection | null;
  readonly handoff: HandoffSummary | null;
  readonly sourceWarnings: readonly SourceWarning[];
}

function deriveNow(input: SnapshotInput): NowItem[] {
  const now: NowItem[] = [];
  for (const gate of input.orch?.openGates ?? []) {
    now.push({
      kind: "open-gate",
      id: gate.id,
      question: gate.question,
      defaultAnswer: gate.defaultAnswer,
    });
  }
  const verified = new Set(
    (input.orch?.ledger ?? [])
      .filter(
        (entry) =>
          entry.verdict === "live-ui-verified" ||
          entry.verdict === "unit-test-verified",
      )
      .map((entry) => `${entry.pr}:${entry.sha}`),
  );
  for (const unit of input.orch?.units ?? []) {
    const pr = Number(unit.pr);
    if (Number.isInteger(pr) && pr > 0 && unit.sha && !verified.has(`${unit.pr}:${unit.sha}`)) {
      now.push({ kind: "verify-head", unitId: unit.id, pr, sha: unit.sha });
    }
  }
  if (input.handoff) now.push({ kind: "resume-handoff", path: input.handoff.path });
  for (const worktree of input.worktrees?.worktrees ?? []) {
    if (worktree.primary) continue;
    if (worktree.disposition !== "candidate" || worktree.activeSessionUse === "unknown") {
      now.push({
        kind: "worktree-risk",
        path: worktree.path,
        disposition: worktree.disposition,
        reason: worktree.reasons.join("; "),
      });
    }
  }
  return now.sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
}

export function buildSnapshot(input: SnapshotInput): PstackSnapshot {
  const normalized = {
    ...input,
    sources: [...input.sources].sort((left, right) => left.path.localeCompare(right.path)),
    watch: [...input.watch].sort((left, right) => left.path.localeCompare(right.path)),
    sourceWarnings: [...input.sourceWarnings].sort((left, right) =>
      `${left.source}:${left.path ?? ""}:${left.message}`.localeCompare(
        `${right.source}:${right.path ?? ""}:${right.message}`,
      ),
    ),
  };
  const now = deriveNow(normalized);
  const withoutHash = { schemaVersion: 1 as const, ...normalized, now };
  return {
    ...withoutHash,
    snapshotHash: sha256(stableJson(withoutHash)),
  };
}
