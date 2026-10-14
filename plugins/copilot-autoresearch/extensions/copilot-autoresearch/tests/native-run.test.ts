import { describe, expect, it, vi } from "vitest";
import { createNativeRun, NativeAddon } from "../src/native-run.ts";
import type { Static } from "@sinclair/typebox";

function fixture() {
  const control = {
    read: vi.fn<(channel: number) => void>(), write: vi.fn<(bytes: Uint8Array) => void>(),
    endInput: vi.fn<() => void>(), stop: vi.fn<() => void>(), discard: vi.fn<() => void>(),
  };

  const notify = vi.fn<Parameters<Static<typeof NativeAddon>["begin"]>[1]>();

  const api: Static<typeof NativeAddon> = {
    nodeApiVersion: 8, protocolVersion: 2,
    begin: (_spec, callback) => { notify.mockImplementation(callback);

 return control; },
  };

  const run = createNativeRun(api, { executable: "bash", argv: [], cwd: "", env: [], path: "", input: true, cancelled: false });
  void run.started.catch(() => {});
  void run.closed.catch(() => {});

  return { run, control, notify };
}

describe("JS-owned native promises", () => {
  it("returns each credit only after its native notification", async () => {
    const { run, control, notify } = fixture();
    const read = run.read(1);
    const write = run.write(Buffer.from("input"));
    expect(() => run.read(1)).toThrow(expect.objectContaining({ stage: "OutstandingIoCredit" }));
    expect(() => run.endInput()).toThrow(expect.objectContaining({ stage: "OutstandingIoCredit" }));
    notify({ kind: "started", pid: 123 });
    notify({ kind: "io", channel: 1, data: Buffer.from("output") });
    notify({ kind: "io", channel: 0 });
    await expect(read).resolves.toEqual(Buffer.from("output"));
    await expect(write).resolves.toBeUndefined();
    await expect(run.started).resolves.toBe(123);
    const eof = run.endInput();
    notify({ kind: "io", channel: 0 });
    await eof;
    expect(control.endInput).toHaveBeenCalledOnce();
    notify({ kind: "closed", result: { exitCode: 23, killed: false } });
    await expect(run.closed).resolves.toEqual({ exitCode: 23, killed: false });
  });

  it("settles all outstanding credits exactly once when native cleanup completes", async () => {
    const { run, notify } = fixture();
    const pending = [run.read(1), run.read(2), run.write(Buffer.alloc(65536))];
    notify({ kind: "closed", result: { exitCode: null, killed: true } });
    notify({ kind: "io", channel: 1, data: Buffer.from("late") });
    await expect(Promise.all(pending)).resolves.toEqual([null, null, undefined]);
    await expect(run.started).resolves.toBeNull();
    await expect(run.read(1)).resolves.toBeNull();
    await expect(run.endInput()).resolves.toBeUndefined();
  });

  it("preserves native failure identity and recovery details on every pending receipt", async () => {
    const { run, notify } = fixture();
    const failure = Object.assign(new Error("cleanup failed"), { stage: "IoCleanupUnconfirmed", win32Code: 5, pid: 123, cleanupStage: "StopJob" });
    const pending = [run.started, run.closed, run.read(1), run.read(2), run.endInput()];
    const observed = Promise.allSettled(pending);
    notify({ kind: "failed", error: failure });
    const results = await observed;
    expect(results).toEqual(pending.map(() => ({ status: "rejected", reason: failure })));
    await expect(run.read(1)).rejects.toBe(failure);
  });

  it("clears a rejected synchronous native request without stranding its credit", async () => {
    const { run, control, notify } = fixture();
    control.write.mockImplementationOnce(() => { throw new Error("BoundedInputChunk"); });
    expect(() => run.write(Buffer.alloc(65537))).toThrow("BoundedInputChunk");
    const write = run.write(Buffer.from("valid"));
    notify({ kind: "io", channel: 0 });
    await write;
    notify({ kind: "closed", result: { exitCode: 0, killed: false } });
  });

  it("fails closed on malformed native notifications and explicitly requests discard", async () => {
    const { run, control, notify } = fixture();
    const read = run.read(1);
    const observed = Promise.allSettled([run.started, run.closed, read]);
    notify({ kind: "started", pid: "not a PID" });
    const results = await observed;
    expect(control.discard).toHaveBeenCalledOnce();

    for (const result of results) {
      expect(result).toMatchObject({ status: "rejected", reason: { message: expect.stringContaining("ownership cleanup is unconfirmed") } });
    }
  });
});
