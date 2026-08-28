#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { validatePlanText } from "../../poteto-mode/scripts/plan-rules.mjs";

const VERDICTS = new Set([
  "live-ui-verified",
  "unit-test-verified",
  "type-check-only",
  "verifier-blocked",
  "verifier-failed",
]);
const EVIDENCE_KINDS = new Set(["file", "command", "link", "note"]);

function object(value, path, findings) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    findings.push(`${path}: expected object`);
    return null;
  }
  return value;
}

function string(value, path, findings) {
  if (typeof value !== "string" || value.length === 0) findings.push(`${path}: expected non-empty string`);
}

function exactKeys(value, allowed, path, findings) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) findings.push(`${path}.${key}: unexpected property`);
  }
}

function dateTime(value, path, findings) {
  string(value, path, findings);
  if (
    typeof value === "string" &&
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    findings.push(`${path}: expected date-time`);
  }
}

function snapshot(value) {
  const findings = [];
  const root = object(value, "$", findings);
  if (!root) return findings;
  exactKeys(
    root,
    ["schemaVersion", "snapshotHash", "capabilities", "sources", "orch", "watch", "worktrees", "handoff", "now", "sourceWarnings"],
    "$",
    findings,
  );
  if (root.schemaVersion !== 1) findings.push("$.schemaVersion: expected 1");
  if (typeof root.snapshotHash !== "string" || !/^[a-f0-9]{64}$/.test(root.snapshotHash)) {
    findings.push("$.snapshotHash: expected 64 lowercase hex characters");
  }
  object(root.capabilities, "$.capabilities", findings);
  for (const field of ["sources", "watch", "now", "sourceWarnings"]) {
    if (!Array.isArray(root[field])) findings.push(`$.${field}: expected array`);
  }
  for (const field of ["orch", "worktrees", "handoff"]) {
    if (root[field] !== null) object(root[field], `$.${field}`, findings);
  }
  return findings;
}

function receipt(value) {
  const findings = [];
  const root = object(value, "$", findings);
  if (!root) return findings;
  exactKeys(
    root,
    ["schemaVersion", "receiptId", "pr", "sha", "verdict", "verifier", "summary", "evidence", "createdAt", "supersedesReceiptId"],
    "$",
    findings,
  );
  if (root.schemaVersion !== 1) findings.push("$.schemaVersion: expected 1");
  if (typeof root.receiptId !== "string" || !/^[a-f0-9]{20}$/.test(root.receiptId)) {
    findings.push("$.receiptId: expected 20 lowercase hex characters");
  }
  if (!Number.isInteger(root.pr) || root.pr < 1) findings.push("$.pr: expected positive integer");
  for (const field of ["sha", "verifier", "summary"]) string(root[field], `$.${field}`, findings);
  dateTime(root.createdAt, "$.createdAt", findings);
  if (
    root.supersedesReceiptId !== undefined &&
    (typeof root.supersedesReceiptId !== "string" || !/^[a-f0-9]{20}$/.test(root.supersedesReceiptId))
  ) {
    findings.push("$.supersedesReceiptId: expected 20 lowercase hex characters");
  }
  if (!VERDICTS.has(root.verdict)) findings.push("$.verdict: unsupported verdict");
  if (!Array.isArray(root.evidence) || root.evidence.length === 0) {
    findings.push("$.evidence: expected non-empty array");
  } else {
    root.evidence.forEach((item, index) => {
      const evidence = object(item, `$.evidence[${index}]`, findings);
      if (!evidence) return;
      exactKeys(evidence, ["kind", "value", "digest"], `$.evidence[${index}]`, findings);
      if (!EVIDENCE_KINDS.has(evidence.kind)) findings.push(`$.evidence[${index}].kind: unsupported kind`);
      string(evidence.value, `$.evidence[${index}].value`, findings);
      if (evidence.digest !== undefined && typeof evidence.digest !== "string") {
        findings.push(`$.evidence[${index}].digest: expected string`);
      }
    });
  }
  return findings;
}

function handoff(value) {
  const findings = [];
  const root = object(value, "$", findings);
  if (!root) return findings;
  exactKeys(
    root,
    ["schemaVersion", "sessionId", "createdAt", "intent", "progress", "nextAction", "keyFiles", "snapshot"],
    "$",
    findings,
  );
  if (root.schemaVersion !== 1) findings.push("$.schemaVersion: expected 1");
  for (const field of ["sessionId", "intent", "progress", "nextAction"]) {
    string(root[field], `$.${field}`, findings);
  }
  dateTime(root.createdAt, "$.createdAt", findings);
  if (!Array.isArray(root.keyFiles)) findings.push("$.keyFiles: expected array");
  else {
    root.keyFiles.forEach((item, index) => {
      if (typeof item !== "string") findings.push(`$.keyFiles[${index}]: expected string`);
    });
  }
  findings.push(...snapshot(root.snapshot).map((finding) => `$.snapshot${finding.slice(1)}`));
  return findings;
}

const [kind, file, profile = "verified-stack", ...extra] = process.argv.slice(2);
if (!kind || !file || extra.length > 0 || !["snapshot", "receipt", "handoff", "plan"].includes(kind)) {
  console.error("Usage: node validate.mjs <snapshot|receipt|handoff|plan> <file> [basic|verified-stack]");
  process.exit(2);
}

try {
  const raw = readFileSync(file, "utf8");
  const findings =
    kind === "plan"
      ? validatePlanText(raw, profile).findings.map(
          (finding) => `${file}:${finding.line}: [${finding.rule}] ${finding.message}`,
        )
      : (kind === "snapshot" ? snapshot : kind === "receipt" ? receipt : handoff)(JSON.parse(raw));
  for (const finding of findings) console.error(finding);
  if (findings.length > 0) process.exit(1);
  console.log(`${kind} contract valid: ${file}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
