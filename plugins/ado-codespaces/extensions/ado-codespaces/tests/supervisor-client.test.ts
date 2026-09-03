import { describe, expect, it, vi } from "vitest";
import { SupervisorClient, SupervisorRequestError } from "../src/supervisor-client.ts";
import { FakeSupervisor } from "./fake-supervisor.ts";

describe("SupervisorClient", () => {
  it("spawns the supervisor and correlates out-of-order responses", async () => {
    const fake = new FakeSupervisor();
    const client = new SupervisorClient({ spawnFactory: fake.spawn });

    const first = client.request("first", { value: 1 });
    const second = client.request("second", { value: 2 });
    const [firstRequest, secondRequest] = fake.requests();

    expect(fake.spawn).toHaveBeenCalledWith("gh", ["ado-codespaces", "agent", "serve"]);
    fake.send({
      type: "response",
      correlation_id: firstRequest.id,
      result: { ignored: true },
    });
    fake.send({
      type: "response",
      id: firstRequest.id,
      error: { code: "invalid", message: "ignored", data: {} },
    });
    expect(client.pending.size).toBe(2);
    fake.send({
      type: "response",
      id: secondRequest.id,
      result: { order: 2 },
    });
    fake.send({
      type: "response",
      id: firstRequest.id,
      result: { order: 1 },
    });

    await expect(first).resolves.toEqual({ order: 1 });
    await expect(second).resolves.toEqual({ order: 2 });
    expect(client.pending.size).toBe(0);
  });

  it("logs and routes valid events while rejecting malformed boundaries", async () => {
    const fake = new FakeSupervisor();
    const log = vi.fn();
    const client = new SupervisorClient({ spawnFactory: fake.spawn, log });
    const subscriber = vi.fn();
    const unsubscribe = client.subscribe(subscriber);

    fake.stdout.emit("data", '{"type":"event",');
    fake.stdout.emit("data", '"agent_id":"agent-1","sequence":3,"event":{"kind":"message"}}\n');
    fake.send({
      type: "event",
      agent_id: "agent-1",
      sequence: "invalid",
      event: {},
    });
    await Promise.resolve();

    expect(subscriber).toHaveBeenCalledOnce();
    expect(subscriber).toHaveBeenCalledWith({
      type: "event",
      agent_id: "agent-1",
      sequence: 3,
      event: { kind: "message" },
    });
    expect(log).toHaveBeenCalledWith("Supervisor event agent-1#3", "info");
    expect(log).toHaveBeenCalledWith(
      "Ignored invalid supervisor message: message does not match the supervisor protocol",
      "warning",
    );

    unsubscribe();
    fake.send({
      type: "event",
      agent_id: "agent-1",
      sequence: 4,
      event: {},
    });
    expect(subscriber).toHaveBeenCalledOnce();
  });

  it("returns a stable typed error for supervisor failures", async () => {
    const fake = new FakeSupervisor();
    const client = new SupervisorClient({ spawnFactory: fake.spawn });
    const request = client.request("agent_start", {});
    const [{ id }] = fake.requests();

    fake.send({
      type: "response",
      id,
      error: {
        code: "lease_conflict",
        message: "approval required",
        context: { lease_id: "lease-1" },
      },
    });

    await expect(request).rejects.toEqual(
      expect.objectContaining({
        name: "SupervisorRequestError",
        message: "Supervisor request failed: approval required",
        code: "lease_conflict",
        context: { lease_id: "lease-1" },
      }),
    );
    await expect(request).rejects.toBeInstanceOf(SupervisorRequestError);
  });

  it("rejects writes that fail and leaves no pending request", async () => {
    const fake = new FakeSupervisor();
    fake.process.stdin.write = () => {
      throw new Error("broken pipe");
    };
    const client = new SupervisorClient({ spawnFactory: fake.spawn });

    await expect(client.request("codespaces.list", {})).rejects.toThrow(
      "Supervisor request could not be sent: broken pipe",
    );
    expect(client.pending.size).toBe(0);
  });

  it("handles asynchronous stdin failures", async () => {
    const fake = new FakeSupervisor();
    const client = new SupervisorClient({ spawnFactory: fake.spawn });
    const request = client.request("codespaces.list", {});

    fake.stdinEvents.emit("error", new Error("EPIPE"));

    await expect(request).rejects.toThrow("Supervisor stdin failed: EPIPE");
    expect(fake.end).toHaveBeenCalledOnce();
    expect(fake.kill).toHaveBeenCalledOnce();
  });

  it("surfaces an unavailable supervisor executable", async () => {
    const fake = new FakeSupervisor();
    const client = new SupervisorClient({ spawnFactory: fake.spawn });

    fake.processEvents.emit("error", new Error("spawn gh ENOENT"));

    await expect(client.request("codespaces.list", {})).rejects.toThrow(
      "Supervisor process failed: spawn gh ENOENT",
    );
    await expect(client.shutdown()).resolves.toBeUndefined();
    expect(fake.end).toHaveBeenCalledOnce();
    expect(fake.kill).toHaveBeenCalledOnce();
  });

  it("cleans up when the shutdown write fails", async () => {
    const fake = new FakeSupervisor();
    fake.process.stdin.write = () => {
      throw new Error("broken pipe");
    };
    const client = new SupervisorClient({ spawnFactory: fake.spawn });

    await expect(client.shutdown()).resolves.toBeUndefined();
    expect(fake.end).toHaveBeenCalledOnce();
    expect(fake.kill).toHaveBeenCalledOnce();
  });

  it("rejects every pending request when the child exits", async () => {
    const fake = new FakeSupervisor();
    const client = new SupervisorClient({ spawnFactory: fake.spawn });
    const first = client.request("first", {});
    const second = client.request("second", {});
    const expected = "Supervisor exited before responding (code=17, signal=null)";
    const rejections = [
      expect(first).rejects.toThrow(expected),
      expect(second).rejects.toThrow(expected),
    ];

    fake.processEvents.emit("exit", 17, null);

    await Promise.all(rejections);
    expect(client.pending.size).toBe(0);
  });

  it("requests shutdown before cleaning up the child and is idempotent", async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeSupervisor();
      const client = new SupervisorClient({ spawnFactory: fake.spawn });

      const shutdown = client.shutdown();
      expect(fake.requests()).toEqual([{ id: "1", method: "shutdown", params: {} }]);
      expect(fake.end).not.toHaveBeenCalled();
      expect(fake.kill).not.toHaveBeenCalled();

      fake.send({ type: "response", id: "1", result: null });
      await shutdown;
      await client.shutdown();

      expect(vi.getTimerCount()).toBe(0);
      expect(fake.end).toHaveBeenCalledOnce();
      expect(fake.kill).toHaveBeenCalledOnce();
      expect(fake.requests()).toHaveLength(1);
      await expect(client.request("late", {})).rejects.toThrow(
        "Supervisor is not accepting requests",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows the supervisor cleanup window before forcing termination", async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeSupervisor();
      const client = new SupervisorClient({ spawnFactory: fake.spawn });

      const shutdown = client.shutdown();
      await vi.advanceTimersByTimeAsync(11_999);
      expect(fake.kill).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await shutdown;
      expect(fake.kill).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
