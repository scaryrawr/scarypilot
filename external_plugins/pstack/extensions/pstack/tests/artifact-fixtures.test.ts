import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createCwdRef } from "../src/extension-context.ts";
import { createValidateArtifactTool } from "../src/tools/validate-artifact.ts";

const cwd = resolve(import.meta.dirname, "..");

const context = { sessionId: "test", toolCallId: "test", toolName: "pstack_validate_artifact", arguments: {} };

describe("retained safe host fixtures", () => {
  it.each([
    ["snapshot", "snapshot-valid.json", []],
    ["snapshot", "snapshot-invalid.json", [
      { path: "$.schemaVersion", rule: "schema-version", message: "expected 1" },
    ]],
    ["receipt", "receipt-valid.json", []],
    ["receipt", "receipt-invalid.json", [
      { path: "$.evidence[0].digest", rule: "string", message: "expected string" },
    ]],
    ["handoff", "handoff-valid.json", []],
    ["handoff", "handoff-invalid.json", [
      { path: "$.snapshot.snapshotHash", rule: "snapshot-hash", message: "expected 64 lowercase hex characters" },
    ]],
  ] as const)("validates the retained %s fixture %s", async (kind, name, findings) => {
    const path = `tests/fixtures/${name}`;
    const tool = createValidateArtifactTool(createCwdRef(cwd));
    expect(JSON.parse(String(await tool.handler({ kind, path }, context)))).toEqual({
      kind, path: await realpath(resolve(cwd, path)),
      schemaVersion: 1, ok: findings.length === 0, findings,
    });
  });

  it("validates retained plan fixtures with basic and default verified-stack profiles", async () => {
    const tool = createValidateArtifactTool(createCwdRef(cwd));
    const basic = "tests/fixtures/plan-basic-valid.md";
    expect(JSON.parse(String(await tool.handler({ kind: "plan", path: basic, profile: "basic" }, context)))).toEqual({
      kind: "plan", path: await realpath(resolve(cwd, basic)),
      profile: "basic", ok: true, findings: [], report: ["1 checklist boxes"],
    });
    const verified = "tests/fixtures/plan-verified-stack-valid.md";
    expect(JSON.parse(String(await tool.handler({ kind: "plan", path: verified }, context)))).toEqual({
      kind: "plan", path: await realpath(resolve(cwd, verified)),
      profile: "verified-stack", ok: true, findings: [],
      report: [
        "PR fixture  boxes=10  files=1 build=1 you-see=1 verify-unit=1 verify-live=1 verify-perf=4 review-gate=0 merge=1",
        "1 PR sections",
      ],
    });
    const invalid = "tests/fixtures/plan-invalid.md";
    expect(JSON.parse(String(await tool.handler({ kind: "plan", path: invalid, profile: "basic" }, context)))).toEqual({
      kind: "plan", path: await realpath(resolve(cwd, invalid)),
      profile: "basic", ok: false,
      findings: [
        { line: 1, rule: "h1", message: "no H1 title" },
        { line: 1, rule: "checklist", message: "no checklist boxes" },
      ],
      report: ["0 checklist boxes"],
    });
  });
});
