import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStore } from "../../../skills/poteto-mode/scripts/orch/store.ts";
import { recordVerificationReceipt } from "../src/receipt.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("recordVerificationReceipt", () => {
  it("writes an immutable receipt and indexes it in the existing ledger", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pstack-receipt-"));
    directories.push(directory);
    const store = openStore(directory);
    await store.init();
    await store.close();

    const input = {
      storeDir: directory,
      pr: 12,
      sha: "abc",
      verdict: "unit-test-verified" as const,
      verifier: "vitest",
      summary: "Targeted tests passed.",
      evidence: [{ kind: "command" as const, value: "npm test", digest: "sha256:test" }],
    };
    const first = await recordVerificationReceipt(input);
    const second = await recordVerificationReceipt(input);
    expect(second.receipt.receiptId).toBe(first.receipt.receiptId);
    expect(JSON.parse(await readFile(first.path, "utf8"))).toMatchObject({
      schemaVersion: 1,
      pr: 12,
      sha: "abc",
    });
    expect(await readFile(join(directory, "ledger.tsv"), "utf8")).toContain(
      `12\tabc\tunit-test-verified\treceipts/12/abc/${first.receipt.receiptId}.json`,
    );
  });

  it("requires an explicit token to replace a legacy ledger entry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pstack-receipt-legacy-"));
    directories.push(directory);
    const store = openStore(directory);
    await store.init();
    await store.ledger.record({
      pr: 12,
      sha: "abc",
      verdict: "type-check-only",
      evidence: "legacy evidence",
      verifier: "legacy",
    });
    await store.close();

    const input = {
      storeDir: directory,
      pr: 12,
      sha: "abc",
      verdict: "unit-test-verified" as const,
      verifier: "vitest",
      summary: "Targeted tests passed.",
      evidence: [{ kind: "command" as const, value: "npm test" }],
    };
    await expect(recordVerificationReceipt(input)).rejects.toThrow(
      /already has receipt [a-f0-9]{20}/,
    );
    const token = (await recordVerificationReceipt(input).catch((error: unknown) =>
      String(error).match(/receipt ([a-f0-9]{20})/)?.[1],
    )) as string;
    await expect(
      recordVerificationReceipt({ ...input, supersedesReceiptId: token }),
    ).resolves.toMatchObject({ receipt: { verdict: "unit-test-verified" } });
  });

  it("rejects schema-invalid supersession IDs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pstack-receipt-invalid-"));
    directories.push(directory);
    const store = openStore(directory);
    await store.init();
    await store.close();
    await expect(
      recordVerificationReceipt({
        storeDir: directory,
        pr: 12,
        sha: "abc",
        verdict: "unit-test-verified",
        verifier: "vitest",
        summary: "Targeted tests passed.",
        evidence: [{ kind: "command", value: "npm test" }],
        supersedesReceiptId: "invalid",
      }),
    ).rejects.toThrow("20 lowercase hexadecimal");
  });
});
