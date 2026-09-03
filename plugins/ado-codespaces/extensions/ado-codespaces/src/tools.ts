import type { Tool } from "@github/copilot-sdk";
import type { AgentEventInbox } from "./agent-event-inbox.ts";

export interface SupervisorRequester {
  request(method: string, params: Readonly<Record<string, unknown>>): Promise<unknown>;
}

type EmptyArgs = Record<string, never>;

interface CodespaceArgs {
  codespace: string;
}

interface AgentStartArgs extends CodespaceArgs {
  agent_id: string;
  working_directory?: string;
  approve_all_permissions?: boolean;
}

interface AgentIdArgs {
  agent_id: string;
}

interface AgentSendArgs extends AgentIdArgs {
  prompt: string;
}

interface AgentEventsArgs extends AgentIdArgs {
  after_sequence?: number;
  wait_ms?: number;
}

function json(value: unknown): string {
  return value === undefined ? "null" : JSON.stringify(value);
}

function emptyTool(
  supervisor: SupervisorRequester,
  name: string,
  method: string,
  description: string,
): Tool<EmptyArgs> {
  return {
    name,
    description,
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: async () => json(await supervisor.request(method, {})),
  };
}

function codespaceTool(
  supervisor: SupervisorRequester,
  name: string,
  method: string,
  description: string,
): Tool<CodespaceArgs> {
  return {
    name,
    description,
    parameters: {
      type: "object",
      properties: {
        codespace: { type: "string", description: "Codespace name." },
      },
      required: ["codespace"],
      additionalProperties: false,
    },
    handler: async (args) => json(await supervisor.request(method, { codespace: args.codespace })),
  };
}

function agentIdTool(
  supervisor: SupervisorRequester,
  name: string,
  method: string,
  description: string,
): Tool<AgentIdArgs> {
  return {
    name,
    description,
    parameters: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Agent ID." },
      },
      required: ["agent_id"],
      additionalProperties: false,
    },
    handler: async (args) => json(await supervisor.request(method, { agent_id: args.agent_id })),
  };
}

export function createSupervisorTools(
  supervisor: SupervisorRequester,
  events: Pick<AgentEventInbox, "drain">,
) {
  const codespacesList = emptyTool(
    supervisor,
    "codespaces_list",
    "codespaces.list",
    "List available Azure DevOps Codespaces.",
  );
  const codespacesStatus = codespaceTool(
    supervisor,
    "codespaces_status",
    "codespaces.status",
    "Get Codespace status.",
  );
  const codespacesStart = codespaceTool(
    supervisor,
    "codespaces_start",
    "codespaces.start",
    "Start a Codespace.",
  );
  const codespacesStop = codespaceTool(
    supervisor,
    "codespaces_stop",
    "codespaces.stop",
    "Stop a Codespace.",
  );
  const agentStart: Tool<AgentStartArgs> = {
    name: "agent_start",
    description: "Start a Copilot agent in a Codespace.",
    parameters: {
      type: "object",
      properties: {
        codespace: { type: "string", description: "Codespace name." },
        agent_id: { type: "string", description: "Agent ID." },
        working_directory: {
          type: "string",
          description: "Optional working directory in the Codespace.",
        },
        approve_all_permissions: {
          type: "boolean",
          description: "Explicitly opt in to approving all agent permissions.",
        },
      },
      required: ["codespace", "agent_id"],
      additionalProperties: false,
    },
    handler: async (args) =>
      json(
        await supervisor.request("agent.start", {
          codespace: args.codespace,
          agent_id: args.agent_id,
          ...(args.working_directory === undefined
            ? {}
            : { working_directory: args.working_directory }),
          ...(args.approve_all_permissions === undefined
            ? {}
            : { approve_all_permissions: args.approve_all_permissions }),
        }),
      ),
  };
  const agentSend: Tool<AgentSendArgs> = {
    name: "agent_send",
    description: "Send a message to an agent.",
    parameters: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Agent ID." },
        prompt: { type: "string", description: "Prompt to send to the agent." },
      },
      required: ["agent_id", "prompt"],
      additionalProperties: false,
    },
    handler: async (args) =>
      json(
        await supervisor.request("agent.send", {
          agent_id: args.agent_id,
          prompt: args.prompt,
        }),
      ),
  };
  const agentStatus = agentIdTool(supervisor, "agent_status", "agent.status", "Get agent status.");
  const agentStop = agentIdTool(supervisor, "agent_stop", "agent.stop", "Stop an agent.");
  const agentEvents: Tool<AgentEventsArgs> = {
    name: "agent_events",
    description: "Drain ordered output events for an agent.",
    parameters: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Agent ID." },
        after_sequence: {
          type: "integer",
          minimum: 0,
          description: "Return events after this sequence.",
        },
        wait_ms: {
          type: "integer",
          minimum: 0,
          maximum: 5000,
          description: "Wait up to this many milliseconds for new events.",
        },
      },
      required: ["agent_id"],
      additionalProperties: false,
    },
    handler: async (args) =>
      json(
        await events.drain({
          agentId: args.agent_id,
          afterSequence: args.after_sequence,
          waitMs: args.wait_ms ?? 0,
        } satisfies Parameters<AgentEventInbox["drain"]>[0]),
      ),
  };

  return [
    codespacesList,
    codespacesStatus,
    codespacesStart,
    codespacesStop,
    agentStart,
    agentSend,
    agentStatus,
    agentStop,
    agentEvents,
  ];
}
