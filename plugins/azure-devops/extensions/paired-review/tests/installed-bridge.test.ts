import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it, vi } from "vitest";
import { changedLineRanges, createReviewState, insertReviewFinding, updateReviewState } from "../src/review-state.ts";

const run = promisify(execFile);

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

const LedgerSchema = Type.Array(Type.Object({
  kind: Type.String(), args: Type.Array(Type.String()),
  script: Type.String(),
  request: Type.Optional(Type.Object({
    operation: Type.String(),
    findings: Type.Optional(Type.Array(Type.Object({
      payload: Type.Object({ comments: Type.Array(Type.Object({ content: Type.String() })) }),
    }))),
  }, { additionalProperties: true })),
  cwd: Type.Optional(Type.String()),
}));

const HostSchema = Type.Object({
  tools: Type.Array(Type.String()), canvases: Type.Number(), commands: Type.Number(),
  snapshots: Type.Array(Type.Object({
    details: Type.Object({ pullRequestId: Type.Number() }),
    revision: Type.Object({ sourceCommit: Type.String() }), observedAt: Type.String(),
  }, { additionalProperties: true })),
});

describe("installed source and bundle bridge", () => {
  it.each(["source", "dist"] as const)("uses native uv and the installed sibling Python runtime from %s", async (entry) => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "installed-ado-bridge-"));
    const plugin = path.join(scratch, "installed plugin with spaces", "azure-devops");
    const extensionRoot = path.join(plugin, "extensions", "paired-review");
    const helperRoot = path.join(plugin, "skills", "azure-devops", "scripts");
    const ledgerPath = path.join(scratch, "requests.jsonl");
    const expectedBridge = path.join(helperRoot, "ado-bridge.py");

    try {
      await mkdir(extensionRoot, { recursive: true });
      await cp(path.resolve(packageRoot, "../../skills/azure-devops/scripts"), helperRoot, {
        recursive: true,
        filter: (source) => !["tests", "__pycache__"].includes(path.basename(source)),
      });
      await writeFile(ledgerPath, "");
      await cp(fileURLToPath(new URL("./fixtures/installed-owner.py", import.meta.url)), expectedBridge);

      const overrides = {
        ADO_TEST_LEDGER: ledgerPath, ADO_TEST_EXPECTED_BRIDGE: expectedBridge,
        NODE_DISABLE_COMPILE_CACHE: "1", TMPDIR: scratch, TMP: scratch, TEMP: scratch,
        UV_OFFLINE: "1", UV_PYTHON_DOWNLOADS: "never",
      };

      const environment = { ...process.env, ...overrides };

      if (entry === "source") {
        await cp(path.join(packageRoot, "src"), path.join(extensionRoot, "src"), { recursive: true });
        await symlink(path.join(packageRoot, "node_modules"), path.join(extensionRoot, "node_modules"), "junction");

        for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value);

        const installed: typeof import("../src/ado-loader.ts") = await import(
          pathToFileURL(path.join(extensionRoot, "src", "ado-loader.ts")).href
        );

        const review = updateReviewState(createReviewState(
          "installed", "https://dev.azure.com/example/project/_git/repo/pullrequest/42",
        ), {
          loaded: true,
          files: [{
            path: "a.ts", diff: "@@ -2 +2 @@\n-old\n+new\n",
            oldContent: "one\nold\n", newContent: "one\nnew\n",
            changedLineRanges: changedLineRanges("@@ -2 +2 @@\n-old\n+new\n"),
            changeTrackingId: 17, iterationId: 3,
          }],
        });

        const finding = insertReviewFinding(review, {
          path: "a.ts", side: "additions", lineStart: 2, lineEnd: 2,
          severity: "warning", title: "Finding", body: "Keep %PATH% | $(echo unsafe) and \u65e5\u672c\u8a9e \u{1f916} verbatim.",
        }, { kind: "review_pass", passId: "pass" }).review;

        const results = await installed.publishReviewFindings(finding, { kind: "all_open" });

        expect(results).toEqual([{ kind: "published", findingId: finding.threads[0]?.id, remoteThreadId: 100 }]);
      } else {
        await cp(path.join(packageRoot, "extension.mjs"), path.join(extensionRoot, "extension.mjs"));
        await cp(path.join(packageRoot, "dist"), path.join(extensionRoot, "dist"), { recursive: true });

        const { stdout } = await run(process.execPath, [
          fileURLToPath(new URL("./fixtures/installed-host.mjs", import.meta.url)), extensionRoot,
        ], { env: environment, timeout: 20_000 });

        const registration = Value.Parse(HostSchema, JSON.parse(stdout));

        expect(registration.tools).toEqual([
          "azure_devops_pr_snapshot", "azure_devops_work_item_search",
          "azure_devops_work_item_query", "azure_devops_work_item_get",
        ]);
        expect(registration.canvases).toBe(1);
        expect(registration.commands).toBe(1);
        expect(registration.snapshots.map((snapshot) => snapshot.revision.sourceCommit)).toEqual(["source-1", "source-2"]);
      }

      const rawLedger = await readFile(ledgerPath, "utf8");

      const ledger = Value.Parse(LedgerSchema, rawLedger.trim().split("\n").map((line) => JSON.parse(line)));

      const canonicalBridge = await realpath(expectedBridge);

      expect(ledger.every((item) => item.kind === "python")).toBe(true);
      expect(ledger.every((item) => path.relative(canonicalBridge, item.script) === "")).toBe(true);
      expect(ledger.every((item) => item.args.length === 0)).toBe(true);
      expect(ledger.every((item) => item.cwd !== extensionRoot)).toBe(true);
      expect(ledger.filter((item) => item.request?.operation === "publish"))
        .toHaveLength(entry === "source" ? 1 : 0);

      expect(ledger).toHaveLength(2);

      if (entry === "source") {
        expect(ledger.map((item) => item.request?.operation)).toEqual(["read", "publish"]);
        const publication = ledger.find((item) => item.request?.operation === "publish");

        expect(publication?.request?.findings?.[0]?.payload.comments[0]?.content)
          .toContain("Keep %PATH% | $(echo unsafe) and \u65e5\u672c\u8a9e \u{1f916} verbatim.");
      } else {
        expect(ledger.map((item) => item.request?.operation)).toEqual(["snapshot", "snapshot"]);
      }
    } finally {
      vi.unstubAllEnvs();
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
