import { describe, expect, it, vi } from "vitest";
import type { Tool, ToolInvocation } from "@github/copilot-sdk";
import { createSupervisorTools, type SupervisorRequester } from "../src/tools.ts";
import type { AgentEventsRequest } from "../src/agent-event-inbox.ts";

const invocation: ToolInvocation = {
  sessionId: "test",
  toolCallId: "test",
  toolName: "test",
  arguments: {},
};

describe("supervisor tools", () => {
  it("forwards every tool with compact JSON results", async () => {
    const request = vi.fn(async (method: string, params: object) => ({
      method,
      params,
    }));
    const supervisor: SupervisorRequester = { request };
    const events = {
      drain: vi.fn(async (input: AgentEventsRequest) => ({
        agent_id: input.agentId,
        events: [],
        dropped: null,
      })),
    };
    const tools = createSupervisorTools(supervisor, events);
    const cases = [
      ["codespaces_list", "codespaces.list", {}, {}],
      ["codespaces_status", "codespaces.status", { codespace: "cs" }, { codespace: "cs" }],
      ["codespaces_start", "codespaces.start", { codespace: "cs" }, { codespace: "cs" }],
      ["codespaces_stop", "codespaces.stop", { codespace: "cs" }, { codespace: "cs" }],
      [
        "agent_start",
        "agent.start",
        {
          codespace: "cs",
          agent_id: "agent-1",
          working_directory: "/work",
          approve_all_permissions: true,
        },
        {
          codespace: "cs",
          agent_id: "agent-1",
          working_directory: "/work",
          approve_all_permissions: true,
        },
      ],
      [
        "agent_send",
        "agent.send",
        { agent_id: "agent-1", prompt: "continue" },
        { agent_id: "agent-1", prompt: "continue" },
      ],
      ["agent_status", "agent.status", { agent_id: "agent-1" }, { agent_id: "agent-1" }],
      ["agent_stop", "agent.stop", { agent_id: "agent-1" }, { agent_id: "agent-1" }],
    ] as const;

    for (const [name, method, args, expectedParams] of cases) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool, `${name} is registered`).toBeDefined();
      const typedTool = tool as unknown as Tool<Record<string, unknown>>;
      if (!typedTool.handler) throw new Error(`${name} must define a handler`);
      const output = await typedTool.handler(args, invocation);
      if (typeof output !== "string") {
        throw new Error(`${name} must return JSON text`);
      }
      expect(JSON.parse(output)).toEqual({
        method,
        params: expectedParams,
      });
      expect(request).toHaveBeenLastCalledWith(method, expectedParams);
    }
  });

  it("does not forward permission approval unless explicitly supplied", async () => {
    const request = vi.fn(async () => ({}));
    const events = {
      drain: vi.fn(async (_input: AgentEventsRequest) => ({
        agent_id: "agent-1",
        events: [],
        dropped: null,
      })),
    };
    const tools = createSupervisorTools({ request }, events);
    const tool = tools.find((candidate) => candidate.name === "agent_start");
    const typedTool = tool as unknown as Tool<Record<string, unknown>>;
    if (!typedTool.handler) throw new Error("agent_start must define a handler");

    await typedTool.handler(
      {
        codespace: "cs",
        agent_id: "agent-1",
      },
      invocation,
    );

    expect(request).toHaveBeenCalledWith("agent.start", {
      codespace: "cs",
      agent_id: "agent-1",
    });
  });

  it("uses the exact Go protocol fields for agent start and send", () => {
    const events = {
      drain: vi.fn(async (_input: AgentEventsRequest) => ({
        agent_id: "agent-1",
        events: [],
        dropped: null,
      })),
    };
    const tools = createSupervisorTools({ request: vi.fn(async () => ({})) }, events);
    const start = tools.find((tool) => tool.name === "agent_start");
    const send = tools.find((tool) => tool.name === "agent_send");

    expect(start?.parameters).toMatchObject({
      properties: {
        agent_id: { type: "string" },
        codespace: { type: "string" },
        working_directory: { type: "string" },
      },
      required: ["codespace", "agent_id"],
    });
    expect(start?.parameters).not.toMatchObject({
      properties: { prompt: expect.anything() },
    });
    expect(send?.parameters).toMatchObject({
      properties: { agent_id: { type: "string" }, prompt: { type: "string" } },
      required: ["agent_id", "prompt"],
    });
    expect(send?.parameters).not.toMatchObject({
      properties: { message: expect.anything() },
    });
  });

  it("drains local ordered events without forwarding an RPC", async () => {
    const request = vi.fn(async () => ({}));
    const drain = vi.fn(async (input: AgentEventsRequest) => ({
      agent_id: input.agentId,
      events: [],
      dropped: null,
      afterSequence: input.afterSequence,
      waitMs: input.waitMs,
    }));
    const tools = createSupervisorTools({ request }, { drain });
    const tool = tools.find((candidate) => candidate.name === "agent_events");
    const typedTool = tool as unknown as Tool<Record<string, unknown>>;
    if (!typedTool.handler) throw new Error("agent_events must define a handler");

    const output = await typedTool.handler(
      { agent_id: "agent-1", after_sequence: 4, wait_ms: 10 },
      invocation,
    );

    expect(JSON.parse(output as string)).toEqual({
      agent_id: "agent-1",
      events: [],
      dropped: null,
      afterSequence: 4,
      waitMs: 10,
    });
    expect(drain).toHaveBeenCalledWith({
      agentId: "agent-1",
      afterSequence: 4,
      waitMs: 10,
    });
    expect(request).not.toHaveBeenCalled();
  });
});
