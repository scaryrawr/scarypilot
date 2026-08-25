import { describe, expect, it } from "vitest";
import { buildDashboardHtml } from "../src/dashboard.ts";

const fixture = [
  JSON.stringify({
    type: "config",
    name: "Speed up tests",
    metricName: "total_µs",
    metricUnit: "µs",
    bestDirection: "lower",
  }),
  JSON.stringify({
    run: 1,
    commit: "aaaaaaa",
    metric: 1000,
    metrics: { compile_µs: 200 },
    status: "keep",
    description: "baseline",
    timestamp: 1,
    segment: 0,
    confidence: null,
  }),
  JSON.stringify({
    run: 2,
    commit: "bbbbbbb",
    metric: 900,
    metrics: { compile_µs: 190 },
    status: "keep",
    description: "switch hashmap to array",
    timestamp: 2,
    segment: 0,
    confidence: null,
  }),
  JSON.stringify({
    run: 3,
    commit: "ccccccc",
    metric: 950,
    metrics: { compile_µs: 198 },
    status: "discard",
    description: "loop unroll regressed",
    timestamp: 3,
    segment: 0,
    confidence: null,
  }),
].join("\n");

describe("buildDashboardHtml", () => {
  it("includes the session name and primary metric", () => {
    const html = buildDashboardHtml(fixture);
    expect(html).toContain("Speed up tests");
    expect(html).toContain("total_µs");
    expect(html).toContain("lower is better");
  });

  it("renders all runs with their statuses", () => {
    const html = buildDashboardHtml(fixture);
    expect(html).toContain("baseline");
    expect(html).toContain("switch hashmap to array");
    expect(html).toContain("loop unroll regressed");
    expect(html).toContain("status-keep");
    expect(html).toContain("status-discard");
  });

  it("renders the secondary metric column", () => {
    const html = buildDashboardHtml(fixture);
    expect(html).toContain(">compile_µs<");
  });

  it("escapes HTML in user-controlled fields", () => {
    const evil = [
      JSON.stringify({
        type: "config",
        name: "<script>alert(1)</script>",
        metricName: "m",
        metricUnit: "",
        bestDirection: "lower",
      }),
      JSON.stringify({
        run: 1,
        commit: "z",
        metric: 1,
        metrics: {},
        status: "keep",
        description: '"><img src=x onerror=alert(1)>',
        timestamp: 0,
        segment: 0,
        confidence: null,
      }),
    ].join("\n");
    const html = buildDashboardHtml(evil);
    // Tag opening characters must be escaped so the browser sees inert text.
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain('"><img src=x');
    expect(html).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
  });

  it("handles empty input gracefully", () => {
    const html = buildDashboardHtml("");
    expect(html).toContain("No experiments yet");
  });

  it("adds event-driven updates and a trend chart for the live browser dashboard", () => {
    const html = buildDashboardHtml(fixture, { liveUpdates: true });
    expect(html).toContain('new EventSource("/events")');
    expect(html).toContain("Live dashboard");
    expect(html).toContain("Metric trend");
    expect(html).toContain("<polyline");
  });
});
