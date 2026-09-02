import { joinSession } from "@github/copilot-sdk/extension";
import { AgentEventInbox } from "./agent-event-inbox.ts";
import { SupervisorClient } from "./supervisor-client.ts";
import { createSupervisorTools } from "./tools.ts";

let sessionRef: import("@github/copilot-sdk").CopilotSession | null = null;
const events = new AgentEventInbox();

const supervisor = new SupervisorClient({
  log: (message, level) => sessionRef?.log(message, { level, ephemeral: true }) ?? undefined,
});
supervisor.subscribe((event) => events.add(event));

const session = await joinSession({
  hooks: {
    onSessionEnd: async () => {
      events.close();
      await supervisor.shutdown();
    },
  },
  tools: createSupervisorTools(supervisor, events),
});

sessionRef = session;
