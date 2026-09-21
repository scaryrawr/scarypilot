import { beforeEach, describe, expect, it, vi } from "vitest";
import type { joinSession } from "@github/copilot-sdk/extension";
import { registerDigivolutionExtension } from "../src/register.ts";

type HookOptions = Parameters<typeof joinSession>[0];

describe("digivolution extension", () => {
  let options: HookOptions | undefined;
  const timestamp = new Date("2026-09-21T12:00:00.000Z");

  beforeEach(() => {
    options = undefined;
  });

  const join = vi.fn(async (next: HookOptions) => {
    options = next;
  });

  it("registers the adaptive hooks and blocks once for a correction", async () => {
    await registerDigivolutionExtension(join);
    const primary = { sessionId: "primary-session" };

    expect(Object.keys(options?.hooks ?? {})).toEqual([
      "onUserPromptSubmitted",
      "onPostToolUse",
      "onPostToolUseFailure",
      "onAgentStop",
    ]);

    await options?.hooks?.onUserPromptSubmitted?.({
      sessionId: primary.sessionId,
      prompt: "Stop using npm here; this repository requires pnpm.",
      timestamp,
      workingDirectory: "/workspace/repo",
    }, primary);

    const first = await options?.hooks?.onAgentStop?.({
      sessionId: primary.sessionId,
      timestamp,
      workingDirectory: "/workspace/repo",
    }, primary);

    const second = await options?.hooks?.onAgentStop?.({
      sessionId: primary.sessionId,
      timestamp,
      workingDirectory: "/workspace/repo",
    }, primary);

    expect(first).toMatchObject({ decision: "block" });
    expect(second).toBeUndefined();
  });

  it("ignores subagent prompts and tool outcomes", async () => {
    await registerDigivolutionExtension(join);
    const primary = { sessionId: "primary-session" };
    const subagentSessionId = "call_subagent";

    await options?.hooks?.onUserPromptSubmitted?.({
      sessionId: subagentSessionId,
      prompt: "Stop using npm here; this repository requires pnpm.",
      timestamp,
      workingDirectory: "/workspace/repo",
    }, primary);
    await options?.hooks?.onPostToolUseFailure?.({
      sessionId: subagentSessionId,
      toolName: "bash",
      toolArgs: { command: "npm test ./package.json" },
      error: "unknown command test",
      timestamp,
      workingDirectory: "/workspace/repo",
    }, primary);
    await options?.hooks?.onPostToolUse?.({
      sessionId: subagentSessionId,
      toolName: "bash",
      toolArgs: { command: "python3 -m json.tool ./package.json" },
      toolResult: {
        textResultForLlm: "ok",
        resultType: "success",
      },
      timestamp,
      workingDirectory: "/workspace/repo",
    }, primary);

    const decision = await options?.hooks?.onAgentStop?.({
      sessionId: primary.sessionId,
      timestamp,
      workingDirectory: "/workspace/repo",
    }, primary);

    expect(decision).toBeUndefined();
  });
});
