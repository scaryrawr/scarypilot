import { execFile } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateArtifact } from "../../../skills/pstack-schema-validate/scripts/artifact-rules.mjs";
import { createCwdRef } from "../src/extension-context.ts";
import { createPstackExtensionRegistration } from "../src/register.ts";
import { createPstackService } from "../src/service.ts";
import { createValidateArtifactTool } from "../src/tools/validate-artifact.ts";
import { createValidatePlanTool } from "../src/tools/validate-plan.ts";

const execFileAsync = promisify(execFile);

const script = resolve(import.meta.dirname, "../../../skills/pstack-schema-validate/scripts/validate.mjs");

const directories: string[] = [];

const context = { sessionId: "test", toolCallId: "test", toolName: "pstack_validate_artifact", arguments: {} };

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace() {
  const path = await mkdtemp(join(tmpdir(), "pstack-artifact-"));
  directories.push(path);

  return realpath(path);
}

const snapshot = {
  schemaVersion: 1,
  snapshotHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  capabilities: {},
  sources: [],
  orch: null,
  watch: [],
  worktrees: null,
  handoff: null,
  now: [],
  sourceWarnings: [],
};

const receipt = {
  schemaVersion: 1,
  receiptId: "0123456789abcdef0123",
  pr: 7,
  sha: "head",
  verdict: "unit-test-verified",
  verifier: "test",
  summary: "passed",
  evidence: [
    { kind: "file", value: "../../not-readable.txt", digest: "" },
    { kind: "command", value: "do not execute" },
    { kind: "link", value: "https://example.invalid" },
    { kind: "note", value: "proof", digest: "optional" },
  ],
  createdAt: "2026-10-01T21:00:00-04:00",
  supersedesReceiptId: "abcdef0123456789abcd",
};

const handoff = {
  schemaVersion: 1,
  sessionId: "session",
  createdAt: "2026-10-02T01:00:00.000Z",
  intent: "validate",
  progress: "ready",
  nextAction: "read",
  keyFiles: ["../../missing", ""],
  snapshot,
};

describe("published artifact authority", () => {
  it.each([
    ["snapshot", snapshot],
    ["receipt", receipt],
    ["handoff", handoff],
  ] as const)("accepts a hand-authored %s without reading references", (kind, value) => {
    expect(validateArtifact(kind, value)).toEqual({ schemaVersion: 1, ok: true, findings: [] });
  });

  it("reports every snapshot check in published order", () => {
    expect(validateArtifact("snapshot", {
      schemaVersion: 2, snapshotHash: "ABC", capabilities: [], sources: {}, watch: null,
      now: 0, sourceWarnings: "", orch: [], worktrees: false, handoff: "bad", extra: true,
    })).toEqual({
      schemaVersion: 1,
      ok: false,
      findings: [
        { path: "$.extra", rule: "exact-keys", message: "unexpected property" },
        { path: "$.schemaVersion", rule: "schema-version", message: "expected 1" },
        { path: "$.snapshotHash", rule: "snapshot-hash", message: "expected 64 lowercase hex characters" },
        { path: "$.capabilities", rule: "object", message: "expected object" },
        { path: "$.sources", rule: "array", message: "expected array" },
        { path: "$.watch", rule: "array", message: "expected array" },
        { path: "$.now", rule: "array", message: "expected array" },
        { path: "$.sourceWarnings", rule: "array", message: "expected array" },
        { path: "$.orch", rule: "object", message: "expected object" },
        { path: "$.worktrees", rule: "object", message: "expected object" },
        { path: "$.handoff", rule: "object", message: "expected object" },
      ],
    });
  });

  it("reports receipt field and nested evidence violations exactly", () => {
    expect(validateArtifact("receipt", {
      schemaVersion: 0, receiptId: "BAD", pr: 0.5, sha: "", verifier: null, summary: 1,
      createdAt: "", supersedesReceiptId: "bad", verdict: "passed",
      evidence: [null, { kind: "bad", value: "", digest: 3, extra: true }], extra: true,
    }).findings).toEqual([
      { path: "$.extra", rule: "exact-keys", message: "unexpected property" },
      { path: "$.schemaVersion", rule: "schema-version", message: "expected 1" },
      { path: "$.receiptId", rule: "receipt-id", message: "expected 20 lowercase hex characters" },
      { path: "$.pr", rule: "positive-integer", message: "expected positive integer" },
      { path: "$.sha", rule: "non-empty-string", message: "expected non-empty string" },
      { path: "$.verifier", rule: "non-empty-string", message: "expected non-empty string" },
      { path: "$.summary", rule: "non-empty-string", message: "expected non-empty string" },
      { path: "$.createdAt", rule: "non-empty-string", message: "expected non-empty string" },
      { path: "$.createdAt", rule: "date-time", message: "expected date-time" },
      { path: "$.supersedesReceiptId", rule: "receipt-id", message: "expected 20 lowercase hex characters" },
      { path: "$.verdict", rule: "verdict", message: "unsupported verdict" },
      { path: "$.evidence[0]", rule: "object", message: "expected object" },
      { path: "$.evidence[1].extra", rule: "exact-keys", message: "unexpected property" },
      { path: "$.evidence[1].kind", rule: "evidence-kind", message: "unsupported kind" },
      { path: "$.evidence[1].value", rule: "non-empty-string", message: "expected non-empty string" },
      { path: "$.evidence[1].digest", rule: "string", message: "expected string" },
    ]);
  });

  it.each([[], null, {}])("rejects empty or non-array evidence %j", (evidence) => {
    expect(validateArtifact("receipt", { ...receipt, evidence }).findings).toEqual([
      { path: "$.evidence", rule: "non-empty-array", message: "expected non-empty array" },
    ]);
  });

  it("reports handoff and nested snapshot violations with rooted paths", () => {
    expect(validateArtifact("handoff", {
      ...handoff, schemaVersion: 2, sessionId: "", intent: 0, progress: null,
      nextAction: "", createdAt: "yesterday", keyFiles: [3], extra: true,
      snapshot: { ...snapshot, capabilities: null, watch: {}, extra: true },
    }).findings).toEqual([
      { path: "$.extra", rule: "exact-keys", message: "unexpected property" },
      { path: "$.schemaVersion", rule: "schema-version", message: "expected 1" },
      { path: "$.sessionId", rule: "non-empty-string", message: "expected non-empty string" },
      { path: "$.intent", rule: "non-empty-string", message: "expected non-empty string" },
      { path: "$.progress", rule: "non-empty-string", message: "expected non-empty string" },
      { path: "$.nextAction", rule: "non-empty-string", message: "expected non-empty string" },
      { path: "$.createdAt", rule: "date-time", message: "expected date-time" },
      { path: "$.keyFiles[0]", rule: "string", message: "expected string" },
      { path: "$.snapshot.extra", rule: "exact-keys", message: "unexpected property" },
      { path: "$.snapshot.capabilities", rule: "object", message: "expected object" },
      { path: "$.snapshot.watch", rule: "array", message: "expected array" },
    ]);
    expect(validateArtifact("handoff", { ...handoff, keyFiles: null, snapshot: null }).findings).toEqual([
      { path: "$.keyFiles", rule: "array", message: "expected array" },
      { path: "$.snapshot", rule: "object", message: "expected object" },
    ]);
  });

  it.each(["snapshot", "receipt", "handoff"] as const)("rejects a non-object %s root", (kind) => {
    expect(validateArtifact(kind, [])).toEqual({
      schemaVersion: 1, ok: false,
      findings: [{ path: "$", rule: "object", message: "expected object" }],
    });
  });

  it("preserves the published shallow snapshot checks instead of inventing nested rules", () => {
    expect(validateArtifact("snapshot", {
      ...snapshot,
      capabilities: { arbitrary: 42 },
      sources: [null],
      orch: { unknown: "allowed" },
      watch: ["opaque"],
      worktrees: {},
      handoff: {},
      now: [false],
      sourceWarnings: [1],
    })).toEqual({ schemaVersion: 1, ok: true, findings: [] });
  });
});

describe("native artifact tool", () => {
  it("publishes an object-shaped host tool schema while keeping kind-specific validation strict", () => {
    expect(createValidateArtifactTool(createCwdRef(process.cwd())).parameters).toMatchObject({
      type: "object", required: ["kind", "path"], additionalProperties: false,
    });
  });

  it.each([
    ["snapshot", snapshot], ["receipt", receipt], ["handoff", handoff],
  ] as const)("returns the exact %s envelope for valid and invalid JSON contracts", async (kind, value) => {
    const cwd = await workspace();
    const path = join(cwd, "artifact.json");
    const tool = createValidateArtifactTool(createCwdRef(cwd));
    await writeFile(path, JSON.stringify(value));
    expect(JSON.parse(String(await tool.handler({ kind, path: "artifact.json" }, context)))).toEqual({
      kind, path, schemaVersion: 1, ok: true, findings: [],
    });
    await writeFile(path, "null");
    expect(JSON.parse(String(await tool.handler({ kind, path }, context)))).toEqual({
      kind, path, schemaVersion: 1, ok: false,
      findings: [{ path: "$", rule: "object", message: "expected object" }],
    });
    expect(await readFile(path, "utf8")).toBe("null");
  });

  it("uses the shared plan profiles, findings and report without an artifact schema version", async () => {
    const cwd = await workspace();
    const path = join(cwd, "plan.md");
    const tool = createValidateArtifactTool(createCwdRef(cwd));
    await writeFile(path, "# Plan\n\n- [ ] Do the thing\n");
    expect(JSON.parse(String(await tool.handler({ kind: "plan", path, profile: "basic" }, context)))).toEqual({
      kind: "plan", path, profile: "basic", ok: true, findings: [], report: ["1 checklist boxes"],
    });
    const defaultResult = JSON.parse(String(await tool.handler({ kind: "plan", path }, context)));
    expect(defaultResult.profile).toBe("verified-stack");
    expect(defaultResult.ok).toBe(false);
    expect(defaultResult.findings).toContainEqual({
      line: 1, rule: "how-to-read", message: 'no "## How to read this" section',
    });
    expect(defaultResult).not.toHaveProperty("schemaVersion");
    expect(defaultResult).toEqual(JSON.parse(String(await tool.handler({
      kind: "plan", path, profile: "verified-stack",
    }, context))));
    await writeFile(path, "No title\n");
    expect(JSON.parse(String(await tool.handler({ kind: "plan", path, profile: "basic" }, context)))).toEqual({
      kind: "plan", path, profile: "basic", ok: false,
      findings: [
        { line: 1, rule: "h1", message: "no H1 title" },
        { line: 1, rule: "checklist", message: "no checklist boxes" },
      ],
      report: ["0 checklist boxes"],
    });
  });

  it("rejects malformed boundary inputs before any file read", async () => {
    const tool = createPstackExtensionRegistration().options.tools?.find(
      (candidate) => candidate.name === "pstack_validate_artifact",
    );

    if (!tool?.handler) throw new Error("missing registered artifact handler");

    const invalid: unknown[] = [
      null, [], {}, { kind: "unknown", path: "missing" }, { kind: "snapshot", path: 1 },
      { kind: "snapshot", path: "" }, { kind: "plan", path: "missing", profile: "bad" },
      { kind: "plan", path: "missing", profile: null },
      { kind: "snapshot", path: "missing", profile: "basic" },
      { kind: "receipt", path: "missing", profile: "verified-stack" },
      { kind: "handoff", path: "missing", profile: "basic" },
      { kind: "snapshot", path: "missing", extra: true },
    ];

    for (const args of invalid) {
      await expect(tool.handler(args, context)).rejects.toThrow("invalid artifact arguments");
    }
  });

  it("throws visibly for malformed JSON and missing files", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "bad.json"), "{bad");
    const tool = createValidateArtifactTool(createCwdRef(cwd));
    await expect(tool.handler({ kind: "snapshot", path: "bad.json" }, context)).rejects.toBeInstanceOf(SyntaxError);
    await expect(tool.handler({ kind: "snapshot", path: "missing.json" }, context)).rejects.toThrow("ENOENT");
  });

  it("confines reads to the workspace realpath and rejects traversal, URLs and directories", async () => {
    const cwd = await workspace();
    const outside = await workspace();
    await writeFile(join(outside, "secret.json"), JSON.stringify(snapshot));
    await writeFile(join(cwd, "snapshot.json"), JSON.stringify(snapshot));
    await mkdir(join(cwd, "dir"));
    await symlink(join(outside, "secret.json"), join(cwd, "escape.json"));
    await symlink(outside, join(cwd, "escape-dir"));
    await symlink(join(cwd, "snapshot.json"), join(cwd, "inside.json"));
    await symlink(join(cwd, "snapshot.json"), join(outside, "alias-to-inside.json"));
    const tool = createValidateArtifactTool(createCwdRef(cwd));

    for (const path of [
      " ", "../secret.json", "dir/../snapshot.json", "..\\secret.json",
      join(outside, "secret.json"), "https://example.invalid/file",
      join(outside, "alias-to-inside.json"),
      "file:///snapshot.json", "//example.invalid/file", "snapshot.json\0",
      "escape.json", "escape-dir/secret.json", "dir",
    ]) {
      await expect(tool.handler({ kind: "snapshot", path }, context)).rejects.toThrow();
    }

    expect(JSON.parse(String(await tool.handler({ kind: "snapshot", path: "inside.json" }, context)))).toEqual({
      kind: "snapshot", path: join(cwd, "snapshot.json"), schemaVersion: 1, ok: true, findings: [],
    });
  });

  it("uses the latest host cwd and runs no commands", async () => {
    const first = await workspace();
    const second = await workspace();
    await writeFile(join(first, "artifact.json"), JSON.stringify(snapshot));
    await writeFile(join(second, "artifact.json"), "null");
    const registration = createPstackExtensionRegistration();
    const tool = registration.options.tools?.find((candidate) => candidate.name === "pstack_validate_artifact");

    if (!tool?.handler || !registration.options.hooks?.onPreToolUse) throw new Error("missing tool or cwd hook");
    await registration.options.hooks.onPreToolUse({
      sessionId: "test", timestamp: new Date(), workingDirectory: first,
      toolName: tool.name, toolArgs: {},
    }, { sessionId: "test" });
    expect(JSON.parse(String(await tool.handler({ kind: "snapshot", path: "artifact.json" }, context))).ok).toBe(true);
    await registration.options.hooks.onPreToolUse({
      sessionId: "test", timestamp: new Date(), workingDirectory: second,
      toolName: tool.name, toolArgs: {},
    }, { sessionId: "test" });
    expect(JSON.parse(String(await tool.handler({ kind: "snapshot", path: "artifact.json" }, context)))).toEqual({
      kind: "snapshot", path: join(second, "artifact.json"), schemaVersion: 1, ok: false,
      findings: [{ path: "$", rule: "object", message: "expected object" }],
    });
  });

  it("rejects an ancestor swapped for an outside symlink between authorization and open", async () => {
    const cwd = await workspace();
    const outside = await workspace();
    const approved = join(cwd, "approved");
    await mkdir(approved);
    await writeFile(join(approved, "snapshot.json"), JSON.stringify(snapshot));
    await writeFile(join(outside, "snapshot.json"), "null");
    let swapped = false;

    const racingOpen: typeof open = async (path, flags, mode) => {
      if (!swapped && String(path).includes("approved")) {
        swapped = true;
        await rename(approved, join(cwd, "original"));
        await symlink(outside, approved);
      }

      return open(path, flags, mode);
    };

    const tool = createValidateArtifactTool(createCwdRef(cwd), racingOpen);
    await expect(tool.handler({ kind: "snapshot", path: "approved/snapshot.json" }, context)).rejects.toMatchObject({
      code: expect.stringMatching(/^(ELOOP|ENOTDIR)$/),
    });
    expect(swapped).toBe(true);
  });

  it("authorizes the workspace realpath when the host cwd is a symlink alias", async () => {
    const parent = await workspace();
    const cwd = join(parent, "actual");
    const alias = join(parent, "alias");
    await mkdir(cwd);
    await symlink(cwd, alias);
    await writeFile(join(cwd, "snapshot.json"), JSON.stringify(snapshot));
    const tool = createValidateArtifactTool(createCwdRef(alias));
    expect(JSON.parse(String(await tool.handler({ kind: "snapshot", path: "snapshot.json" }, context)))).toEqual({
      kind: "snapshot", path: join(cwd, "snapshot.json"), schemaVersion: 1, ok: true, findings: [],
    });
    expect(JSON.parse(String(await tool.handler({ kind: "snapshot", path: join(cwd, "snapshot.json") }, context)))).toEqual({
      kind: "snapshot", path: join(cwd, "snapshot.json"), schemaVersion: 1, ok: true, findings: [],
    });
  });

  it("leaves legacy plan input, defaults, output, errors and unrestricted paths unchanged", async () => {
    const cwd = await workspace();
    const outside = await workspace();
    const path = join(outside, "plan.md");
    await writeFile(path, "# Plan\n\n- [ ] Do the thing\n");
    const run = vi.fn(async () => { throw new Error("unexpected command"); });
    const legacy = createValidatePlanTool(createPstackService(createCwdRef(cwd), { run }));

    if (!legacy.handler) throw new Error("missing legacy handler");
    expect(legacy.parameters).toEqual({
      type: "object",
      properties: {
        plan_path: { type: "string", description: "Path to the Markdown plan." },
        profile: { type: "string", enum: ["basic", "verified-stack"], description: "Validation profile. Default verified-stack." },
      },
      required: ["plan_path"], additionalProperties: false,
    });
    expect(JSON.parse(String(await legacy.handler({ plan_path: path, profile: "basic" }, context)))).toEqual({
      ok: true, profile: "basic", findings: [], report: ["1 checklist boxes"],
    });
    expect(JSON.parse(String(await legacy.handler({
      plan_path: relative(process.cwd(), path), profile: "basic",
    }, context)))).toEqual({
      ok: true, profile: "basic", findings: [], report: ["1 checklist boxes"],
    });
    expect(JSON.parse(String(await legacy.handler({ plan_path: path }, context))).profile).toBe("verified-stack");
    await expect(legacy.handler({ plan_path: " " }, context)).rejects.toThrow("plan_path is required");

    const registeredLegacy = createPstackExtensionRegistration().options.tools?.find(
      (candidate) => candidate.name === "pstack_validate_plan",
    );

    if (!registeredLegacy?.handler) throw new Error("missing registered legacy handler");
    await expect(registeredLegacy.handler({
      plan_path: path, profile: "bad",
    }, context)).rejects.toThrow("profile must be one of basic, verified-stack");
    expect(run).not.toHaveBeenCalled();
  });
});

describe("artifact CLI compatibility", () => {
  it.each([
    ["snapshot", snapshot], ["receipt", receipt], ["handoff", handoff],
  ] as const)("preserves %s success and contract failure output and exits", async (kind, value) => {
    const path = join(await workspace(), "artifact.json");
    await writeFile(path, JSON.stringify(value));
    expect(await execFileAsync(process.execPath, [script, kind, path])).toMatchObject({
      stdout: `${kind} contract valid: ${path}\n`, stderr: "",
    });

    await writeFile(path, "null");
    await expect(execFileAsync(process.execPath, [script, kind, path])).rejects.toMatchObject({
      code: 1, stdout: "", stderr: "$: expected object\n",
    });
  });

  it("preserves exact nested JSON finding formatting and order", async () => {
    const path = join(await workspace(), "receipt.json");
    await writeFile(path, JSON.stringify({
      ...receipt, createdAt: "2026-10-01", evidence: [{ kind: "file", value: "proof", digest: 7 }],
    }));
    await expect(execFileAsync(process.execPath, [script, "receipt", path])).rejects.toMatchObject({
      code: 1, stdout: "",
      stderr: "$.createdAt: expected date-time\n$.evidence[0].digest: expected string\n",
    });
  });

  it("preserves legacy CLI profile handling and rejects excess arguments", async () => {
    const path = join(await workspace(), "plan.md");
    await writeFile(path, "# Plan\n\n- [ ] Do the thing\n");
    expect(await execFileAsync(process.execPath, [script, "plan", path, "basic"])).toMatchObject({
      stdout: `plan contract valid: ${path}\n`, stderr: "",
    });
    await expect(execFileAsync(process.execPath, [script, "plan", path])).rejects.toMatchObject({
      code: 1, stderr: expect.stringContaining(`${path}:1: [how-to-read]`),
    });

    for (const args of [
      [], ["unknown", path], ["plan", path, "basic", "extra"],
      ["snapshot", path, "ignored", "extra"],
    ]) {
      await expect(execFileAsync(process.execPath, [script, ...args])).rejects.toMatchObject({
        code: 2, stdout: "", stderr: expect.stringContaining("Usage: node validate.mjs"),
      });
    }

    await expect(execFileAsync(process.execPath, [script, "plan", path, "bad"])).rejects.toMatchObject({
      code: 2, stdout: "", stderr: 'unknown plan profile "bad"; expected basic or verified-stack\n',
    });

    await expect(execFileAsync(process.execPath, [script, "plan", `${path}.missing`, "bad"])).rejects.toMatchObject({
      code: 2, stdout: "", stderr: expect.stringContaining("ENOENT"),
    });

    for (const [kind, value] of [["snapshot", snapshot], ["receipt", receipt], ["handoff", handoff]] as const) {
      await writeFile(path, JSON.stringify(value));

      for (const profile of ["basic", "verified-stack", "ignored"]) {
        expect(await execFileAsync(process.execPath, [script, kind, path, profile])).toMatchObject({
          stdout: `${kind} contract valid: ${path}\n`, stderr: "",
        });
      }
    }

    await writeFile(path, "{bad");
    await expect(execFileAsync(process.execPath, [script, "snapshot", path])).rejects.toMatchObject({ code: 2 });
    await expect(execFileAsync(process.execPath, [script, "snapshot", `${path}.missing`])).rejects.toMatchObject({
      code: 2, stderr: expect.stringContaining("ENOENT"),
    });
  });
});
