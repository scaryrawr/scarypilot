import { describe, expect, it } from "vitest";
import {
  REFLECTION_PROMPT,
  TurnMonitor,
  isRepositoryCorrection,
} from "../src/turn-monitor.ts";

const cwd = "/workspace/repo";

describe("isRepositoryCorrection", () => {
  it.each([
    "Stop using npm here; this repository requires pnpm.",
    "I already told you: AGENTS.md requires the manifest validation command.",
    "No, use the test script from this repo.",
    "Please remember to use pnpm for this repository.",
    "Please remember how to run the validation in AGENTS.md.",
    "Why did you use npm when this repo requires pnpm?",
    "Remember that this repository uses pnpm.",
    "Could you please remember that AGENTS.md has the validation command?",
    "Don't use npm in this repository again.",
    "Do not remove the package-lock.json again.",
    "Next time, follow the workflow in AGENTS.md.",
    "From now on, use pnpm for this repo.",
    "Why are you still running npm in this repository?",
    "You keep ignoring the setup instructions in AGENTS.md.",
  ])("accepts explicit repository corrections: %s", (prompt) => {
    expect(isRepositoryCorrection(prompt)).toBe(true);
  });

  it.each([
    "This is frustrating.",
    "Please fix it.",
    "Stop and explain what you are doing.",
    "Stop using this command and just answer me.",
    "Please remember to answer concisely.",
    "I remember that npm used to be popular.",
    "Don't do that again.",
    "Next time, be more concise.",
    "From now on, answer briefly.",
    "Why did you stop?",
    "The tests are failing.",
    "URGENT: make this work.",
  ])("rejects ambiguous frustration or routine steering: %s", (prompt) => {
    expect(isRepositoryCorrection(prompt)).toBe(false);
  });
});

describe("TurnMonitor", () => {
  it("allows an ordinary turn", () => {
    const monitor = new TurnMonitor();
    monitor.start("Fix the typo in README.md.");

    expect(monitor.claimReflection()).toBe(false);
  });

  it("claims one reflection for a direct repository correction", () => {
    const monitor = new TurnMonitor();
    monitor.start("Stop using npm here; this repository requires pnpm.");

    expect(monitor.claimReflection()).toBe(true);
    expect(monitor.claimReflection()).toBe(false);
  });

  it("allows a stop that is already hook-active", () => {
    const monitor = new TurnMonitor();
    monitor.start("Stop using npm here; this repository requires pnpm.");

    expect(monitor.claimReflection(true)).toBe(false);
    expect(monitor.claimReflection()).toBe(true);
  });

  it("does not replace the claimed turn with its own continuation prompt", () => {
    const monitor = new TurnMonitor();
    monitor.start("Stop using npm here; this repository requires pnpm.");
    expect(monitor.claimReflection()).toBe(true);

    monitor.start(REFLECTION_PROMPT);

    expect(monitor.claimReflection()).toBe(false);
  });

  it("triggers when a repo-local command usage error is recovered", () => {
    const monitor = new TurnMonitor();
    monitor.start("Run the correct validation.");
    monitor.recordFailure(
      {
        toolName: "bash",
        toolArgs: { command: "npm test ./package.json" },
        workingDirectory: cwd,
      },
      "npm: unknown command test",
    );
    monitor.recordSuccess({
      toolName: "bash",
      toolArgs: { command: "python3 -m json.tool ./package.json" },
      workingDirectory: cwd,
    });

    expect(monitor.claimReflection()).toBe(true);
  });

  it("triggers when a root-scoped validation command is corrected", () => {
    const monitor = new TurnMonitor();
    monitor.start("Run the repository validation.");
    monitor.recordFailure(
      {
        toolName: "bash",
        toolArgs: { command: "npm test", description: "Run tests" },
        workingDirectory: cwd,
      },
      "npm: unknown command test",
    );
    monitor.recordSuccess({
      toolName: "bash",
      toolArgs: { command: "pnpm test", description: "Run tests" },
      workingDirectory: cwd,
    });

    expect(monitor.claimReflection()).toBe(true);
  });

  it.each([
    { path: "." },
    { path: "./" },
    { cwd },
    { workingDirectory: cwd },
  ])("accepts an explicit repository-root target: %j", (targetArgs) => {
    const monitor = new TurnMonitor();
    monitor.start("Run the repository validation.");
    monitor.recordFailure(
      {
        toolName: "bash",
        toolArgs: { command: "npm test", ...targetArgs },
        workingDirectory: cwd,
      },
      "npm: unknown command test",
    );
    monitor.recordSuccess({
      toolName: "bash",
      toolArgs: { command: "pnpm test", ...targetArgs },
      workingDirectory: cwd,
    });

    expect(monitor.claimReflection()).toBe(true);
  });

  it("does not trigger on a single generic failure and recovery", () => {
    const monitor = new TurnMonitor();
    monitor.start("Fix the test.");
    monitor.recordFailure(
      {
        toolName: "bash",
        toolArgs: { command: "npm test ./package.json" },
        workingDirectory: cwd,
      },
      "AssertionError: expected true",
    );
    monitor.recordSuccess({
      toolName: "bash",
      toolArgs: { command: "npm test ./package.json -- --runInBand" },
      workingDirectory: cwd,
    });

    expect(monitor.claimReflection()).toBe(false);
  });

  it("triggers after repeated repo-local failures and a changed success", () => {
    const monitor = new TurnMonitor();
    monitor.start("Find the repository validation command.");
    monitor.recordFailure(
      {
        toolName: "bash",
        toolArgs: { command: "npm test ./package.json" },
        workingDirectory: cwd,
      },
      "tests failed",
    );
    monitor.recordFailure(
      {
        toolName: "bash",
        toolArgs: { command: "npm run test ./package.json" },
        workingDirectory: cwd,
      },
      "tests failed",
    );
    monitor.recordSuccess({
      toolName: "bash",
      toolArgs: { command: "python3 -m json.tool ./package.json" },
      workingDirectory: cwd,
    });

    expect(monitor.claimReflection()).toBe(true);
  });

  it("ignores failures without a repo-local target", () => {
    const monitor = new TurnMonitor();
    monitor.start("Check the service.");
    monitor.recordFailure(
      {
        toolName: "web_fetch",
        toolArgs: { url: "https://example.com" },
        workingDirectory: cwd,
      },
      "network failure",
    );
    monitor.recordFailure(
      {
        toolName: "web_fetch",
        toolArgs: { url: "https://example.com" },
        workingDirectory: cwd,
      },
      "network failure",
    );
    monitor.recordSuccess({
      toolName: "web_fetch",
      toolArgs: { url: "https://example.org" },
      workingDirectory: cwd,
    });

    expect(monitor.claimReflection()).toBe(false);
  });

  it("ignores network URLs even when reported by a local command tool", () => {
    const monitor = new TurnMonitor();
    monitor.start("Check the endpoint.");
    monitor.recordFailure(
      {
        toolName: "bash",
        toolArgs: { command: "curl https://example.com/api" },
        workingDirectory: cwd,
      },
      "request failed",
    );
    monitor.recordFailure(
      {
        toolName: "bash",
        toolArgs: { command: "curl https://example.com/api --retry 1" },
        workingDirectory: cwd,
      },
      "request failed",
    );
    monitor.recordSuccess({
      toolName: "bash",
      toolArgs: { command: "curl https://example.com/api --retry 2" },
      workingDirectory: cwd,
    });

    expect(monitor.claimReflection()).toBe(false);
  });

  it("ignores changes to non-execution metadata", () => {
    const monitor = new TurnMonitor();
    monitor.start("Run the validation.");
    monitor.recordFailure(
      {
        toolName: "bash",
        toolArgs: { command: "npm test ./package.json", description: "First try" },
        workingDirectory: cwd,
      },
      "tests failed",
    );
    monitor.recordFailure(
      {
        toolName: "bash",
        toolArgs: { command: "npm test ./package.json", description: "Second try" },
        workingDirectory: cwd,
      },
      "tests failed",
    );
    monitor.recordSuccess({
      toolName: "bash",
      toolArgs: { command: "npm test ./package.json", description: "Successful retry" },
      workingDirectory: cwd,
    });

    expect(monitor.claimReflection()).toBe(false);
  });

  it("rejects targets outside the working directory", () => {
    const monitor = new TurnMonitor();
    monitor.start("Try the command.");
    monitor.recordFailure(
      {
        toolName: "bash",
        toolArgs: { path: "../other/package.json", command: "bad" },
        workingDirectory: cwd,
      },
      "unknown command",
    );
    monitor.recordSuccess({
      toolName: "bash",
      toolArgs: { path: "../other/package.json", command: "good" },
      workingDirectory: cwd,
    });

    expect(monitor.claimReflection()).toBe(false);
  });
});
