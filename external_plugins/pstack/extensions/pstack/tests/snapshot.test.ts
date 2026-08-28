import { describe, expect, it } from "vitest";
import { buildSnapshot } from "../src/snapshot.ts";
import type { PstackCapabilities } from "../src/types.ts";

const capabilities: PstackCapabilities = {
  git: { kind: "available", detail: "git" },
  githubCli: { kind: "unavailable", reason: "missing" },
  graphite: { kind: "unavailable", reason: "missing" },
  bunLegacyScripts: { kind: "unavailable", reason: "missing" },
  taskAgents: { kind: "unknown", reason: "host" },
  sessionHistory: { kind: "unknown", reason: "host" },
  browserAutomation: { kind: "unknown", reason: "host" },
  mcp: { kind: "unknown", reason: "host" },
  sidebarSessions: { kind: "unknown", reason: "host" },
};

describe("buildSnapshot", () => {
  it("is deterministic and derives actionable items", () => {
    const input = {
      capabilities,
      sources: [],
      orch: {
        storeDir: "/store",
        units: [
          { id: "u1", track: "build", state: "done", branch: "topic", pr: "12", sha: "abc", brief: "" },
        ],
        ledger: [],
        openGates: [
          { id: "approval", question: "Ship?", options: "yes,no", defaultAnswer: "no" },
        ],
        frontier: null,
        unitCounts: { done: 1 },
        ledgerCounts: {},
      },
      watch: [],
      worktrees: null,
      handoff: null,
      sourceWarnings: [],
    } as const;
    const first = buildSnapshot(input);
    const second = buildSnapshot(input);
    expect(first).toEqual(second);
    expect(first.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.now).toEqual([
      { kind: "open-gate", id: "approval", question: "Ship?", defaultAnswer: "no" },
      { kind: "verify-head", unitId: "u1", pr: 12, sha: "abc" },
    ]);
  });

  it("does not treat failed, blocked, or type-only verdicts as verified", () => {
    const snapshot = buildSnapshot({
      capabilities,
      sources: [],
      orch: {
        storeDir: "/store",
        units: [
          { id: "u1", track: "build", state: "done", branch: "topic", pr: "12", sha: "abc", brief: "" },
        ],
        ledger: [
          {
            pr: "12",
            sha: "abc",
            verdict: "verifier-failed",
            evidence: "failure.md",
            verifier: "test",
            timestamp: "2026-01-01T00:00:00.000Z",
          },
        ],
        openGates: [],
        frontier: null,
        unitCounts: { done: 1 },
        ledgerCounts: { "verifier-failed": 1 },
      },
      watch: [],
      worktrees: null,
      handoff: null,
      sourceWarnings: [],
    });
    expect(snapshot.now).toContainEqual({
      kind: "verify-head",
      unitId: "u1",
      pr: 12,
      sha: "abc",
    });
  });
});
