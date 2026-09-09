import { beforeEach, describe, expect, it, vi } from "vitest";

type HookOptions = {
  hooks: {
    onUserPromptSubmitted: (input: {
      sessionId: string;
      prompt: string;
      workingDirectory: string;
    }, invocation: { sessionId: string }) => Promise<void>;
    onPostToolUse: (input: {
      sessionId: string;
      toolName: string;
      toolArgs: unknown;
      toolResult: unknown;
      workingDirectory: string;
    }, invocation: { sessionId: string }) => Promise<void>;
    onPostToolUseFailure: (input: {
      sessionId: string;
      toolName: string;
      toolArgs: unknown;
      error: string;
      workingDirectory: string;
    }, invocation: { sessionId: string }) => Promise<void>;
    onAgentStop: (input: {
      sessionId: string;
      stopHookActive?: boolean;
      workingDirectory: string;
    }, invocation: { sessionId: string }) => Promise<
      { decision: "block"; reason: string } | undefined
    >;
  };
};

const mocks = vi.hoisted(() => ({
  options: undefined as HookOptions | undefined,
}));

vi.mock("@github/copilot-sdk/extension", () => ({
  joinSession: vi.fn(async (options: HookOptions) => {
    mocks.options = options;
    return {};
  }),
}));

describe("digivolution extension", () => {
  beforeEach(() => {
    mocks.options = undefined;
    vi.resetModules();
  });

  it("registers the adaptive hooks and blocks once for a correction", async () => {
    await import("../src/extension.ts");
    const primary = { sessionId: "primary-session" };

    expect(Object.keys(mocks.options?.hooks ?? {})).toEqual([
      "onUserPromptSubmitted",
      "onPostToolUse",
      "onPostToolUseFailure",
      "onAgentStop",
    ]);

    await mocks.options?.hooks.onUserPromptSubmitted({
      sessionId: primary.sessionId,
      prompt: "Stop using npm here; this repository requires pnpm.",
      workingDirectory: "/workspace/repo",
    }, primary);

    const first = await mocks.options?.hooks.onAgentStop({
      sessionId: primary.sessionId,
      workingDirectory: "/workspace/repo",
    }, primary);
    const second = await mocks.options?.hooks.onAgentStop({
      sessionId: primary.sessionId,
      workingDirectory: "/workspace/repo",
    }, primary);

    expect(first).toMatchObject({ decision: "block" });
    expect(second).toBeUndefined();
  });

  it("ignores subagent prompts and tool outcomes", async () => {
    await import("../src/extension.ts");
    const primary = { sessionId: "primary-session" };
    const subagentSessionId = "call_subagent";

    await mocks.options?.hooks.onUserPromptSubmitted({
      sessionId: subagentSessionId,
      prompt: "Stop using npm here; this repository requires pnpm.",
      workingDirectory: "/workspace/repo",
    }, primary);
    await mocks.options?.hooks.onPostToolUseFailure({
      sessionId: subagentSessionId,
      toolName: "bash",
      toolArgs: { command: "npm test ./package.json" },
      error: "unknown command test",
      workingDirectory: "/workspace/repo",
    }, primary);
    await mocks.options?.hooks.onPostToolUseFailure({
      sessionId: subagentSessionId,
      toolName: "bash",
      toolArgs: { command: "npm run test ./package.json" },
      error: "tests failed",
      workingDirectory: "/workspace/repo",
    }, primary);
    await mocks.options?.hooks.onPostToolUse({
      sessionId: subagentSessionId,
      toolName: "bash",
      toolArgs: { command: "python3 -m json.tool ./package.json" },
      toolResult: {},
      workingDirectory: "/workspace/repo",
    }, primary);

    const decision = await mocks.options?.hooks.onAgentStop({
      sessionId: primary.sessionId,
      workingDirectory: "/workspace/repo",
    }, primary);

    expect(decision).toBeUndefined();
  });

  it("ignores a stop event from a non-primary session", async () => {
    await import("../src/extension.ts");
    const primary = { sessionId: "primary-session" };

    await mocks.options?.hooks.onUserPromptSubmitted({
      sessionId: primary.sessionId,
      prompt: "Stop using npm here; this repository requires pnpm.",
      workingDirectory: "/workspace/repo",
    }, primary);

    const decision = await mocks.options?.hooks.onAgentStop({
      sessionId: "call_subagent",
      workingDirectory: "/workspace/repo",
    }, primary);

    expect(decision).toBeUndefined();
  });
});
