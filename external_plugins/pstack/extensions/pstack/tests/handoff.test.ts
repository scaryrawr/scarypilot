import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProcessPort } from "../src/io.ts";
import { readHandoff, writeHandoff } from "../src/handoff.ts";
import { buildSnapshot } from "../src/snapshot.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("handoff", () => {
  it("persists a versioned artifact under the repository Git state path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pstack-handoff-"));
    directories.push(directory);
    const port: ProcessPort = {
      run: async (_command, args) => {
        if (args.includes("--show-toplevel")) return { stdout: `${directory}\n`, stderr: "" };
        if (args.includes("--git-common-dir")) return { stdout: `${join(directory, ".git")}\n`, stderr: "" };
        throw new Error(`unexpected args: ${args.join(" ")}`);
      },
    };
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
    const result = await writeHandoff(
      directory,
      "session-1",
      {
        intent: "Finish pstack",
        progress: "Extension implemented",
        nextAction: "Run checks",
        keyFiles: ["plugin.json"],
        snapshot,
      },
      port,
    );
    expect(result.path).toContain(join(".git", "pstack", "handoffs", "session-1.json"));
    expect((await readHandoff(result.path)).nextAction).toBe("Run checks");
  });
});
