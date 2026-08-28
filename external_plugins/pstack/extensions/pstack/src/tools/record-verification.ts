import type { Tool } from "@github/copilot-sdk";
import type { PstackService } from "../service.ts";
import type { EvidenceItem, VerificationVerdict } from "../types.ts";
import { json, requiredString } from "./common.ts";

interface RecordVerificationArgs {
  store_dir: string;
  pr: number;
  sha: string;
  verdict: VerificationVerdict;
  verifier: string;
  summary: string;
  evidence: EvidenceItem[];
  supersedes_receipt_id?: string;
}

export function createRecordVerificationTool(
  service: PstackService,
): Tool<RecordVerificationArgs> {
  return {
    name: "pstack_record_verification",
    description:
      "Write an immutable structured verification receipt, then index it through the existing orch ledger. Replacing another receipt requires its receipt ID.",
    parameters: {
      type: "object",
      properties: {
        store_dir: { type: "string" },
        pr: { type: "integer", minimum: 1 },
        sha: { type: "string" },
        verdict: {
          type: "string",
          enum: [
            "live-ui-verified",
            "unit-test-verified",
            "type-check-only",
            "verifier-blocked",
            "verifier-failed",
          ],
        },
        verifier: { type: "string" },
        summary: { type: "string" },
        evidence: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["file", "command", "link", "note"] },
              value: { type: "string" },
              digest: { type: "string" },
            },
            required: ["kind", "value"],
            additionalProperties: false,
          },
        },
        supersedes_receipt_id: { type: "string", pattern: "^[a-f0-9]{20}$" },
      },
      required: ["store_dir", "pr", "sha", "verdict", "verifier", "summary", "evidence"],
      additionalProperties: false,
    },
    handler: async (args) =>
      json(
        await service.recordReceipt({
          storeDir: requiredString(args.store_dir, "store_dir"),
          pr: args.pr,
          sha: requiredString(args.sha, "sha"),
          verdict: args.verdict,
          verifier: requiredString(args.verifier, "verifier"),
          summary: requiredString(args.summary, "summary"),
          evidence: args.evidence,
          supersedesReceiptId: args.supersedes_receipt_id,
        }),
      ),
  };
}
