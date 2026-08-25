import { describe, expect, it } from "vitest";
import { computeConfidence, findBaselineMetric, findBaselineSecondary, findBestMetric, isBetter, sortedMedian } from "../src/confidence.ts";
import type { ReconstructedRun } from "../src/jsonl.ts";

const run = (overrides: Partial<ReconstructedRun> = {}): ReconstructedRun => ({
  run: 1,
  commit: "abc1234",
  metric: 100,
  metrics: {},
  status: "keep",
  description: "",
  timestamp: 0,
  segment: 0,
  confidence: null,
  ...overrides,
});

describe("sortedMedian", () => {
  it("handles empty arrays", () => {
    expect(sortedMedian([])).toBe(0);
  });
  it("handles odd-length arrays", () => {
    expect(sortedMedian([3, 1, 2])).toBe(2);
  });
  it("averages middle for even-length arrays", () => {
    expect(sortedMedian([1, 2, 3, 4])).toBe(2.5);
  });
});

describe("isBetter", () => {
  it("respects direction", () => {
    expect(isBetter(90, 100, "lower")).toBe(true);
    expect(isBetter(110, 100, "lower")).toBe(false);
    expect(isBetter(110, 100, "higher")).toBe(true);
    expect(isBetter(90, 100, "higher")).toBe(false);
  });
});

describe("findBaselineMetric / findBestMetric", () => {
  it("baseline is the first run in the segment", () => {
    const results = [
      run({ run: 1, metric: 100 }),
      run({ run: 2, metric: 90, status: "keep" }),
      run({ run: 3, metric: 95, status: "discard" }),
    ];
    expect(findBaselineMetric(results, 0)).toBe(100);
    expect(findBestMetric(results, 0, "lower")).toBe(90);
  });
  it("returns null when there are no kept runs", () => {
    const results = [run({ status: "discard" }), run({ run: 2, status: "crash" })];
    expect(findBestMetric(results, 0, "lower")).toBeNull();
  });
});

describe("computeConfidence", () => {
  it("returns null with fewer than 3 runs", () => {
    const results = [run({ metric: 100 }), run({ run: 2, metric: 90, status: "keep" })];
    expect(computeConfidence(results, 0, "lower")).toBeNull();
  });
  it("returns null when MAD is 0 (all values identical)", () => {
    const results = [
      run({ run: 1, metric: 100 }),
      run({ run: 2, metric: 100, status: "keep" }),
      run({ run: 3, metric: 100, status: "keep" }),
    ];
    expect(computeConfidence(results, 0, "lower")).toBeNull();
  });
  it("returns improvement / MAD when there's a kept improvement", () => {
    const results = [
      run({ run: 1, metric: 100 }),
      run({ run: 2, metric: 95, status: "keep" }),
      run({ run: 3, metric: 90, status: "keep" }),
      run({ run: 4, metric: 80, status: "keep" }),
    ];
    // values [100, 95, 90, 80]; median 92.5; deviations [7.5, 2.5, 2.5, 12.5]; MAD = 5
    // baseline=100; bestKept=80; delta=20; confidence=20/5 = 4
    expect(computeConfidence(results, 0, "lower")).toBeCloseTo(4, 3);
  });
});

describe("findBaselineSecondary", () => {
  it("returns the baseline run's metrics when present", () => {
    const results = [
      run({ run: 1, metrics: { compile_µs: 200, render_µs: 300 } }),
      run({ run: 2, metrics: { compile_µs: 195, render_µs: 290 } }),
    ];
    expect(findBaselineSecondary(results, 0)).toEqual({ compile_µs: 200, render_µs: 300 });
  });

  it("falls back to first occurrence for metrics missing in the baseline run", () => {
    const results = [
      run({ run: 1, metrics: { compile_µs: 200 } }),
      run({ run: 2, metrics: { compile_µs: 195, mem_mb: 50 } }),
      run({ run: 3, metrics: { compile_µs: 190, mem_mb: 48 } }),
    ];
    const baseline = findBaselineSecondary(results, 0, [
      { name: "compile_µs" },
      { name: "mem_mb" },
    ]);
    expect(baseline.compile_µs).toBe(200);
    expect(baseline.mem_mb).toBe(50);
  });

  it("only considers runs in the requested segment for fallback", () => {
    const results = [
      run({ run: 1, segment: 0, metrics: { compile_µs: 200 } }),
      run({ run: 2, segment: 1, metrics: { compile_µs: 100, mem_mb: 999 } }),
    ];
    const baseline = findBaselineSecondary(results, 0, [
      { name: "compile_µs" },
      { name: "mem_mb" },
    ]);
    expect(baseline.compile_µs).toBe(200);
    expect(baseline.mem_mb).toBeUndefined();
  });

  it("returns empty object when there are no runs in the segment", () => {
    expect(findBaselineSecondary([], 0)).toEqual({});
  });
});
