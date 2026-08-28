import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { buildSnapshot } from "../src/snapshot.ts";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("contract validator", () => {
  it("accepts snapshots emitted by the domain builder", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pstack-contract-"));
    directories.push(directory);
    const path = join(directory, "snapshot.json");
    const unknown = { kind: "unknown" as const, reason: "host" };
    const snapshot = buildSnapshot({
      capabilities: {
        git: unknown,
        githubCli: unknown,
        graphite: unknown,
        bunLegacyScripts: unknown,
        taskAgents: unknown,
        sessionHistory: unknown,
        browserAutomation: unknown,
        mcp: unknown,
        sidebarSessions: unknown,
      },
      sources: [],
      orch: null,
      watch: [],
      worktrees: null,
      handoff: null,
      sourceWarnings: [],
    });
    await writeFile(path, JSON.stringify(snapshot));
    const script = resolve(
      import.meta.dirname,
      "../../../skills/pstack-schema-validate/scripts/validate.mjs",
    );
    const result = await execFileAsync(process.execPath, [script, "snapshot", path]);
    expect(result.stdout).toContain("snapshot contract valid");
  });

  it("rejects properties outside the published snapshot contract", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pstack-contract-invalid-"));
    directories.push(directory);
    const path = join(directory, "snapshot.json");
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        snapshotHash: "a".repeat(64),
        capabilities: {},
        sources: [],
        orch: null,
        watch: [],
        worktrees: null,
        handoff: null,
        now: [],
        sourceWarnings: [],
        unexpected: true,
      }),
    );
    const script = resolve(
      import.meta.dirname,
      "../../../skills/pstack-schema-validate/scripts/validate.mjs",
    );
    await expect(execFileAsync(process.execPath, [script, "snapshot", path])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("$.unexpected: unexpected property"),
    });
  });

  it("rejects receipt fields that violate the published schema", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pstack-receipt-contract-invalid-"));
    directories.push(directory);
    const path = join(directory, "receipt.json");
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        receiptId: "a".repeat(20),
        pr: 1,
        sha: "abc",
        verdict: "unit-test-verified",
        verifier: "test",
        summary: "passed",
        evidence: [{ kind: "file", value: "proof.txt", digest: 42 }],
        createdAt: "2026-01-01",
      }),
    );
    const script = resolve(
      import.meta.dirname,
      "../../../skills/pstack-schema-validate/scripts/validate.mjs",
    );
    await expect(execFileAsync(process.execPath, [script, "receipt", path])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("$.evidence[0].digest: expected string"),
    });
  });
});
