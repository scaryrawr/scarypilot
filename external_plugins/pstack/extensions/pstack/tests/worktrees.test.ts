import { describe, expect, it } from "vitest";
import type { ProcessPort } from "../src/io.ts";
import { inspectWorktrees } from "../src/worktrees.ts";

describe("inspectWorktrees", () => {
  it("never grants deletion permission and uses a detected base ref", async () => {
    const port: ProcessPort = {
      run: async (command, args) => {
        const key = [command, ...args].join(" ");
        if (key.includes("rev-parse --show-toplevel")) return { stdout: "/repo\n", stderr: "" };
        if (key.includes("worktree list --porcelain")) {
          return {
            stdout:
              "worktree /repo\nHEAD aaa\nbranch refs/heads/main\n\nworktree /repo-topic\nHEAD bbb\nbranch refs/heads/topic\n",
            stderr: "",
          };
        }
        if (key.includes("symbolic-ref --quiet --short refs/remotes/origin/HEAD")) {
          return { stdout: "origin/main\n", stderr: "" };
        }
        if (command === "gh") return { stdout: '[{"number":7,"state":"OPEN","headRefName":"topic"}]', stderr: "" };
        if (key.includes("status --porcelain")) return { stdout: "", stderr: "" };
        if (key.includes("@{upstream}")) throw new Error("no upstream");
        if (key.includes("merge-base --is-ancestor")) throw new Error("not merged");
        throw new Error(`unexpected command: ${key}`);
      },
    };
    const result = await inspectWorktrees("/repo", undefined, port);
    const topic = result.worktrees.find((worktree) => worktree.branch === "topic");
    expect(result.baseRef).toBe("origin/main");
    expect(topic?.disposition).toBe("hold-open-pr");
    expect(topic?.deletionAllowed).toBe(false);
    expect(topic?.activeSessionUse).toBe("unknown");
  });
});
