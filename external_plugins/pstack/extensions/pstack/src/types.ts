export type CapabilityState =
  | { readonly kind: "available"; readonly detail?: string }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "unknown"; readonly reason: string };

export interface PstackCapabilities {
  readonly git: CapabilityState;
  readonly githubCli: CapabilityState;
  readonly graphite: CapabilityState;
  readonly bunLegacyScripts: CapabilityState;
  readonly taskAgents: CapabilityState;
  readonly sessionHistory: CapabilityState;
  readonly browserAutomation: CapabilityState;
  readonly mcp: CapabilityState;
  readonly sidebarSessions: CapabilityState;
}

export interface UnitSummary {
  readonly id: string;
  readonly track: string;
  readonly state: string;
  readonly branch: string;
  readonly pr: string;
  readonly sha: string;
  readonly brief: string;
}

export type VerificationVerdict =
  | "live-ui-verified"
  | "unit-test-verified"
  | "type-check-only"
  | "verifier-blocked"
  | "verifier-failed";

export interface LedgerSummary {
  readonly pr: string;
  readonly sha: string;
  readonly verdict: VerificationVerdict;
  readonly evidence: string;
  readonly verifier: string;
  readonly timestamp: string;
}

export interface GateSummary {
  readonly id: string;
  readonly question: string;
  readonly options: string;
  readonly defaultAnswer: string;
}

export interface FrontierSummary {
  readonly generation: number;
  readonly prs: readonly {
    readonly pr: number;
    readonly branches: string;
    readonly sha: string;
    readonly state: "OPEN" | "MERGED" | "CLOSED";
  }[];
  readonly lowestUnmerged: number | null;
}

export interface OrchProjection {
  readonly storeDir: string;
  readonly units: readonly UnitSummary[];
  readonly ledger: readonly LedgerSummary[];
  readonly openGates: readonly GateSummary[];
  readonly frontier: FrontierSummary | null;
  readonly unitCounts: Readonly<Record<string, number>>;
  readonly ledgerCounts: Readonly<Record<string, number>>;
}

export interface WatchProjection {
  readonly path: string;
  readonly digest: string;
  readonly latest: {
    readonly sequence: number;
    readonly observedAt: string;
    readonly mode: string;
    readonly kind: string;
    readonly terminal: boolean;
    readonly exitCode?: number;
  } | null;
}

export type WorktreeDisposition =
  | "hold-wip"
  | "hold-open-pr"
  | "candidate"
  | "review";

export interface WorktreeInfo {
  readonly path: string;
  readonly branch: string | null;
  readonly head: string;
  readonly primary: boolean;
  readonly trackedChanges: number;
  readonly untrackedChanges: number;
  readonly remote: "detached" | "no-remote" | "pushed" | "ahead" | "diverged" | "unknown";
  readonly aheadBy: number | null;
  readonly mergedIntoBase: boolean | null;
  readonly pullRequest: {
    readonly number: number;
    readonly state: string;
  } | null;
  readonly activeSessionUse: "unknown";
  readonly disposition: WorktreeDisposition;
  readonly deletionAllowed: false;
  readonly reasons: readonly string[];
}

export interface WorktreeProjection {
  readonly repository: string;
  readonly baseRef: string | null;
  readonly worktrees: readonly WorktreeInfo[];
}

export interface SourceDigest {
  readonly kind: "orch" | "watch-pr" | "handoff";
  readonly path: string;
  readonly digest: string;
}

export interface SourceWarning {
  readonly source: "orch" | "watch-pr" | "handoff" | "worktrees";
  readonly path?: string;
  readonly message: string;
}

export type NowItem =
  | {
      readonly kind: "open-gate";
      readonly id: string;
      readonly question: string;
      readonly defaultAnswer: string;
    }
  | {
      readonly kind: "verify-head";
      readonly unitId: string;
      readonly pr: number;
      readonly sha: string;
    }
  | {
      readonly kind: "resume-handoff";
      readonly path: string;
    }
  | {
      readonly kind: "worktree-risk";
      readonly path: string;
      readonly disposition: WorktreeDisposition;
      readonly reason: string;
    };

export interface HandoffSummary {
  readonly path: string;
  readonly createdAt: string;
  readonly intent: string;
  readonly nextAction: string;
}

export interface PstackSnapshotV1 {
  readonly schemaVersion: 1;
  readonly snapshotHash: string;
  readonly capabilities: PstackCapabilities;
  readonly sources: readonly SourceDigest[];
  readonly orch: OrchProjection | null;
  readonly watch: readonly WatchProjection[];
  readonly worktrees: WorktreeProjection | null;
  readonly handoff: HandoffSummary | null;
  readonly now: readonly NowItem[];
  readonly sourceWarnings: readonly SourceWarning[];
}

export type PstackSnapshot = PstackSnapshotV1;

export type EvidenceItem =
  | { readonly kind: "file"; readonly value: string; readonly digest?: string }
  | { readonly kind: "command"; readonly value: string; readonly digest?: string }
  | { readonly kind: "link"; readonly value: string }
  | { readonly kind: "note"; readonly value: string };

export interface VerificationReceiptV1 {
  readonly schemaVersion: 1;
  readonly receiptId: string;
  readonly pr: number;
  readonly sha: string;
  readonly verdict: VerificationVerdict;
  readonly verifier: string;
  readonly summary: string;
  readonly evidence: readonly EvidenceItem[];
  readonly createdAt: string;
  readonly supersedesReceiptId?: string;
}

export interface HandoffV1 {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly createdAt: string;
  readonly intent: string;
  readonly progress: string;
  readonly nextAction: string;
  readonly keyFiles: readonly string[];
  readonly snapshot: PstackSnapshot;
}
