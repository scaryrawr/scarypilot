import { execFile } from "node:child_process";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  bridgeInvocation, bridgeReadRequest, bridgeScriptPath, createBridgeTransport, parseBridgeStderr,
  MAX_ITEM_BATCH_OUTPUT_BYTES, MAX_ITEM_CONTENT_BYTES, type ReadItemsRequest,
  type BridgeJson, type BridgeRequest, type BridgeDiagnostic,
} from "../src/ado-bridge.ts";
import { createAzureBridgeRunner } from "../src/ado-loader.ts";
import { createAdoPullRequestStateTool } from "../src/ado-tools.ts";

const fixtureScript = fileURLToPath(new URL("./fixtures/bridge-owner.mjs", import.meta.url));

const execFileAsync = promisify(execFile);

const fixtureBridge = createBridgeTransport(async () => ({
  file: process.execPath, args: [fixtureScript],
}));

describe("packaged bridge discovery", () => {
  it.each(["src/ado-bridge.ts", "dist/extension.mjs"])(
    "discovers the script relative to installed %s rather than cwd",
    async (entry) => {
      const root = path.resolve("installed plugin with spaces");
      const script = path.join(root, "skills", "azure-devops", "scripts", "ado-bridge.py");
      const moduleUrl = pathToFileURL(path.join(root, "extensions", "paired-review", entry)).href;

      await expect(bridgeScriptPath(moduleUrl, async (file) => file === script)).resolves.toBe(script);
    },
  );

  it("fails explicitly when the packaged script is missing", async () => {
    const exists = vi.fn(async () => false);

    await expect(bridgeScriptPath(import.meta.url, exists)).rejects.toThrow("Packaged Azure DevOps bridge was not found");
    expect(exists).toHaveBeenCalledTimes(1);
    expect(exists).toHaveBeenCalledWith(fileURLToPath(new URL("../../../skills/azure-devops/scripts/ado-bridge.py", import.meta.url)));
  });

  it.each([["darwin", "uv"], ["linux", "uv"], ["win32", "uv.exe"]] as const)(
    "uses a native executable on %s without a command shim",
    async (platform, executable) => {
      const script = path.resolve("installed plugin with spaces", "ado-bridge.py");
      const moduleUrl = pathToFileURL(path.resolve("installed", "extension.mjs")).href;
      const resolveScript = vi.fn(async () => script);

      expect(await bridgeInvocation(moduleUrl, platform, resolveScript)).toEqual({
        file: executable, args: ["run", "--script", script],
      });
      expect(resolveScript).toHaveBeenCalledWith(moduleUrl);
    },
  );
});

describe("bridge process boundary", () => {
  const batch: ReadItemsRequest = {
    operation: "readItems", org: "https://dev.azure.com/example", project: "project",
    repositoryId: "repo", items: [{ path: "/日本語 & %PATH% | $(echo unsafe)", commit: "a".repeat(40) }],
  };

  it("keeps batch scope and ordered domain item requests on stdin", async () => {
    await expect(fixtureBridge(batch)).resolves.toEqual({ request: batch });
  });

  it("rejects out-of-bound batches and undersized output budgets before launch", async () => {
    const resolveInvocation = vi.fn(async () => ({ file: process.execPath, args: [fixtureScript] }));
    const transport = createBridgeTransport(resolveInvocation);

    await expect(transport({ ...batch, items: [] })).rejects.toThrow();
    await expect(transport({ ...batch, items: Array(9).fill(batch.items[0]) })).rejects.toThrow();
    await expect(transport({ ...batch, items: [{ path: "/x", commit: "branch" }] })).rejects.toThrow();
    await expect(transport(batch, 32 * 1024 * 1024)).rejects.toThrow("bounded ASCII JSON output buffer");
    expect(resolveInvocation).not.toHaveBeenCalled();
    expect(MAX_ITEM_BATCH_OUTPUT_BYTES).toBe(8 * MAX_ITEM_CONTENT_BYTES * 6 + 64 * 1024);
  });

  it("accepts ASCII escape expansion larger than the old 32 MiB process buffer", async () => {
    const runner = createAzureBridgeRunner(fixtureBridge);

    const buffers = await runner.readItems!({
      ...batch, org: "https://dev.azure.com/large-batch-fixture", items: Array(3).fill(batch.items[0]),
    });

    expect(buffers).toHaveLength(3);
    expect(buffers.every((buffer) => buffer?.length === MAX_ITEM_CONTENT_BYTES)).toBe(true);
    expect(buffers[0]?.[0]).toBe(1);
  }, 30_000);

  it("sends exact authored text through real process stdin without shell interpretation", async () => {
    const request: BridgeRequest = {
      operation: "publish", org: "https://dev.azure.com/example", project: "project",
      repositoryId: "repo-id", pullRequestId: 42,
      findings: [{ findingId: "id", payload: {
        comments: [{ content: "body  with spaces & %PATH% | $(echo unsafe)\n\n- Generated with AI 🤖\n\n<!-- paired-review-finding:id -->" }],
      } }],
    };

    await expect(fixtureBridge(request)).resolves.toEqual({ request });
  });

  it("routes the production adapter through the bridge fixture instead of Azure CLI", async () => {
    const runner = createAzureBridgeRunner(fixtureBridge);

    const result = await runner.json([
      "repos", "pr", "show", "--id", "42", "--project", "project", "--org", "https://dev.azure.com/example",
    ]);

    expect(result).toEqual({ request: {
      operation: "read", resource: "pullRequest", org: "https://dev.azure.com/example",
      project: "project", pullRequestId: 42,
    } });
  });

  it("does not return success-shaped data when the owner fails", async () => {
    await expect(fixtureBridge({ operation: "snapshot", org: "https://dev.azure.com/failing-fixture", pullRequestId: 42 }))
      .rejects.toThrow("organization cooldown; defer 120s");
  });

  it.each([false, true])("relays only safe owner diagnostics when enabled is %s", async (enabled) => {
    const records: BridgeDiagnostic[] = [];

    const transport = createBridgeTransport(async () => ({
      file: process.execPath, args: [fixtureScript],
    }), { enabled: () => enabled, write: (record) => { records.push(record); } });

    const request: BridgeRequest = { operation: "snapshot", org: "https://dev.azure.com/diagnostic-fixture", pullRequestId: 42 };

    await expect(transport(request)).resolves.toEqual({ request });
    expect(records).toEqual(enabled ? [
      {
        type: "ado_request_diagnostic", source: "http", method: "GET", status: 200,
        attempt: 1, waitMs: 0, durationMs: 12, retryAfterSeconds: null,
      },
      { type: "ado_request_diagnostic", source: "cache", cacheHit: true },
      { type: "ado_request_diagnostic", source: "cache", cacheHit: true },
    ] : []);
    expect(JSON.stringify(records)).not.toContain("private");
  });

  it.each(["0", "1"])("honors ADO_REQUEST_DIAGNOSTICS=%s at the actual process boundary", async (optIn) => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      "--experimental-strip-types",
      fileURLToPath(new URL("./fixtures/diagnostics-host.mjs", import.meta.url)),
    ], {
      encoding: "utf8",
      env: { ...process.env, ADO_REQUEST_DIAGNOSTICS: optIn, NODE_NO_WARNINGS: "1" },
    });

    expect(JSON.parse(stdout)).toEqual({ request: {
      operation: "snapshot", org: "https://dev.azure.com/diagnostic-fixture", pullRequestId: 42,
    } });
    expect(stderr).toBe(optIn === "1" ? [
      '{"type":"ado_request_diagnostic","source":"http","method":"GET","status":200,"attempt":1,"waitMs":0,"durationMs":12,"retryAfterSeconds":null}',
      '{"type":"ado_request_diagnostic","source":"cache","cacheHit":true}',
      '{"type":"ado_request_diagnostic","source":"cache","cacheHit":true}',
      "",
    ].join("\n") : "");
  });

  it("parses owner error metadata separately from newline-delimited diagnostics", async () => {
    const stderr = [
      '{"type":"ado_request_diagnostic","source":"cache","cacheHit":true}',
      '{"error":"cooldown","deferred":true,"retryAt":1234}',
      "unstructured stderr is not a diagnostic",
    ].join("\n");

    expect(parseBridgeStderr(stderr)).toEqual({
      diagnostics: [{ type: "ado_request_diagnostic", source: "cache", cacheHit: true }],
      error: '{"error":"cooldown","deferred":true,"retryAt":1234}',
    });
  });

  it("accepts the complete owner diagnostic method enum and integer timing contract", () => {
    const record = {
      type: "ado_request_diagnostic", source: "http", method: "OTHER", status: 0,
      attempt: 2, waitMs: 100, durationMs: 12, retryAfterSeconds: 0.5,
    };

    expect(parseBridgeStderr(JSON.stringify(record)).diagnostics).toEqual([record]);
    expect(parseBridgeStderr(JSON.stringify({
      ...record, url: "private target", body: "private authored text", headers: { authorization: "private token" },
    })).diagnostics).toEqual([record]);
    expect(parseBridgeStderr(JSON.stringify({ ...record, waitMs: 0.5 })).diagnostics).toEqual([]);
    expect(parseBridgeStderr(JSON.stringify({ ...record, durationMs: -1 })).diagnostics).toEqual([]);
  });

  it("retains allowlisted rate-limit metadata without forwarding raw headers or targets", () => {
    const record = {
      type: "ado_request_diagnostic", source: "http", method: "GET", status: 200,
      attempt: 1, waitMs: 0, durationMs: 0, retryAfterSeconds: null,
      routeCategory: "threads", rateLimit: 200, rateRemaining: 0, rateCost: 1,
      cooldownUntil: 1007, cacheHit: false,
    };

    expect(parseBridgeStderr(JSON.stringify({
      ...record, headers: { "X-RateLimit-Limit": "private raw header" }, url: "private target",
    })).diagnostics).toEqual([record]);
    expect(parseBridgeStderr(JSON.stringify({ ...record, rateCost: -1 })).diagnostics).toEqual([]);
    expect(parseBridgeStderr(JSON.stringify({ ...record, rateLimit: "200" })).diagnostics).toEqual([]);
    expect(parseBridgeStderr(JSON.stringify({ ...record, routeCategory: "private target" })).diagnostics).toEqual([]);
    expect(parseBridgeStderr(JSON.stringify({
      type: "ado_request_diagnostic", source: "cache", cacheHit: true, routeCategory: "items",
    })).diagnostics).toEqual([{
      type: "ado_request_diagnostic", source: "cache", cacheHit: true, routeCategory: "items",
    }]);
  });

  it("rejects arbitrary Azure REST resource and write requests", async () => {
    expect(() => bridgeReadRequest([
      "devops", "invoke", "--org", "https://dev.azure.com/example", "--resource", "arbitrary",
      "--route-parameters", "project=project", "repositoryId=repo", "pullRequestId=42",
    ])).toThrow("Unsupported Azure DevOps bridge resource arbitrary");

    const runner = createAzureBridgeRunner(fixtureBridge);

    await expect(runner.json([
      "devops", "invoke", "--org", "https://dev.azure.com/example", "--resource", "pullRequestThreads",
      "--http-method", "POST",
    ])).rejects.toThrow("Unsupported Azure DevOps bridge request");
  });
});

describe("snapshot tool", () => {
  it("returns one fresh snapshot per invocation without local caching", async () => {
    const first: BridgeJson = {
      details: { pullRequestId: 42 }, reviewers: [{ id: "reviewer", vote: 0 }],
      threads: [{ id: 1, comments: [] }], policies: [{ id: "policy", status: "running" }],
      builds: { hasPending: true }, revision: { sourceCommit: "first" },
      observedAt: "2026-10-01T12:00:00Z",
    };

    const second: BridgeJson = {
      details: { pullRequestId: 42 }, reviewers: [{ id: "reviewer", vote: 10 }],
      threads: [{ id: 1, comments: [] }], policies: [{ id: "policy", status: "approved" }],
      builds: { hasPending: false }, revision: { sourceCommit: "second" },
      observedAt: "2026-10-01T12:10:00Z",
    };

    const bridge = vi.fn(async () => first).mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const tool = createAdoPullRequestStateTool(bridge);
    const args = { prUrl: "https://dev.azure.com/example/project/_git/repo/pullrequest/42" };
    const invocation = { sessionId: "session", toolCallId: "call", toolName: tool.name, arguments: args };

    expect(tool.name).toBe("azure_devops_pr_snapshot");
    expect(await tool.handler!(args, invocation)).toEqual({
      textResultForLlm: JSON.stringify(first),
      resultType: "success",
    });
    expect(await tool.handler!(args, invocation)).toEqual({
      textResultForLlm: JSON.stringify(second),
      resultType: "success",
    });
    expect(bridge).toHaveBeenCalledTimes(2);
    expect(bridge).toHaveBeenCalledWith({ operation: "snapshot", org: "https://dev.azure.com/example", pullRequestId: 42 });
  });

  it("returns a failure result for invalid input without calling the bridge", async () => {
    const bridge = vi.fn(async () => ({ revision: {} }));
    const tool = createAdoPullRequestStateTool(bridge);
    const args = { prUrl: "https://example.com/project/_git/repo/pullrequest/42" };
    const invocation = { sessionId: "session", toolCallId: "call", toolName: tool.name, arguments: args };

    expect(await tool.handler!(args, invocation)).toEqual({
      textResultForLlm: "URL is not hosted by Azure DevOps.",
      resultType: "failure",
    });
    expect(bridge).not.toHaveBeenCalled();
    expect(await tool.handler!({}, { ...invocation, arguments: {} })).toMatchObject({ resultType: "failure" });
  });

  it("preserves bridge defer metadata in a failure result without retrying", async () => {
    const bridge = vi.fn(async () => {
      throw new Error("organization cooldown; defer 120s");
    });

    const tool = createAdoPullRequestStateTool(bridge);
    const args = { prUrl: "https://dev.azure.com/example/project/_git/repo/pullrequest/42" };
    const invocation = { sessionId: "session", toolCallId: "call", toolName: tool.name, arguments: args };

    expect(await tool.handler!(args, invocation)).toEqual({
      textResultForLlm: "organization cooldown; defer 120s",
      resultType: "failure",
    });
    expect(bridge).toHaveBeenCalledTimes(1);
  });
});
