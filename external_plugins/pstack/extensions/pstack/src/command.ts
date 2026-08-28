import type { CommandDefinition, CopilotSession } from "@github/copilot-sdk";
import type { PstackService } from "./service.ts";

type CommandSession = Pick<CopilotSession, "log">;

const HELP = [
  "Usage: /pstack <status|capabilities|resume> [argument]",
  "",
  "  /pstack status              Print the current projected pstack status.",
  "  /pstack capabilities        Report native and host-controlled capabilities.",
  "  /pstack resume [handoff]    Print the latest or selected durable handoff.",
].join("\n");

export function createPstackCommand(
  service: PstackService,
  getSession: () => CommandSession,
): CommandDefinition {
  return {
    name: "pstack",
    description: "Inspect pstack status, capabilities, or a durable handoff.",
    handler: async (context) => {
      const [subcommand = "", ...rest] = (context.args ?? "").trim().split(/\s+/);
      const session = getSession();
      if (!subcommand) {
        await session.log(HELP);
        return;
      }
      if (subcommand === "status") {
        await session.log(JSON.stringify(await service.status(), null, 2));
        return;
      }
      if (subcommand === "capabilities") {
        await session.log(JSON.stringify(await service.capabilities(), null, 2));
        return;
      }
      if (subcommand === "resume") {
        const handoff = await service.readHandoff(rest[0]);
        await session.log(
          [
            `Intent: ${handoff.intent}`,
            `Progress: ${handoff.progress}`,
            `Next action: ${handoff.nextAction}`,
            `Key files: ${handoff.keyFiles.join(", ") || "(none)"}`,
            `Snapshot: ${handoff.snapshot.snapshotHash}`,
          ].join("\n"),
        );
        return;
      }
      await session.log(HELP, { level: "error" });
    },
  };
}
