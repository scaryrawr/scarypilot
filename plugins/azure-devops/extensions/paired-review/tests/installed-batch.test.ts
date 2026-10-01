import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { expect, it, vi } from "vitest";
import { MAX_ITEM_BATCH_SIZE } from "../src/ado-bridge.ts";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

const LedgerSchema = Type.Array(Type.Object({
  kind: Type.Literal("python"), authCalls: Type.Integer(), httpCalls: Type.Integer(),
  args: Type.Array(Type.String()),
  request: Type.Object({
    operation: Type.String(),
    items: Type.Optional(Type.Array(Type.Object({ path: Type.String(), commit: Type.String() }))),
  }, { additionalProperties: true }),
}));

it("loads installed source with native uv, bounded process counts and one credential lookup per cached batch", async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "installed-ado-batch-"));
  const plugin = path.join(scratch, "installed plugin with spaces", "azure-devops");
  const extensionRoot = path.join(plugin, "extensions", "paired-review");
  const helperRoot = path.join(plugin, "skills", "azure-devops", "scripts");
  const ledgerPath = path.join(scratch, "requests.jsonl");

  try {
    await mkdir(extensionRoot, { recursive: true });
    await cp(path.resolve(packageRoot, "../../skills/azure-devops/scripts"), helperRoot, {
      recursive: true,
      filter: (source) => !["tests", "__pycache__"].includes(path.basename(source)),
    });
    await cp(path.join(helperRoot, "ado-bridge.py"), path.join(helperRoot, "real-bridge.py"));
    await cp(fileURLToPath(new URL("./fixtures/installed-batch-owner.py", import.meta.url)), path.join(helperRoot, "ado-bridge.py"));
    await cp(path.join(packageRoot, "src"), path.join(extensionRoot, "src"), { recursive: true });
    await symlink(path.join(packageRoot, "node_modules"), path.join(extensionRoot, "node_modules"), "junction");

    for (const [key, value] of Object.entries({
      ADO_TEST_BATCH_LEDGER: ledgerPath, ADO_TEST_BATCH_STATE: path.join(scratch, "state"),
      TMPDIR: scratch, TMP: scratch, TEMP: scratch, UV_OFFLINE: "1", UV_PYTHON_DOWNLOADS: "never",
    })) vi.stubEnv(key, value);

    const installed: typeof import("../src/ado-loader.ts") = await import(
      pathToFileURL(path.join(extensionRoot, "src", "ado-loader.ts")).href
    );

    const url = "https://dev.azure.com/example/project/_git/repo/pullrequest/42";
    const first = await installed.loadAzurePullRequest(url);
    const second = await installed.loadAzurePullRequest(url);

    expect(second.files).toEqual(first.files);
    expect(first.files).toHaveLength(17);
    expect(first.files[0]).toMatchObject({ oldContent: "old\n", newContent: "new 日本語 🤖\n" });

    const ledger = Value.Parse(LedgerSchema, (await readFile(ledgerPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line)));
    expect(ledger).toHaveLength(18);
    expect(ledger.every((record) => record.args.length === 0)).toBe(true);
    const batches = ledger.filter((record) => record.request.operation === "readItems");
    expect(batches).toHaveLength(10);
    expect(batches.map((record) => record.request.items?.length)).toEqual([8, 8, 8, 8, 2, 8, 8, 8, 8, 2]);
    expect(batches.every((record) => record.request.items!.length <= MAX_ITEM_BATCH_SIZE)).toBe(true);
    expect(batches.every((record) => record.authCalls === 1)).toBe(true);
    expect(batches.slice(0, 5).reduce((sum, record) => sum + record.httpCalls, 0)).toBe(34);
    expect(batches.slice(5).every((record) => record.httpCalls === 0)).toBe(true);
    expect(ledger.filter((record) => record.request.operation === "read")).toHaveLength(8);
  } finally {
    vi.unstubAllEnvs();
    await rm(scratch, { recursive: true, force: true });
  }
}, 30_000);
