import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  openStore,
  type LedgerEntry,
} from "../../../skills/poteto-mode/scripts/orch/store.ts";
import { sha256, stableJson, writeJsonAtomic } from "./io.ts";
import { readOrchStore } from "./orch-reader.ts";
import type {
  EvidenceItem,
  VerificationReceiptV1,
  VerificationVerdict,
} from "./types.ts";

export interface RecordReceiptInput {
  readonly storeDir: string;
  readonly pr: number;
  readonly sha: string;
  readonly verdict: VerificationVerdict;
  readonly verifier: string;
  readonly summary: string;
  readonly evidence: readonly EvidenceItem[];
  readonly supersedesReceiptId?: string;
}

function receiptIdentity(input: RecordReceiptInput): string {
  return sha256(
    stableJson({
      pr: input.pr,
      sha: input.sha,
      verdict: input.verdict,
      verifier: input.verifier,
      summary: input.summary,
      evidence: input.evidence,
      supersedesReceiptId: input.supersedesReceiptId,
    }),
  ).slice(0, 20);
}

function receiptIdFromEvidence(evidence: string): string | null {
  return evidence.match(/\/([a-f0-9]{20})\.json$/)?.[1] ?? null;
}

function supersessionToken(evidence: string): string {
  return receiptIdFromEvidence(evidence) ?? sha256(`legacy:${evidence}`).slice(0, 20);
}

export async function recordVerificationReceipt(
  input: RecordReceiptInput,
): Promise<{ readonly receipt: VerificationReceiptV1; readonly path: string; readonly ledger: LedgerEntry }> {
  if (!Number.isInteger(input.pr) || input.pr < 1) throw new Error("PR must be a positive integer");
  if (!input.sha.trim() || !input.verifier.trim() || !input.summary.trim()) {
    throw new Error("SHA, verifier, and summary are required");
  }
  if (input.evidence.length === 0 || input.evidence.some((item) => !item.value.trim())) {
    throw new Error("at least one non-empty evidence item is required");
  }
  if (
    input.supersedesReceiptId !== undefined &&
    !/^[a-f0-9]{20}$/.test(input.supersedesReceiptId)
  ) {
    throw new Error("supersedes receipt ID must be 20 lowercase hexadecimal characters");
  }
  const storeDir = resolve(input.storeDir);
  const receiptId = receiptIdentity(input);
  const path = join(storeDir, "receipts", String(input.pr), input.sha, `${receiptId}.json`);
  const current = (await readOrchStore(storeDir)).projection?.ledger.find(
    (entry) => entry.pr === String(input.pr) && entry.sha === input.sha,
  );
  const currentToken = current ? supersessionToken(current.evidence) : null;
  if (current && currentToken !== receiptId && input.supersedesReceiptId !== currentToken) {
    throw new Error(
      `PR ${input.pr} at ${input.sha} already has receipt ${currentToken}; pass supersedes_receipt_id to replace it`,
    );
  }
  let receipt: VerificationReceiptV1;
  try {
    receipt = JSON.parse(await readFile(path, "utf8")) as VerificationReceiptV1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    receipt = {
      schemaVersion: 1,
      receiptId,
      pr: input.pr,
      sha: input.sha,
      verdict: input.verdict,
      verifier: input.verifier.trim(),
      summary: input.summary.trim(),
      evidence: input.evidence,
      createdAt: new Date().toISOString(),
      ...(input.supersedesReceiptId ? { supersedesReceiptId: input.supersedesReceiptId } : {}),
    };
    await writeJsonAtomic(path, receipt);
  }

  const store = openStore(storeDir);
  try {
    const evidence = relative(storeDir, path).split("\\").join("/");
    const ledger = await store.ledger.record({
      pr: input.pr,
      sha: input.sha,
      verdict: input.verdict,
      evidence,
      verifier: input.verifier,
      expectedEvidence: current?.evidence ?? null,
    });
    return { receipt, path, ledger };
  } finally {
    await store.close();
  }
}
