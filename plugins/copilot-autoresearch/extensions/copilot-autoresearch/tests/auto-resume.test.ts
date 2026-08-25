import { describe, expect, it } from "vitest";
import {
  CONSECUTIVE_FAILURE_LIMIT,
  MAX_AUTO_RESUME_TURNS,
  countConsecutiveFailures,
} from "../src/auto-resume.ts";
import type { ReconstructedRun } from "../src/jsonl.ts";

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
});
