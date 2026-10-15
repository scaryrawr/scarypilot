import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { validateArtifact } from "../scripts/artifact-rules.mjs";
import { validatePlanText } from "../../poteto-mode/scripts/plan-rules.mjs";
import { handoff, receipt, script, snapshot, supported, workspace } from "./support.mjs";

const execFileAsync = promisify(execFile);

async function cli(cwd, ...args) {
  try {
    return { code: 0, ...await execFileAsync(process.execPath, [script, ...args], { cwd }) };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

describe("published artifact authority", () => {
  for (const [kind, value] of [["snapshot", snapshot], ["receipt", receipt], ["handoff", handoff]]) {
    it(`accepts hand-authored ${kind} without reading references`, () => {
      assert.deepEqual(validateArtifact(kind, value), { schemaVersion: 1, ok: true, findings: [] });
      assert.deepEqual(validateArtifact(kind, []), {
        schemaVersion: 1, ok: false,
        findings: [{ path: "$", rule: "object", message: "expected object" }],
      });
    });
  }

  it("reports every snapshot check in published order", () => {
    assert.deepEqual(validateArtifact("snapshot", {
      schemaVersion: 2, snapshotHash: "ABC", capabilities: [], sources: {}, watch: null,
      now: 0, sourceWarnings: "", orch: [], worktrees: false, handoff: "bad", extra: true,
    }), {
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
    assert.deepEqual(validateArtifact("receipt", {
      schemaVersion: 0, receiptId: "BAD", pr: 0.5, sha: "", verifier: null, summary: 1,
      createdAt: "", supersedesReceiptId: "bad", verdict: "passed",
      evidence: [null, { kind: "bad", value: "", digest: 3, extra: true }], extra: true,
    }).findings, [
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

  it("rejects empty or non-array evidence", () => {
    for (const evidence of [[], null, {}]) {
      assert.deepEqual(validateArtifact("receipt", { ...receipt, evidence }).findings, [
        { path: "$.evidence", rule: "non-empty-array", message: "expected non-empty array" },
      ]);
    }
  });

  it("reports handoff and nested snapshot violations with rooted paths", () => {
    assert.deepEqual(validateArtifact("handoff", {
      ...handoff, schemaVersion: 2, sessionId: "", intent: 0, progress: null,
      nextAction: "", createdAt: "yesterday", keyFiles: [3], extra: true,
      snapshot: { ...snapshot, capabilities: null, watch: {}, extra: true },
    }).findings, [
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
    assert.deepEqual(validateArtifact("handoff", { ...handoff, keyFiles: null, snapshot: null }).findings, [
      { path: "$.keyFiles", rule: "array", message: "expected array" },
      { path: "$.snapshot", rule: "object", message: "expected object" },
    ]);
  });

  it("preserves shallow snapshot checks and rejects unknown kinds", () => {
    assert.deepEqual(validateArtifact("snapshot", {
      ...snapshot, capabilities: { arbitrary: 42 }, sources: [null], orch: { unknown: "allowed" },
      watch: ["opaque"], worktrees: {}, handoff: {}, now: [false], sourceWarnings: [1],
    }), { schemaVersion: 1, ok: true, findings: [] });
    assert.throws(() => validateArtifact("unknown", snapshot), /kind must be one of snapshot, receipt, handoff/);
  });
});

describe("standalone CLI", { skip: !supported }, () => {
  for (const [kind, value] of [["snapshot", snapshot], ["receipt", receipt], ["handoff", handoff]]) {
    it(`preserves ${kind} success and failure output and exits`, async () => {
      const cwd = await workspace();
      const path = join(cwd, "artifact.json");
      await writeFile(path, JSON.stringify(value));

      for (const args of [[path], ["artifact.json"], [path, "basic"], [path, "verified-stack"], [path, "ignored"]]) {
        assert.deepEqual(await cli(cwd, kind, ...args), {
          code: 0, stdout: `${kind} contract valid: ${args[0]}\n`, stderr: "",
        });
      }

      await writeFile(path, "null");
      assert.deepEqual(await cli(cwd, kind, path), {
        code: 1, stdout: "", stderr: "$: expected object\n",
      });
    });
  }

  it("preserves exact nested JSON finding formatting and order", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "receipt.json"), JSON.stringify({
      ...receipt, createdAt: "2026-10-01", evidence: [{ kind: "file", value: "proof", digest: 7 }],
    }));
    assert.deepEqual(await cli(cwd, "receipt", "receipt.json"), {
      code: 1, stdout: "",
      stderr: "$.createdAt: expected date-time\n$.evidence[0].digest: expected string\n",
    });
  });

  it("preserves plan profiles, exact findings, and invalid-profile error ordering", async () => {
    const cwd = await workspace();
    const path = join(cwd, "plan.md");
    const raw = "# Plan\n\n- [ ] Do the thing\n";
    await writeFile(path, raw);
    assert.deepEqual(await cli(cwd, "plan", "plan.md", "basic"), {
      code: 0, stdout: "plan contract valid: plan.md\n", stderr: "",
    });
    const findings = validatePlanText(raw, "verified-stack").findings;
    assert.ok(findings.some((finding) => finding.rule === "how-to-read"));

    const failure = {
      code: 1, stdout: "",
      stderr: findings.map((finding) => `plan.md:${finding.line}: [${finding.rule}] ${finding.message}\n`).join(""),
    };

    assert.deepEqual(await cli(cwd, "plan", "plan.md"), failure);
    assert.deepEqual(await cli(cwd, "plan", "plan.md", "verified-stack"), failure);
    await writeFile(path, "No title\n");
    assert.deepEqual(await cli(cwd, "plan", "plan.md", "basic"), {
      code: 1, stdout: "",
      stderr: "plan.md:1: [h1] no H1 title\nplan.md:1: [checklist] no checklist boxes\n",
    });
    assert.deepEqual(await cli(cwd, "plan", "plan.md", "bad"), {
      code: 2, stdout: "", stderr: 'unknown plan profile "bad"; expected basic or verified-stack\n',
    });
    const missing = await cli(cwd, "plan", "missing.md", "bad");
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /ENOENT/);
  });

  it("preserves exact verified-stack success and cadence violation output", async () => {
    const cwd = await workspace();
    const rule = "Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.";

    const raw = `# Safe verified-stack validation fixture

## How to read this

One box is one unit of work.
Each box names the evidence.
Check a box only when its evidence exists.
The playbooks/ reference is an inert marker.
${rule}

## Program checklist

### Arm the program

The decision-trail and 30-minute status message are inert markers.

### Spawn owners

No workers are requested.

### PR mechanics

No real pull request is referenced.

### Verdict and merge

No verdict or merge is authorized.

### Boot recipe

No command is provided.

## PR fixture

**Depends on.** None.

**Files.**
- [ ] Inert file marker.

**Build.**
- [ ] Inert build marker.

**You see.**
- [ ] Static Markdown.

**Verify, unit.** ${rule}
- [ ] Inert unit marker.

**Verify, live.** ${rule} Parallel Copilot Task workers at the PR head
- [ ] Lane 1. Save \`fixture-only-evidence.txt\`. Pass when recognized as fixture data.

**Verify, perf.** ${rule}
- [ ] Metric. No measurement requested.
- [ ] Probe. No probe provided.
- [ ] Baseline. No baseline claimed.
- [ ] Rule. Inert marker.

**Review gate.** None.

**Merge.**
- [ ] No merge authorized.

## Close the program

No program has been started.

## Appendix Prototype evidence

No real execution evidence.
`;

    assert.deepEqual(validatePlanText(raw, "verified-stack").findings, []);
    await writeFile(join(cwd, "verified.md"), raw);
    assert.deepEqual(await cli(cwd, "plan", "verified.md"), {
      code: 0, stdout: "plan contract valid: verified.md\n", stderr: "",
    });
    await writeFile(join(cwd, "cadence.md"), raw.replace("30-minute", "weekly"));
    assert.deepEqual(await cli(cwd, "plan", "cadence.md"), {
      code: 1, stdout: "",
      stderr: 'cadence.md:11: [audit-cadence] Program checklist needs "hourly" or "30-minute" on the audit tick or status message line\n',
    });
  });

  it("rejects malformed JSON, missing input, and invalid invocations", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "bad.json"), "{bad");

    for (const args of [
      [], ["snapshot"], ["unknown", "bad.json"], ["plan", "bad.json", "basic", "extra"],
      ["snapshot", "bad.json", "ignored", "extra"],
    ]) {
      const result = await cli(cwd, ...args);
      assert.equal(result.code, 2);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /^Usage: node validate.mjs/);
    }

    const malformed = await cli(cwd, "snapshot", "bad.json");
    assert.equal(malformed.code, 2);
    assert.equal(malformed.stdout, "");
    assert.match(malformed.stderr, /JSON|property/i);
    const missing = await cli(cwd, "snapshot", "missing.json");
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /ENOENT/);
  });

  it("rejects outside, traversal, URL, directory, and symlink paths", async () => {
    const cwd = await workspace();
    const outside = await workspace();
    await writeFile(join(cwd, "artifact.json"), JSON.stringify(snapshot));
    await writeFile(join(outside, "secret.json"), JSON.stringify(snapshot));
    await mkdir(join(cwd, "dir"));
    await symlink(join(cwd, "artifact.json"), join(cwd, "inside-link.json"));
    await symlink(join(outside, "secret.json"), join(cwd, "escape.json"));

    for (const path of [
      "", " ", "../secret.json", "dir/../artifact.json", "..\\secret.json",
      join(outside, "secret.json"), "https://example.invalid/file", "file:///artifact.json",
      "//example.invalid/file", "dir", "inside-link.json", "escape.json",
    ]) {
      const result = await cli(cwd, "snapshot", path);
      assert.equal(result.code, 2, path);
      assert.equal(result.stdout, "", path);
      assert.notEqual(result.stderr, "", path);
    }
  });
});
