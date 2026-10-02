import { describe, expect, it, vi } from "vitest";
import { createBridgeTransport, type BridgeJson } from "../src/ado-bridge.ts";
import { createAdoWorkItemGetTool, createAdoWorkItemQueryTool, createAdoWorkItemSearchTool } from "../src/boards-tools.ts";

const scope = { org: "example", project: "Project & 日本語" };

const searchInput = { ...scope, text: "login" };

const queryInput = { ...scope, wiql: "SELECT [System.Id] FROM WorkItems" };

const getInput = { ...scope, id: 42, fields: ["System.Title"] };

const item = {
  id: 42, project: scope.project, title: "Login error", type: "Bug", state: "Active",
  assignedTo: null, areaPath: "Project & 日本語\\Client",
  url: "https://dev.azure.com/example/Project%20%26%20%E6%97%A5%E6%9C%AC%E8%AA%9E/_workitems/edit/42",
};

const searchResult = { count: 30, results: [item], returnedCount: 1, limit: 25, truncated: true };

const queryResult = {
  queryType: "flat", queryResultType: "workItem", asOf: "2026-10-01T00:00:00Z",
  columns: [{ referenceName: "System.Id", name: "ID" }],
  workItems: [{ id: 42, url: "https://dev.azure.com/example/_apis/wit/workItems/42" }],
  returnedCount: 1, limit: 25, truncated: false,
};

const getResult = {
  id: 42, rev: 3, url: "https://dev.azure.com/example/_apis/wit/workItems/42",
  fields: { "System.Title": "Login error" },
};

const invalidGetResults: BridgeJson[] = [
  { ...getResult, id: 43 }, { ...getResult, rev: 0 },
  { ...getResult, fields: { "System.TeamProject": "Another project" } },
  { ...getResult, url: "https://evil.invalid/item" },
  { ...getResult, url: "https://dev.azure.com/other/_apis/wit/workItems/42" },
  { ...getResult, url: "https://dev.azure.com/example/_apis/wit/workItems/43" },
  { ...getResult, fields: { "System.TeamProject": scope.project, invalid: "not a field reference" } },
  { ...getResult, fields: { "System.TeamProject": scope.project, "Custom.Unrequested": "not requested" } },
  { ...getResult, fields: { "System.TeamProject": scope.project, [`Custom.${"a".repeat(257)}`]: "too long" } },
  { ...getResult, fields: { "System.TeamProject": scope.project, "System.Title": "a".repeat(65537) } },
];

function invoke(tool: ReturnType<typeof createAdoWorkItemSearchTool>, args: BridgeJson) {
  return tool.handler!(args, { sessionId: "session", toolCallId: "call", toolName: tool.name, arguments: args });
}

describe("caller-visible Azure Boards tools", () => {
  it.each([
    [createAdoWorkItemSearchTool, searchInput, "azure_devops_work_item_search", "workItemSearch", searchResult],
    [createAdoWorkItemQueryTool, queryInput, "azure_devops_work_item_query", "workItemQuery", queryResult],
    [createAdoWorkItemGetTool, getInput, "azure_devops_work_item_get", "workItemGet", getResult],
  ] as const)("returns exact structured JSON from %s and sends only its domain operation", async (factory, input, name, operation, result) => {
    const bridge = vi.fn(async (): Promise<BridgeJson> => result);
    const tool = factory(bridge);
    expect(tool.name).toBe(name);
    expect(await invoke(tool, input)).toEqual({ resultType: "success", textResultForLlm: JSON.stringify(result) });

    const expectedRequest = operation === "workItemGet"
      ? { operation, ...input }
      : { operation, ...input, top: 25 };

    expect(bridge).toHaveBeenCalledExactlyOnceWith(expectedRequest);
  });

  it.each([
    {}, { ...searchInput, surprise: true }, { ...searchInput, text: "" }, { ...searchInput, text: " \n " },
    { ...searchInput, text: "a".repeat(4097) }, { ...searchInput, top: 0 }, { ...searchInput, top: 101 },
    { ...searchInput, top: true }, { ...searchInput, top: 2.5 }, { ...searchInput, top: "25" }, { ...searchInput, types: [] },
    { ...searchInput, areas: [" "] }, { ...searchInput, types: Array(17).fill("Bug") },
  ])("rejects search input before bridge invocation %#", async (args) => {
    const bridge = vi.fn(async () => searchResult);
    expect(await invoke(createAdoWorkItemSearchTool(bridge), args)).toMatchObject({ resultType: "failure" });
    expect(bridge).not.toHaveBeenCalled();
  });

  it.each([
    { ...queryInput, wiql: "\t" }, { ...queryInput, wiql: "a".repeat(32769) },
    { ...queryInput, top: -1 }, { ...queryInput, top: 1.1 }, { ...queryInput, top: "25" }, { ...queryInput, fields: [] },
  ])("rejects query input before bridge invocation %#", async (args) => {
    const bridge = vi.fn(async () => queryResult);
    expect(await invoke(createAdoWorkItemQueryTool(bridge), args)).toMatchObject({ resultType: "failure" });
    expect(bridge).not.toHaveBeenCalled();
  });

  it.each([
    { ...getInput, id: 0 }, { ...getInput, id: -1 }, { ...getInput, id: 2147483648 },
    { ...getInput, id: true }, { ...getInput, id: 1.1 }, { ...getInput, id: "42" },
    { ...getInput, fields: [] }, { ...getInput, fields: ["System.Title", "System.Title"] },
    { ...getInput, fields: ["not a field"] }, { ...getInput, url: "https://example.invalid" },
  ])("rejects get input before bridge invocation %#", async (args) => {
    const bridge = vi.fn(async () => getResult);
    expect(await invoke(createAdoWorkItemGetTool(bridge), args)).toMatchObject({ resultType: "failure" });
    expect(bridge).not.toHaveBeenCalled();
  });

  it.each([
    { org: "" }, { org: " " }, { org: "https://dev.azure.com/example/project" },
    { org: "https://dev.azure.com/example?token=secret" }, { org: "https://evil.invalid/example" },
    { org: "http://dev.azure.com/example" }, { org: "https://user@dev.azure.com/example" },
    { project: "" }, { project: "  " }, { project: "." }, { project: ".." }, { project: "one/two" },
    { project: "one\\two" }, { project: "%2Fescape" }, { project: "%252e%252e" }, { project: "Project\n" },
    { project: "%2f%" }, { project: "%2f%ff" }, { project: "%255c%" },
  ])("rejects unsafe scope on all three caller boundaries %#", async (invalid) => {
    for (const [factory, input] of [
      [createAdoWorkItemSearchTool, searchInput], [createAdoWorkItemQueryTool, queryInput], [createAdoWorkItemGetTool, getInput],
    ] as const) {
      const bridge = vi.fn(async () => getResult);
      expect(await invoke(factory(bridge), { ...input, ...invalid })).toMatchObject({ resultType: "failure" });
      expect(bridge).not.toHaveBeenCalled();
    }
  });

  it("validates the discriminated bridge request before resolving any child process", async () => {
    const resolve = vi.fn(async () => ({ file: "must-not-launch", args: [] }));
    const bridge = createBridgeTransport(resolve);
    await expect(bridge({ operation: "workItemSearch", ...scope, text: " ", top: 25 })).rejects.toThrow("Invalid Azure Boards data");
    await expect(bridge({ operation: "workItemGet", ...scope, id: 0 })).rejects.toThrow("Invalid Azure Boards data");
    await expect(bridge({ operation: "workItemQuery", ...scope, project: "%2f", wiql: "SELECT" })).rejects.toThrow("project path");
    const unknownProperties = { operation: "workItemGet" as const, ...scope, id: 42, unexpected: true };
    await expect(bridge(unknownProperties)).rejects.toThrow("Invalid Azure Boards data");
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    {}, { ...searchResult, count: -1 }, { ...searchResult, returnedCount: 0 },
    { ...searchResult, limit: 100 }, { ...searchResult, truncated: false },
    { ...searchResult, results: [{ ...item, id: 0 }] }, { ...searchResult, results: [{ ...item, title: null }] },
    { ...searchResult, count: 0 }, { ...searchResult, unexpected: true },
    { ...searchResult, results: [{ ...item, project: "Other" }] },
    { ...searchResult, results: [{ ...item, url: "https://dev.azure.com/other/Project/_workitems/edit/42" }] },
  ])("fails explicitly for malformed search data %#", async (result) => {
    expect(await invoke(createAdoWorkItemSearchTool(async () => result), searchInput)).toMatchObject({ resultType: "failure" });
  });

  it.each([
    { ...queryResult, queryType: "tree" }, { ...queryResult, workItemRelations: [] },
    { ...queryResult, queryResultType: "workItemLink" }, { ...queryResult, asOf: "" },
    { ...queryResult, returnedCount: 2 }, { ...queryResult, truncated: true },
    { ...queryResult, columns: [{ referenceName: "System.Id" }] },
    { ...queryResult, workItems: [{ id: true, url: "https://dev.azure.com/example/_apis/wit/workItems/42" }] },
    { ...queryResult, workItems: [{ id: 42, url: "https://dev.azure.com/other/_apis/wit/workItems/42" }] },
    { ...queryResult, workItems: [{ id: 42, url: "https://dev.azure.com/example/_apis/wit/workItems/43" }] },
  ])("does not invent flat query defaults for malformed or unsupported results %#", async (result) => {
    expect(await invoke(createAdoWorkItemQueryTool(async () => result), queryInput)).toMatchObject({ resultType: "failure" });
  });

  it.each(invalidGetResults)("rejects get ID, ownership, and field-content failures %#", async (result) => {
    expect(await invoke(createAdoWorkItemGetTool(async () => result), getInput)).toMatchObject({ resultType: "failure" });
  });

  it.each(["Project & 日本語", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"])(
    "returns only selected fields after the bridge verifies project scope %s", async (project) => {
      const bridge = vi.fn(async () => getResult);
      expect(await invoke(createAdoWorkItemGetTool(bridge), { ...getInput, project })).toEqual({
        resultType: "success", textResultForLlm: JSON.stringify(getResult),
      });
      expect(bridge).toHaveBeenCalledExactlyOnceWith({ operation: "workItemGet", ...getInput, project });
    },
  );

  it("keeps project ownership visible when selected or returned with default fields", async () => {
    const result = { ...getResult, fields: { ...getResult.fields, "System.TeamProject": scope.project } };

    for (const args of [{ ...getInput, fields: ["System.Title", "System.TeamProject"] }, { ...scope, id: 42 }]) {
      expect(await invoke(createAdoWorkItemGetTool(async () => result), args)).toEqual({
        resultType: "success", textResultForLlm: JSON.stringify(result),
      });
    }

    expect(await invoke(createAdoWorkItemGetTool(async () => getResult), { ...scope, id: 42 })).toMatchObject({
      resultType: "failure",
    });
  });

  it("returns empty search and query results only with complete valid response shapes", async () => {
    const emptySearch = { count: 0, results: [], returnedCount: 0, limit: 25, truncated: false };
    const emptyQuery = { ...queryResult, workItems: [], returnedCount: 0 };
    expect(await invoke(createAdoWorkItemSearchTool(async () => emptySearch), searchInput)).toEqual({
      resultType: "success", textResultForLlm: JSON.stringify(emptySearch),
    });
    expect(await invoke(createAdoWorkItemQueryTool(async () => emptyQuery), queryInput)).toEqual({
      resultType: "success", textResultForLlm: JSON.stringify(emptyQuery),
    });
  });

  it("rejects a serialized result above 1 MiB rather than silently slicing titles", async () => {
    const results = Array.from({ length: 25 }, (_, index) => ({
      ...item, id: index + 1, title: "x".repeat(65536),
      url: item.url.slice(0, -2) + String(index + 1),
    }));

    const result = { count: 25, results, returnedCount: 25, limit: 25, truncated: false };
    expect(await invoke(createAdoWorkItemSearchTool(async () => result), searchInput)).toMatchObject({
      resultType: "failure", textResultForLlm: expect.stringContaining("exceeds 1 MiB"),
    });
  });

  it("accepts exactly 1 MiB of serialized get fields and rejects one extra byte", async () => {
    const fields: Record<string, string> = {};
    const requested = Array.from({ length: 16 }, (_, index) => `Custom.F${index}`);

    for (const field of requested.slice(0, -1)) fields[field] = "x".repeat(65536);
    fields["Custom.F15"] = "";
    const result = { ...getResult, fields };
    fields["Custom.F15"] = "x".repeat(1024 * 1024 - Buffer.byteLength(JSON.stringify(result)));
    const args = { ...getInput, fields: requested };
    const accepted = await invoke(createAdoWorkItemGetTool(async () => result), args);
    const serialized = JSON.stringify(result);
    expect(accepted).toEqual({ resultType: "success", textResultForLlm: serialized });
    expect(Buffer.byteLength(serialized)).toBe(1024 * 1024);
    fields["Custom.F15"] += "x";
    expect(await invoke(createAdoWorkItemGetTool(async () => result), args)).toMatchObject({
      resultType: "failure", textResultForLlm: expect.stringContaining("exceeds 1 MiB"),
    });
  });

  it.each([
    "Azure CLI token unavailable; sign in or set AZURE_DEVOPS_EXT_PAT",
    'Azure DevOps bridge request failed: {"error":"cooldown","deferred":true,"retryAt":1234}',
    'Azure DevOps bridge request failed: {"error":"incomplete read","code":"incomplete_read"}',
    "HTTP read failed; check Azure DevOps connectivity",
  ])("preserves actionable transport failure and metadata on every tool %s", async (message) => {
    for (const [factory, input] of [
      [createAdoWorkItemSearchTool, searchInput], [createAdoWorkItemQueryTool, queryInput], [createAdoWorkItemGetTool, getInput],
    ] as const) {
      const bridge = vi.fn(async () => { throw new Error(message); });
      expect(await invoke(factory(bridge), input)).toEqual({ resultType: "failure", textResultForLlm: message });
      expect(bridge).toHaveBeenCalledTimes(1);
    }
  });

  it("passes nested WIQL and literal/comment decoys unchanged to the ownership-enforcing bridge", async () => {
    const wiql = "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @Project AND " +
      "([System.Title] = 'OR [System.TeamProject] = ''Other''' OR [System.State] = 'Active') " +
      "/* WHERE [System.TeamProject] = 'Other' */";

    const bridge = vi.fn(async (): Promise<BridgeJson> => queryResult);

    expect(await invoke(createAdoWorkItemQueryTool(bridge), { ...queryInput, wiql })).toEqual({
      resultType: "success", textResultForLlm: JSON.stringify(queryResult),
    });
    expect(bridge).toHaveBeenCalledExactlyOnceWith({ operation: "workItemQuery", ...queryInput, wiql, top: 25 });
  });

  it.each([
    'Azure DevOps bridge request failed: {"error":"Azure Boards query project mismatch","code":"unsupported_query"}',
    'Azure DevOps bridge request failed: {"error":"incomplete Azure Boards WIQL ownership result","code":"incomplete_read"}',
    "Azure DevOps HTTP 400",
  ])("exposes query scope and verification failures without returning partial references %s", async (message) => {
    const bridge = vi.fn(async () => { throw new Error(message); });
    expect(await invoke(createAdoWorkItemQueryTool(bridge), queryInput)).toEqual({
      resultType: "failure", textResultForLlm: message,
    });
    expect(bridge).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized query metadata rather than returning sliced references or columns", async () => {
    const result = { ...queryResult, columns: Array.from({ length: 16 }, (_, index) => ({
      referenceName: `Custom.F${index}`, name: "x".repeat(65536),
    })) };

    expect(await invoke(createAdoWorkItemQueryTool(async () => result), queryInput)).toMatchObject({
      resultType: "failure", textResultForLlm: expect.stringContaining("exceeds 1 MiB"),
    });
  });
});
