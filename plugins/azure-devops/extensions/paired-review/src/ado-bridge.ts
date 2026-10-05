import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { BoardsRequestSchema, MAX_BOARDS_OUTPUT_BYTES, checkBoardsValue, validateBoardsScope, type BoardsRequest } from "./boards-schema.ts";

const JsonValueSchema = Type.Recursive((self) =>
  Type.Union([
    Type.Boolean(), Type.Null(), Type.Number(), Type.String(),
    Type.Array(self), Type.Record(Type.String(), self),
  ]),
);

export type BridgeJson = Static<typeof JsonValueSchema>;

interface BridgeScope {
  org: string;
  project: string;
}

interface PullRequestScope extends BridgeScope {
  repositoryId: string;
  pullRequestId: number;
}

export const MAX_ITEM_BATCH_SIZE = 8;

export const MAX_ITEM_CONTENT_BYTES = 2 * 1024 * 1024;

// ASCII JSON can expand every decoded byte into a six-byte escape.
export const MAX_ITEM_BATCH_OUTPUT_BYTES = MAX_ITEM_BATCH_SIZE * MAX_ITEM_CONTENT_BYTES * 6 + 64 * 1024;

export const ReadItemsRequestSchema = Type.Object({
  operation: Type.Literal("readItems"),
  org: Type.String({ minLength: 1, maxLength: 2048 }),
  project: Type.String({ minLength: 1, maxLength: 4096 }),
  repositoryId: Type.String({ minLength: 1, maxLength: 4096 }),
  items: Type.Array(Type.Object({
    path: Type.String({ minLength: 1, maxLength: 4096 }),
    commit: Type.String({ pattern: "^[0-9a-fA-F]{40}$" }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: MAX_ITEM_BATCH_SIZE }),
}, { additionalProperties: false });

export const ReadItemsResponseSchema = Type.Object({
  results: Type.Array(Type.Union([
    Type.Object({
      kind: Type.Literal("text"),
      content: Type.String({ maxLength: MAX_ITEM_CONTENT_BYTES }),
    }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("binary") }, { additionalProperties: false }),
    Type.Object({
      kind: Type.Literal("error"),
      error: Type.String({ maxLength: 1024 }),
      code: Type.Optional(Type.String({ maxLength: 1024 })),
      deferred: Type.Optional(Type.Literal(true)),
      retryAt: Type.Optional(Type.Number()),
    }, { additionalProperties: false }),
  ]), { minItems: 1, maxItems: MAX_ITEM_BATCH_SIZE }),
}, { additionalProperties: false });

export type ReadItemsRequest = Static<typeof ReadItemsRequestSchema>;

export type BridgeRequest =
  | BoardsRequest
  | ReadItemsRequest
  | (BridgeScope & {
      operation: "read";
      resource: "pullRequest";
      pullRequestId: number;
    })
  | (PullRequestScope & {
      operation: "read";
      resource: "iterations" | "threads";
    })
  | (PullRequestScope & {
      operation: "read";
      resource: "changes";
      iterationId: number;
    })
  | (BridgeScope & {
      operation: "read";
      resource: "item";
      repositoryId: string;
      path: string;
      commit: string;
    })
  | (PullRequestScope & {
      operation: "publish";
      findings: Array<{ findingId: string; payload: BridgeJson }>;
    })
  | { operation: "snapshot"; org: string; pullRequestId: number };

export type BridgeRunner = (request: BridgeRequest, maxBuffer?: number) => Promise<BridgeJson>;

const RouteCategorySchema = Type.Union([
  Type.Literal("pullRequest"), Type.Literal("iterations"), Type.Literal("changes"),
  Type.Literal("threads"), Type.Literal("items"), Type.Literal("builds"),
  Type.Literal("policies"), Type.Literal("workItems"), Type.Literal("workItemQuery"),
  Type.Literal("workItemSearch"), Type.Literal("labels"), Type.Literal("other"),
]);

const NullableMetricSchema = Type.Union([Type.Number({ minimum: 0 }), Type.Null()]);

const BridgeDiagnosticSchema = Type.Union([
  Type.Object({
    type: Type.Literal("ado_request_diagnostic"),
    source: Type.Literal("http"),
    method: Type.Union([
      Type.Literal("GET"), Type.Literal("POST"), Type.Literal("PATCH"),
      Type.Literal("PUT"), Type.Literal("DELETE"), Type.Literal("HEAD"),
      Type.Literal("OPTIONS"), Type.Literal("OTHER"),
    ]),
    status: Type.Integer(),
    attempt: Type.Integer({ minimum: 1 }),
    waitMs: Type.Integer({ minimum: 0 }),
    durationMs: Type.Integer({ minimum: 0 }),
    retryAfterSeconds: NullableMetricSchema,
    routeCategory: Type.Optional(RouteCategorySchema),
    rateLimit: Type.Optional(NullableMetricSchema),
    rateRemaining: Type.Optional(NullableMetricSchema),
    rateCost: Type.Optional(NullableMetricSchema),
    cooldownUntil: Type.Optional(NullableMetricSchema),
    cacheHit: Type.Optional(Type.Literal(false)),
  }),
  Type.Object({
    type: Type.Literal("ado_request_diagnostic"),
    source: Type.Literal("cache"),
    cacheHit: Type.Literal(true),
    routeCategory: Type.Optional(Type.Literal("items")),
  }),
]);

const BridgeErrorSchema = Type.Object({
  error: Type.String(),
  code: Type.Optional(Type.String()),
  deferred: Type.Optional(Type.Boolean()),
  retryAt: Type.Optional(Type.Union([Type.Number(), Type.String()])),
}, { additionalProperties: false });

export type BridgeDiagnostic = Static<typeof BridgeDiagnosticSchema>;

interface BridgeDiagnosticsOutput {
  enabled(): boolean;
  write(record: BridgeDiagnostic): void;
}

export function parseBridgeStderr(stderr: string) {
  const diagnostics: BridgeDiagnostic[] = [];
  let error: string | undefined;

  for (const line of stderr.split(/\r?\n/)) {
    let record: unknown;

    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    if (Value.Check(BridgeDiagnosticSchema, record)) {
      diagnostics.push(Value.Parse(BridgeDiagnosticSchema, Value.Clean(BridgeDiagnosticSchema, record)));
    } else if (Value.Check(BridgeErrorSchema, record)) {
      error = JSON.stringify(record);
    }
  }

  return { diagnostics, error };
}

export async function bridgeScriptPath(
  moduleUrl = import.meta.url,
  exists: (file: string) => Promise<boolean> = async (file) => {
    try {
      await access(file);

      return true;
    } catch {
      return false;
    }
  },
): Promise<string> {
  const candidate = fileURLToPath(new URL("../../../skills/azure-devops/scripts/ado-bridge.py", moduleUrl));

  if (await exists(candidate)) return candidate;

  throw new Error("Packaged Azure DevOps bridge was not found relative to the extension.");
}

export async function bridgeInvocation(
  moduleUrl = import.meta.url,
  platform = process.platform,
  resolveScript: (moduleUrl: string) => Promise<string> = bridgeScriptPath,
): Promise<{ file: string; args: string[] }> {
  return {
    file: platform === "win32" ? "uv.exe" : "uv",
    args: ["run", "--script", await resolveScript(moduleUrl)],
  };
}

export function createBridgeTransport(
  resolveInvocation: () => Promise<{ file: string; args: string[] }> = bridgeInvocation,
  diagnostics: BridgeDiagnosticsOutput = {
    enabled: () => process.env.ADO_REQUEST_DIAGNOSTICS === "1",
    write: (record) => { process.stderr.write(`${JSON.stringify(record)}\n`); },
  },
): BridgeRunner {
  return async (request, maxBuffer = request.operation === "readItems" ? MAX_ITEM_BATCH_OUTPUT_BYTES
    : ["workItemSearch", "workItemQuery", "workItemGet"].includes(request.operation) ? MAX_BOARDS_OUTPUT_BYTES + 1024
      : 32 * 1024 * 1024) => {
    if (request.operation === "workItemSearch" || request.operation === "workItemQuery" || request.operation === "workItemGet") {
      const boards = checkBoardsValue(BoardsRequestSchema, request);
      validateBoardsScope(boards.project);
    }

    if (request.operation === "readItems") {
      Value.Assert(ReadItemsRequestSchema, request);

      if (maxBuffer < MAX_ITEM_BATCH_OUTPUT_BYTES) {
        throw new Error("Azure DevOps item batch requires its bounded ASCII JSON output buffer.");
      }
    }

    const invocation = await resolveInvocation();

    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(invocation.file, invocation.args, {
        encoding: "utf8",
        maxBuffer,
        windowsHide: true,
        shell: false,
      }, (error, stdout, stderr) => {
        const parsedStderr = parseBridgeStderr(stderr);

        if (diagnostics.enabled()) {
          for (const record of parsedStderr.diagnostics) diagnostics.write(record);
        }

        if (error) {
          const message = parsedStderr.error ?? (stderr.trim() ? "bridge process failed without a structured error" : error.message);

          reject(new Error(`Azure DevOps bridge request failed: ${message}`));
        } else {
          resolve(stdout);
        }
      });

      child.stdin?.on("error", reject);
      child.stdin?.end(JSON.stringify(request));
    });

    return Value.Parse(JsonValueSchema, JSON.parse(stdout));
  };
}

export const runBridge = createBridgeTransport();

export function bridgeReadRequest(args: string[]): Extract<BridgeRequest, { operation: "read" }> {
  const option = (name: string): string => {
    const index = args.indexOf(name);
    const value = index >= 0 ? args[index + 1] : undefined;

    if (!value || value.startsWith("--")) throw new Error(`Missing Azure DevOps argument ${name}.`);

    return value;
  };

  const parameter = (name: string): string => {
    const value = args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);

    if (!value) throw new Error(`Missing Azure DevOps parameter ${name}.`);

    return value;
  };

  const numeric = (value: string): number => {
    const number = Number(value);

    if (!Number.isSafeInteger(number) || number < 1) throw new Error("Invalid Azure DevOps identifier.");

    return number;
  };

  const org = option("--org");

  if (args[0] === "repos" && args[1] === "pr" && args[2] === "show") {
    return {
      operation: "read",
      resource: "pullRequest",
      org,
      project: args.includes("--project") ? option("--project") : "",
      pullRequestId: numeric(option("--id")),
    };
  }

  if (args[0] !== "devops" || args[1] !== "invoke" || args.includes("--http-method")) {
    throw new Error("Unsupported Azure DevOps bridge request.");
  }

  const scope = { org, project: parameter("project"), repositoryId: parameter("repositoryId") };
  const resource = option("--resource");

  if (resource === "items") {
    return {
      operation: "read", resource: "item", ...scope,
      path: parameter("path"), commit: parameter("versionDescriptor.version"),
    };
  }

  const pullRequestId = numeric(parameter("pullRequestId"));

  switch (resource) {
    case "pullRequestIterations":
      return { operation: "read", resource: "iterations", ...scope, pullRequestId };
    case "pullRequestThreads":
      return { operation: "read", resource: "threads", ...scope, pullRequestId };
    case "pullRequestIterationChanges":
      return { operation: "read", resource: "changes", ...scope, pullRequestId, iterationId: numeric(parameter("iterationId")) };
    default:
      throw new Error(`Unsupported Azure DevOps bridge resource ${resource}.`);
  }
}
