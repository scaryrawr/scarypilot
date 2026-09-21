import { joinSession } from "@github/copilot-sdk/extension";
import { REFLECTION_PROMPT, TurnMonitor } from "./turn-monitor.ts";

type JoinSession = (
  options: Parameters<typeof joinSession>[0],
) => Promise<void>;

const defaultJoinSession: JoinSession = async (options) => {
  await joinSession(options);
};

function isPrimarySession(
  input: { sessionId: string },
  invocation: { sessionId: string },
): boolean {
  return input.sessionId === invocation.sessionId;
}

export async function registerDigivolutionExtension(
  join: JoinSession = defaultJoinSession,
): Promise<void> {
  const monitor = new TurnMonitor();

  await join({
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
}
