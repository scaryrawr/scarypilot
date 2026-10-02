const VERDICTS = new Set([
  "live-ui-verified",
  "unit-test-verified",
  "type-check-only",
  "verifier-blocked",
  "verifier-failed",
]);

const EVIDENCE_KINDS = new Set(["file", "command", "link", "note"]);

export const ARTIFACT_KINDS = ["snapshot", "receipt", "handoff"];

function fail(findings, path, rule, message) {
  findings.push({ path, rule, message });
}

function object(value, path, findings) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(findings, path, "object", "expected object");

    return null;
  }

  return value;
}

function string(value, path, findings) {
  if (typeof value !== "string" || value.length === 0) {
    fail(findings, path, "non-empty-string", "expected non-empty string");
  }
}

function exactKeys(value, allowed, path, findings) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(findings, `${path}.${key}`, "exact-keys", "unexpected property");
  }
}

function dateTime(value, path, findings) {
  string(value, path, findings);

  if (
    typeof value === "string" &&
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    fail(findings, path, "date-time", "expected date-time");
  }
}

function snapshot(value, path, findings) {
  const root = object(value, path, findings);

  if (!root) return;
  exactKeys(
    root,
    ["schemaVersion", "snapshotHash", "capabilities", "sources", "orch", "watch", "worktrees", "handoff", "now", "sourceWarnings"],
    path,
    findings,
  );

  if (root.schemaVersion !== 1) fail(findings, `${path}.schemaVersion`, "schema-version", "expected 1");

  if (typeof root.snapshotHash !== "string" || !/^[a-f0-9]{64}$/.test(root.snapshotHash)) {
    fail(findings, `${path}.snapshotHash`, "snapshot-hash", "expected 64 lowercase hex characters");
  }

  object(root.capabilities, `${path}.capabilities`, findings);

  for (const field of ["sources", "watch", "now", "sourceWarnings"]) {
    if (!Array.isArray(root[field])) fail(findings, `${path}.${field}`, "array", "expected array");
  }

  for (const field of ["orch", "worktrees", "handoff"]) {
    if (root[field] !== null) object(root[field], `${path}.${field}`, findings);
  }
}

function receipt(value, path, findings) {
  const root = object(value, path, findings);

  if (!root) return;
  exactKeys(
    root,
    ["schemaVersion", "receiptId", "pr", "sha", "verdict", "verifier", "summary", "evidence", "createdAt", "supersedesReceiptId"],
    path,
    findings,
  );

  if (root.schemaVersion !== 1) fail(findings, `${path}.schemaVersion`, "schema-version", "expected 1");

  if (typeof root.receiptId !== "string" || !/^[a-f0-9]{20}$/.test(root.receiptId)) {
    fail(findings, `${path}.receiptId`, "receipt-id", "expected 20 lowercase hex characters");
  }

  if (!Number.isInteger(root.pr) || root.pr < 1) {
    fail(findings, `${path}.pr`, "positive-integer", "expected positive integer");
  }

  for (const field of ["sha", "verifier", "summary"]) string(root[field], `${path}.${field}`, findings);
  dateTime(root.createdAt, `${path}.createdAt`, findings);

  if (
    root.supersedesReceiptId !== undefined &&
    (typeof root.supersedesReceiptId !== "string" || !/^[a-f0-9]{20}$/.test(root.supersedesReceiptId))
  ) {
    fail(findings, `${path}.supersedesReceiptId`, "receipt-id", "expected 20 lowercase hex characters");
  }

  if (!VERDICTS.has(root.verdict)) fail(findings, `${path}.verdict`, "verdict", "unsupported verdict");

  if (!Array.isArray(root.evidence) || root.evidence.length === 0) {
    fail(findings, `${path}.evidence`, "non-empty-array", "expected non-empty array");
  } else {
    root.evidence.forEach((item, index) => {
      const evidencePath = `${path}.evidence[${index}]`;
      const evidence = object(item, evidencePath, findings);

      if (!evidence) return;
      exactKeys(evidence, ["kind", "value", "digest"], evidencePath, findings);

      if (!EVIDENCE_KINDS.has(evidence.kind)) fail(findings, `${evidencePath}.kind`, "evidence-kind", "unsupported kind");
      string(evidence.value, `${evidencePath}.value`, findings);

      if (evidence.digest !== undefined && typeof evidence.digest !== "string") {
        fail(findings, `${evidencePath}.digest`, "string", "expected string");
      }
    });
  }
}

function handoff(value, path, findings) {
  const root = object(value, path, findings);

  if (!root) return;
  exactKeys(
    root,
    ["schemaVersion", "sessionId", "createdAt", "intent", "progress", "nextAction", "keyFiles", "snapshot"],
    path,
    findings,
  );

  if (root.schemaVersion !== 1) fail(findings, `${path}.schemaVersion`, "schema-version", "expected 1");

  for (const field of ["sessionId", "intent", "progress", "nextAction"]) string(root[field], `${path}.${field}`, findings);
  dateTime(root.createdAt, `${path}.createdAt`, findings);

  if (!Array.isArray(root.keyFiles)) fail(findings, `${path}.keyFiles`, "array", "expected array");
  else root.keyFiles.forEach((item, index) => {
    if (typeof item !== "string") fail(findings, `${path}.keyFiles[${index}]`, "string", "expected string");
  });
  snapshot(root.snapshot, `${path}.snapshot`, findings);
}

export function validateArtifact(kind, value) {
  const validators = { snapshot, receipt, handoff };

  if (!ARTIFACT_KINDS.includes(kind)) throw new Error("kind must be one of snapshot, receipt, handoff");
  const findings = [];
  validators[kind](value, "$", findings);

  return { schemaVersion: 1, ok: findings.length === 0, findings };
}
