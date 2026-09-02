import { describe, expect, it } from "vitest";
import { AgentEventInbox } from "../src/agent-event-inbox.ts";

function event(agentId: string, sequence: number, value: string) {
  return { type: "event" as const, agent_id: agentId, sequence, event: { value } };
}

describe("AgentEventInbox", () => {
  it("drains each agent independently in sequence order", async () => {
    const inbox = new AgentEventInbox();
    inbox.add(event("agent-1", 2, "second"));
    inbox.add(event("agent-2", 1, "other"));
    inbox.add(event("agent-1", 1, "first"));

    await expect(inbox.drain({ agentId: "agent-1", waitMs: 0 })).resolves.toMatchObject({
      agent_id: "agent-1",
      events: [{ sequence: 1 }, { sequence: 2 }],
      dropped: null,
    });
    await expect(inbox.drain({ agentId: "agent-2", waitMs: 0 })).resolves.toMatchObject({
      agent_id: "agent-2",
      events: [{ sequence: 1 }],
      dropped: null,
    });
  });

  it("filters acknowledged events and drains each event once", async () => {
    const inbox = new AgentEventInbox();
    inbox.add(event("agent-1", 1, "old"));
    inbox.add(event("agent-1", 2, "new"));

    await expect(
      inbox.drain({ agentId: "agent-1", afterSequence: 1, waitMs: 0 }),
    ).resolves.toMatchObject({ events: [{ sequence: 2 }] });
    await expect(
      inbox.drain({ agentId: "agent-1", afterSequence: 1, waitMs: 0 }),
    ).resolves.toMatchObject({ events: [] });
  });

  it("waits for a matching event and wakes without logging its content", async () => {
    const inbox = new AgentEventInbox();
    const drained = inbox.drain({ agentId: "agent-1", afterSequence: 2, waitMs: 100 });

    inbox.add(event("agent-1", 3, "remote output"));

    await expect(drained).resolves.toMatchObject({
      events: [{ sequence: 3, event: { value: "remote output" } }],
    });
  });

  it("reports dropped events when the bounded buffer overflows", async () => {
    const inbox = new AgentEventInbox(2);
    inbox.add(event("agent-1", 1, "first"));
    inbox.add(event("agent-1", 2, "second"));
    inbox.add(event("agent-1", 3, "third"));

    await expect(inbox.drain({ agentId: "agent-1", waitMs: 0 })).resolves.toMatchObject({
      events: [{ sequence: 2 }, { sequence: 3 }],
      dropped: { count: 1, first_sequence: 1, last_sequence: 1 },
    });
  });

  it("reports the full dropped sequence range for out-of-order events", async () => {
    const inbox = new AgentEventInbox(2);
    inbox.add(event("agent-1", 100, "first"));
    inbox.add(event("agent-1", 101, "second"));
    inbox.add(event("agent-1", 1, "third"));
    inbox.add(event("agent-1", 0, "fourth"));

    await expect(inbox.drain({ agentId: "agent-1", waitMs: 0 })).resolves.toMatchObject({
      events: [{ sequence: 100 }, { sequence: 101 }],
      dropped: { count: 2, first_sequence: 0, last_sequence: 1 },
    });
  });

  it("releases waiters when the session closes", async () => {
    const inbox = new AgentEventInbox();
    const drained = inbox.drain({ agentId: "agent-1", waitMs: 100 });

    inbox.close();

    await expect(drained).resolves.toMatchObject({ events: [], dropped: null });
  });
});
