import { describe, expect, it } from "vitest";
import {
  loadAzurePullRequest,
  type AzureCliRunner,
} from "../src/ado-loader.ts";

describe("loadAzurePullRequest", () => {
  it("loads changed contents and builds a unified patch", async () => {
    const jsonCalls: string[][] = [];
    const fileCalls: string[][] = [];
    const runner: AzureCliRunner = {
      async json(args) {
        jsonCalls.push(args);
        if (args.includes("show")) {
          return {
            title: "Update greeting",
            sourceRefName: "refs/heads/feature",
            targetRefName: "refs/heads/main",
            repository: { id: "repo-id", name: "repo" },
            lastMergeSourceCommit: { commitId: "stale-source-sha" },
            lastMergeTargetCommit: { commitId: "stale-target-sha" },
          };
        }
        if (args.includes("pullRequestIterations")) {
          return {
            value: [
              {
                id: 1,
                commonRefCommit: { commitId: "old-common-sha" },
                sourceRefCommit: { commitId: "old-source-sha" },
              },
              {
                id: 2,
                commonRefCommit: { commitId: "target-sha" },
                sourceRefCommit: { commitId: "source-sha" },
              },
            ],
          };
        }
        return {
          changeEntries: [
            {
              changeType: "edit",
              item: { path: "/src/greeting.ts" },
            },
          ],
        };
      },
      async file(args) {
        fileCalls.push(args);
        const versionArgument = args.find((arg) =>
          arg.startsWith("versionDescriptor.version="),
        );
        return Buffer.from(
          versionArgument === "versionDescriptor.version=source-sha"
            ? 'export const greeting = "hello";\n'
            : 'export const greeting = "hi";\n',
        );
      },
    };

    const loaded = await loadAzurePullRequest(
      "https://dev.azure.com/example/project/_git/repo/pullrequest/42",
      runner,
    );

    expect(loaded).toMatchObject({
      title: "Update greeting",
      sourceBranch: "feature",
      targetBranch: "main",
      status: "Loaded 1 changed file",
    });
    expect(loaded.files[0]).toMatchObject({
      path: "src/greeting.ts",
      previousPath: "src/greeting.ts",
      additions: 1,
      deletions: 1,
      oldContent: 'export const greeting = "hi";\n',
      newContent: 'export const greeting = "hello";\n',
    });
    expect(loaded.files[0].diff).toContain('-export const greeting = "hi";');
    expect(loaded.files[0].diff).toContain('+export const greeting = "hello";');
    expect(jsonCalls.some((args) => args.includes("pullRequestIterationChanges"))).toBe(true);
    expect(fileCalls).toHaveLength(2);
  });
});
