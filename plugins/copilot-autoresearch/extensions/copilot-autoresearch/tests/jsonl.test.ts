import { describe, expect, it } from "vitest";
import {
  extractAutoresearchSessionName,
  hasAutoresearchConfigHeader,
  inferMetricUnit,
  isAutoresearchConfigEntry,
  isAutoresearchRunEntry,
  parseJsonlEntry,
  reconstructJsonlState,
} from "../src/jsonl.ts";

const config = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "config",
    name: "Speed up tests",
    metricName: "total_µs",
    metricUnit: "µs",
    bestDirection: "lower",
    ...extra,
  });

const run = (n: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    run: n,
    commit: `abc${n.toString().padStart(4, "0")}`,
    metric: 1000 - n * 10,
    metrics: { compile_µs: 200 + n },
    status: "keep",
    description: `iter ${n}`,
    timestamp: 1700_000_000_000 + n,
    segment: 0,
    confidence: null,
    ...extra,
  });

describe("parseJsonlEntry", () => {
  it("returns null for non-JSON", () => {
    expect(parseJsonlEntry("not json")).toBeNull();
  });
  it("returns null for non-objects", () => {
    expect(parseJsonlEntry("42")).toBeNull();
    expect(parseJsonlEntry("[1,2]")).toBeNull();
  });
  it("returns the object record otherwise", () => {
    expect(parseJsonlEntry('{"a":1}')).toEqual({ a: 1 });
  });
});

describe("classifiers", () => {
  it("identifies config and run entries", () => {
    expect(isAutoresearchConfigEntry({ type: "config" })).toBe(true);
    expect(isAutoresearchRunEntry({ run: 1 })).toBe(true);
    expect(isAutoresearchRunEntry({ run: "1" })).toBe(false);
  });
});

describe("hasAutoresearchConfigHeader / extractAutoresearchSessionName", () => {
  it("finds the first config entry", () => {
    const content = [config(), run(1)].join("\n");
    expect(hasAutoresearchConfigHeader(content)).toBe(true);
    expect(extractAutoresearchSessionName(content)).toBe("Speed up tests");
  });
  it("returns false / default name when no config header", () => {
    expect(hasAutoresearchConfigHeader(run(1))).toBe(false);
    expect(extractAutoresearchSessionName(run(1))).toBe("Autoresearch");
  });
});

describe("inferMetricUnit", () => {
  it.each([
    ["total_µs", "µs"],
    ["compile_ms", "ms"],
    ["wall_s", "s"],
    ["foo_sec", "s"],
    ["bundle_kb", "kb"],
    ["heap_mb", "mb"],
    ["loss", ""],
  ])("%s → %s", (name, expected) => {
    expect(inferMetricUnit(name)).toBe(expected);
  });
});

describe("reconstructJsonlState", () => {
  it("returns defaults for empty content", () => {
    const state = reconstructJsonlState("");
    expect(state.results).toHaveLength(0);
    expect(state.metricName).toBe("metric");
    expect(state.bestDirection).toBe("lower");
    expect(state.currentSegment).toBe(0);
  });

  it("applies the config header", () => {
    const state = reconstructJsonlState(config());
    expect(state.name).toBe("Speed up tests");
    expect(state.metricName).toBe("total_µs");
    expect(state.metricUnit).toBe("µs");
    expect(state.bestDirection).toBe("lower");
  });

  it("registers secondary metrics in first-seen order", () => {
    const content = [
      config(),
      run(1, { metrics: { compile_µs: 200, render_µs: 300 } }),
      run(2, { metrics: { compile_µs: 195, render_µs: 290 } }),
    ].join("\n");
    const state = reconstructJsonlState(content);
    expect(state.results).toHaveLength(2);
    expect(state.secondaryMetrics.map((m) => m.name)).toEqual([
      "compile_µs",
      "render_µs",
    ]);
    expect(state.secondaryMetrics[0].unit).toBe("µs");
  });

  it("starts a new segment on a re-init config entry, clearing secondary metrics", () => {
    const content = [
      config(),
      run(1, { metrics: { compile_µs: 200 } }),
      config({ name: "Phase 2", metricName: "wall_s", metricUnit: "s" }),
      run(2, { metric: 12, metrics: { mem_mb: 100 }, segment: 1 }),
    ].join("\n");
    const state = reconstructJsonlState(content);
    expect(state.currentSegment).toBe(1);
    expect(state.name).toBe("Phase 2");
    expect(state.metricName).toBe("wall_s");
    // secondary metrics should reflect only segment 1 entries
    expect(state.secondaryMetrics.map((m) => m.name)).toEqual(["mem_mb"]);
    expect(state.results).toHaveLength(2);
    expect(state.results[0].segment).toBe(0);
    expect(state.results[1].segment).toBe(1);
  });

  it("ignores malformed lines and keeps going", () => {
    const content = [config(), "not json", run(1)].join("\n");
    const state = reconstructJsonlState(content);
    expect(state.results).toHaveLength(1);
  });

  it("clamps invalid status to 'keep'", () => {
    const content = [config(), run(1, { status: "bogus" })].join("\n");
    const state = reconstructJsonlState(content);
    expect(state.results[0].status).toBe("keep");
  });
});
