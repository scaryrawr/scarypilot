import { joinSession } from "@github/copilot-sdk/extension";
import { REFLECTION_PROMPT, TurnMonitor } from "./turn-monitor.ts";

const monitor = new TurnMonitor();

function isPrimarySession(
  input: { sessionId: string },
  invocation: { sessionId: string },
): boolean {
  return input.sessionId === invocation.sessionId;
}

await joinSession({
  hooks: {
    onUserPromptSubmitted: async (input, invocation) => {
      if (!isPrimarySession(input, invocation)) return;
      monitor.start(input.prompt);
    },
    onPostToolUse: async (input, invocation) => {
      if (!isPrimarySession(input, invocation)) return;
      monitor.recordSuccess({
        toolName: input.toolName,
        toolArgs: input.toolArgs,
        workingDirectory: input.workingDirectory,
      });
    },
    onPostToolUseFailure: async (input, invocation) => {
      if (!isPrimarySession(input, invocation)) return;
      monitor.recordFailure(
        {
          toolName: input.toolName,
          toolArgs: input.toolArgs,
          workingDirectory: input.workingDirectory,
        },
        input.error,
      );
    },
    onAgentStop: async (input, invocation) => {
      if (!isPrimarySession(input, invocation)) return;
      if (!monitor.claimReflection(input.stopHookActive)) return;
      return { decision: "block", reason: REFLECTION_PROMPT };
    },
  },
});
