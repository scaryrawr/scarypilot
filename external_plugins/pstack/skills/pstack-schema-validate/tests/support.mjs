import { randomUUID } from "node:crypto";
import { mkdir, realpath, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach } from "node:test";

export const supported = process.platform === "darwin" || process.platform === "linux";

export const script = fileURLToPath(new URL("../scripts/validate.mjs", import.meta.url));

const directories = [];

export async function workspace() {
  const path = fileURLToPath(new URL(`../../../../../.pstack-validation-workspace-${randomUUID()}`, import.meta.url));
  await mkdir(path);
  directories.push(path);

  return realpath(path);
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

export const snapshot = {
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

export const receipt = {
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

export const handoff = {
  schemaVersion: 1,
  sessionId: "session",
  createdAt: "2026-10-02T01:00:00.000Z",
  intent: "validate",
  progress: "ready",
  nextAction: "read",
  keyFiles: ["../../missing", ""],
  snapshot,
};
