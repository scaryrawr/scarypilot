import { describe, expect, it } from "vitest";
import { isAutoresearchShCommand, parseMetricLines } from "../src/metric.ts";

describe("parseMetricLines", () => {
  it("parses basic METRIC lines", () => {
    const out = `
some chatter
METRIC total_µs=15200
METRIC compile_µs=4200
end
`;
    const m = parseMetricLines(out);
    expect(m.size).toBe(2);
    expect(m.get("total_µs")).toBe(15200);
    expect(m.get("compile_µs")).toBe(4200);
  });

  it("rejects prototype pollution names", () => {
    const m = parseMetricLines("METRIC __proto__=1\nMETRIC constructor=2\nMETRIC ok=3\n");
    expect(m.has("__proto__")).toBe(false);
    expect(m.has("constructor")).toBe(false);
    expect(m.get("ok")).toBe(3);
  });

  it("rejects non-finite values", () => {
    const m = parseMetricLines("METRIC a=Infinity\nMETRIC b=NaN\nMETRIC c=10\n");
    expect(m.has("a")).toBe(false);
    expect(m.has("b")).toBe(false);
    expect(m.get("c")).toBe(10);
  });

  it("last duplicate wins", () => {
    const m = parseMetricLines("METRIC a=1\nMETRIC a=2\n");
    expect(m.get("a")).toBe(2);
  });

  it("returns empty when no METRIC lines", () => {
    expect(parseMetricLines("hello\nworld\n").size).toBe(0);
  });
});

describe("isAutoresearchShCommand", () => {
  it.each([
    ["autoresearch.sh", true],
    ["./autoresearch.sh", true],
    ["bash autoresearch.sh", true],
    ["bash -e autoresearch.sh", true],
    ["sh autoresearch.sh arg1", true],
    ["FOO=bar BAZ=qux autoresearch.sh", true],
    ["env time nice autoresearch.sh", true],
    ["nice -n 10 autoresearch.sh", true],
    [".auto/measure.sh", true],
    ["./.auto/measure.sh", true],
    ["bash .auto/measure.sh", true],
    ["pnpm test", false],
    ["evil.py; autoresearch.sh", false],
    // Chained commands are rejected — the gate must mean "only autoresearch.sh runs".
    ["autoresearch.sh && rm -rf /", false],
    ["autoresearch.sh ; evil", false],
    ["autoresearch.sh | tee log", false],
    ["autoresearch.sh & disown", false],
    ["autoresearch.sh `evil`", false],
    ["autoresearch.sh $(evil)", false],
    ["echo $(autoresearch.sh)", false],
    ["other-autoresearch.sh", false],
  ])("%s → %s", (cmd, expected) => {
    expect(isAutoresearchShCommand(cmd)).toBe(expected);
  });
});
