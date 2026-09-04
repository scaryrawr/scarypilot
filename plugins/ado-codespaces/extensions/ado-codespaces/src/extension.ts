import { joinSession } from "@github/copilot-sdk/extension";
import type { CopilotSession } from "@github/copilot-sdk";
import { AgentEventInbox } from "./agent-event-inbox.ts";
import { SupervisorClient } from "./supervisor-client.ts";
import { createSupervisorTools } from "./tools.ts";

let sessionRef: CopilotSession | null = null;
const events = new AgentEventInbox();

const supervisor = new SupervisorClient({
  log: (message, level) => sessionRef?.log(message, { level, ephemeral: true }) ?? undefined,
});
supervisor.subscribe((event) => events.add(event));

const session = await joinSession({
  tools: createSupervisorTools(supervisor, events),
});

sessionRef = session;
let shutdownPromise: Promise<void> | null = null;
session.on("session.shutdown", () => {
  shutdownPromise ??= shutdown();
  return shutdownPromise.catch((error) => {
    console.error("ADO Codespaces shutdown failed:", error);
  });
});

async function shutdown(): Promise<void> {
  events.close();
  await supervisor.shutdown();
}
