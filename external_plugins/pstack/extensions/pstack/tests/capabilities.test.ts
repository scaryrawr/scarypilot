import { expect, it, vi } from "vitest";
import { detectCapabilities } from "../src/capabilities.ts";

it("reports missing, unlaunchable, nonzero and timed-out probes as unavailable", async () => {
  const failures = ["ENOENT", "EINVAL", "exit status 1", "timed out"];

  const run = vi.fn(async (command: string, args: readonly string[]) => {
    throw new Error(failures[args[0] === "stack" ? 2 : ["git", "gh", "", "bun"].indexOf(command)]);
  });

  const result = await detectCapabilities({ run });

  for (const [index, key] of (["git", "githubCli", "ghStack", "bunLegacyScripts"] as const).entries()) {
    expect(result[key]).toEqual({ kind: "unavailable", reason: expect.stringContaining(failures[index]) });
  }

  expect(run).toHaveBeenCalledTimes(4);
});

it("reports only successful launches as available and leaves host surfaces unknown", async () => {
  const run = vi.fn(async (command: string, args: readonly string[]) => ({
    stdout: `${args[0] === "stack" ? "gh-stack" : command} 1.2.3\nsecond line`, stderr: "",
  }));

  const result = await detectCapabilities({ run });
  expect(result.ghStack).toEqual({ kind: "available", detail: "gh-stack 1.2.3" });
  expect(result.taskAgents.kind).toBe("unknown");
  expect(run).toHaveBeenCalledWith("gh", ["stack", "--version"], { timeoutMs: 3_000 });
  expect(result).not.toHaveProperty("graphite");
});

it("keeps GitHub CLI available when the separately installed stack extension is missing", async () => {
  const run = vi.fn(async (command: string, args: readonly string[]) => {
    if (args[0] === "stack") throw new Error("unknown command stack");

    return { stdout: `${command} version`, stderr: "" };
  });

  const result = await detectCapabilities({ run });

  expect(result.githubCli.kind).toBe("available");
  expect(result.ghStack).toEqual({
    kind: "unavailable", reason: "gh stack --version probe failed: unknown command stack",
  });
  expect(run).toHaveBeenCalledTimes(4);
});
