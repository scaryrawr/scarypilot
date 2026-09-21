import type { CopilotSession } from "@github/copilot-sdk";
import type { joinSession } from "@github/copilot-sdk/extension";
import { createPstackCommand } from "./command.ts";
import { createCwdRef } from "./extension-context.ts";
import { pstackFactories, pstackFactoryAgents } from "./factories/index.ts";
import { handoffAdditionalContext } from "./handoff.ts";
import { createPstackService } from "./service.ts";
import { createCapabilitiesTool } from "./tools/capabilities.ts";
import { createHandoffTool } from "./tools/handoff.ts";
import { createInspectWorktreesTool } from "./tools/inspect-worktrees.ts";
import { createRecordVerificationTool } from "./tools/record-verification.ts";
import { createStatusTool } from "./tools/status.ts";
import { createValidatePlanTool } from "./tools/validate-plan.ts";

type SessionOptions = NonNullable<Parameters<typeof joinSession>[0]>;

interface PstackExtensionRegistration {
  options: SessionOptions;
  attachSession: (session: CopilotSession) => void;
}

export function createPstackExtensionRegistration(): PstackExtensionRegistration {
  const cwdRef = createCwdRef(process.cwd());
  const service = createPstackService(cwdRef);
  let sessionRef: CopilotSession | null = null;

  const command = createPstackCommand(service, () => {
    if (!sessionRef) throw new Error("pstack command invoked before the session is ready");

    return sessionRef;
  });

  const options: SessionOptions = {
    hooks: {
      onSessionStart: async (input) => {
        cwdRef.set(input.workingDirectory);

        if (!sessionRef) throw new Error("pstack session started before registration completed");
        await sessionRef.log("pstack native tools loaded", { ephemeral: true });

        if (input.source !== "resume") return undefined;

        try {
          const handoff = await service.readHandoff();

          return {
            additionalContext: handoffAdditionalContext(handoff),
          };
        } catch {
          return undefined;
        }
      },
      onUserPromptSubmitted: async (input) => {
        cwdRef.set(input.workingDirectory);
      },
      onPreToolUse: async (input) => {
        cwdRef.set(input.workingDirectory);
      },
      onPostToolUse: async (input) => {
        cwdRef.set(input.workingDirectory);
      },
    },
    tools: [
      createStatusTool(service),
      createCapabilitiesTool(service),
      createValidatePlanTool(service),
      createRecordVerificationTool(service),
      createInspectWorktreesTool(service),
      createHandoffTool(service),
    ],
    commands: [command],
    customAgents: pstackFactoryAgents,
    factories: pstackFactories,
  };

  return {
    options,
    attachSession: (session) => {
      sessionRef = session;
    },
  };
}
