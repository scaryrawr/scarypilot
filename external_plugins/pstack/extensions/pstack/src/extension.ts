import { joinSession } from "@github/copilot-sdk/extension";
import { createPstackCommand } from "./command.ts";
import { createCwdRef } from "./extension-context.ts";
import { createPstackService } from "./service.ts";
import { createCapabilitiesTool } from "./tools/capabilities.ts";
import { createHandoffTool } from "./tools/handoff.ts";
import { createInspectWorktreesTool } from "./tools/inspect-worktrees.ts";
import { createRecordVerificationTool } from "./tools/record-verification.ts";
import { createStatusTool } from "./tools/status.ts";
import { createValidatePlanTool } from "./tools/validate-plan.ts";

const cwdRef = createCwdRef(process.cwd());
const service = createPstackService(cwdRef);
let sessionRef: import("@github/copilot-sdk").CopilotSession | null = null;

const command = createPstackCommand(service, () => {
  if (!sessionRef) throw new Error("pstack command invoked before the session is ready");
  return sessionRef;
});

const session = await joinSession({
  hooks: {
    onSessionStart: async (input) => {
      cwdRef.set(input.workingDirectory);
      await session.log("pstack native tools loaded", { ephemeral: true });
      if (input.source !== "resume") return undefined;
      try {
        const handoff = await service.readHandoff();
        return {
          additionalContext: [
            "A durable pstack handoff exists for this repository.",
            `Intent: ${handoff.intent}`,
            `Progress: ${handoff.progress}`,
            `Next action: ${handoff.nextAction}`,
            `Snapshot hash: ${handoff.snapshot.snapshotHash}`,
            "Verify inherited claims against the current repository before continuing.",
          ].join("\n"),
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
});
sessionRef = session;
