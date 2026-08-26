import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONSECUTIVE_FAILURE_LIMIT,
  MAX_AUTO_RESUME_TURNS,
  countConsecutiveFailures,
  createAutoResumeScheduler,
} from "../src/auto-resume.ts";
import type { ReconstructedRun } from "../src/jsonl.ts";
import { defaultRuntimeState } from "../src/state.ts";

function run(
  runNumber: number,
  status: ReconstructedRun["status"],
  segment = 0,
): ReconstructedRun {
  return {
    run: runNumber,
    commit: "",
    metric: 1,
    metrics: {},
    status,
    description: "",
    timestamp: 0,
    segment,
    confidence: null,
  };
}

describe("auto-resume guards", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("matches upstream guard limits", () => {
    expect(MAX_AUTO_RESUME_TURNS).toBe(200);
    expect(CONSECUTIVE_FAILURE_LIMIT).toBe(20);
  });

  it("counts only trailing discards and crashes in the current segment", () => {
    const results = [
      run(1, "discard"),
      run(2, "keep"),
      run(3, "discard"),
      run(4, "crash"),
      run(5, "checks_failed"),
    ];
    expect(countConsecutiveFailures(results, 0)).toBe(0);
    results.pop();
    expect(countConsecutiveFailures(results, 0)).toBe(2);
  });

  it("stops at a segment boundary", () => {
    const results = [
      run(1, "discard", 0),
      run(2, "crash", 0),
      run(3, "discard", 1),
    ];
    expect(countConsecutiveFailures(results, 1)).toBe(1);
  });

  it("does not treat restored runs as newly logged work", async () => {
    vi.useFakeTimers();
    const runtime = defaultRuntimeState();
    runtime.autoresearchMode = true;
    const send = vi.fn(async () => "message-id");
    let lastLoggedRun = 3;
    const scheduler = createAutoResumeScheduler({
      cwdRef: { get: () => process.cwd(), set: () => undefined },
      runtime,
      session: {
        log: vi.fn(async () => undefined),
        send,
      },
      getLastLoggedRun: () => lastLoggedRun,
    });

    scheduler.onIdle();
    await vi.runAllTimersAsync();
    expect(send).not.toHaveBeenCalled();

    lastLoggedRun = 4;
    scheduler.onIdle();
    await vi.runAllTimersAsync();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("synchronizes disk refreshes without scheduling stale runs", async () => {
    vi.useFakeTimers();
    const runtime = defaultRuntimeState();
    runtime.autoresearchMode = true;
    const send = vi.fn(async () => "message-id");
    let lastLoggedRun = 1;
    const scheduler = createAutoResumeScheduler({
      cwdRef: { get: () => process.cwd(), set: () => undefined },
      runtime,
      session: {
        log: vi.fn(async () => undefined),
        send,
      },
      getLastLoggedRun: () => lastLoggedRun,
    });

    lastLoggedRun = 2;
    scheduler.onIdle();
    scheduler.syncToCurrentRun();
    await vi.runAllTimersAsync();
    expect(send).not.toHaveBeenCalled();
  });
});
