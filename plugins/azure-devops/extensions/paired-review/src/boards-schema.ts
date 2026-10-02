import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { BridgeJson } from "./ado-bridge.ts";

export const MAX_BOARDS_OUTPUT_BYTES = 1024 * 1024;

const strict = { additionalProperties: false };

const nonblank = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: "\\S" });

const org = Type.String({
  minLength: 1, maxLength: 2048,
  pattern: "^(?:[A-Za-z0-9][A-Za-z0-9_-]*|https://dev\\.azure\\.com(?::443)?/[A-Za-z0-9][A-Za-z0-9_-]*/?|https://[A-Za-z0-9][A-Za-z0-9_-]*\\.visualstudio\\.com(?::443)?(?:/DefaultCollection)?/?)$",
});

const project = Type.String({ minLength: 1, maxLength: 4096, pattern: "^(?!\\s*$)(?!\\.{1,2}$)[^/\\\\\\x00-\\x1f\\x7f]+$" });

const id = Type.Integer({ minimum: 1, maximum: 2147483647 });

const top = Type.Integer({ minimum: 1, maximum: 100 });

const field = Type.String({ maxLength: 256, pattern: "^(?=.{1,256}$)[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z0-9_]+)+$" });

const filters = Type.Array(nonblank(4096), { minItems: 1, maxItems: 16 });

const scope = { org, project };

export const WorkItemSearchInputSchema = Type.Object({
  ...scope, text: nonblank(4096), top: Type.Optional(top),
  types: Type.Optional(filters), areas: Type.Optional(filters),
}, strict);

export const WorkItemQueryInputSchema = Type.Object({
  ...scope, wiql: nonblank(32768), top: Type.Optional(top),
}, strict);

export const WorkItemGetInputSchema = Type.Object({
  ...scope, id, fields: Type.Optional(Type.Array(field, { minItems: 1, maxItems: 32, uniqueItems: true })),
}, strict);

export const WorkItemSearchRequestSchema = Type.Object({
  ...WorkItemSearchInputSchema.properties, operation: Type.Literal("workItemSearch"),
}, strict);

export const WorkItemQueryRequestSchema = Type.Object({
  ...WorkItemQueryInputSchema.properties, operation: Type.Literal("workItemQuery"),
}, strict);

export const WorkItemGetRequestSchema = Type.Object({
  ...WorkItemGetInputSchema.properties, operation: Type.Literal("workItemGet"),
}, strict);

export const BoardsRequestSchema = Type.Union([
  WorkItemSearchRequestSchema, WorkItemQueryRequestSchema, WorkItemGetRequestSchema,
]);

export type BoardsRequest = Static<typeof BoardsRequestSchema>;

export type WorkItemSearchInput = Static<typeof WorkItemSearchInputSchema>;

export type WorkItemQueryInput = Static<typeof WorkItemQueryInputSchema>;

export type WorkItemGetInput = Static<typeof WorkItemGetInputSchema>;

export const DEFAULT_WORK_ITEM_FIELDS = [
  "System.Id", "System.TeamProject", "System.WorkItemType", "System.Title", "System.State",
  "System.AssignedTo", "System.AreaPath", "System.IterationPath", "System.ChangedDate",
] as const;

const text = Type.String({ maxLength: 65536 });

const nullableText = Type.Union([text, Type.Null()]);

const url = Type.String({ minLength: 1, maxLength: 16384, pattern: "^https://dev\\.azure\\.com/" });

const paging = { returnedCount: Type.Integer({ minimum: 0, maximum: 100 }), limit: top, truncated: Type.Boolean() };

export const WorkItemSearchResultSchema = Type.Object({
  count: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  results: Type.Array(Type.Object({
    id, project: nonblank(4096), title: text, type: nonblank(65536), state: nonblank(65536),
    assignedTo: nullableText, areaPath: nullableText, url,
  }, strict), { maxItems: 100 }),
  ...paging,
}, strict);

export const WorkItemQueryResultSchema = Type.Object({
  queryType: Type.Literal("flat"), queryResultType: Type.Literal("workItem"), asOf: nonblank(256),
  columns: Type.Array(Type.Object({ referenceName: field, name: nonblank(65536) }, strict), { maxItems: 100 }),
  workItems: Type.Array(Type.Object({ id, url }, strict), { maxItems: 100 }),
  ...paging,
}, strict);

const JsonFieldSchema = Type.Recursive((self) => Type.Union([
  Type.Null(), Type.Boolean(), Type.Number(), text,
  Type.Array(self, { maxItems: 1024 }),
  Type.Record(Type.String({ pattern: "^[\\s\\S]{0,256}$" }), self, { maxProperties: 1024, additionalProperties: false }),
]));

export const WorkItemGetResultSchema = Type.Object({
  id, rev: id, url,
  fields: Type.Record(field, JsonFieldSchema, { maxProperties: 32, additionalProperties: false }),
}, strict);

export type WorkItemSearchResult = Static<typeof WorkItemSearchResultSchema>;

export type WorkItemQueryResult = Static<typeof WorkItemQueryResultSchema>;

export type WorkItemGetResult = Static<typeof WorkItemGetResultSchema>;

export function checkBoardsValue<S extends TSchema>(schema: S, value: BridgeJson): Static<S> {
  if (!Value.Check(schema, value)) {
    const error = Value.Errors(schema, value).First();
    throw new Error(`Invalid Azure Boards data ${error?.path ?? ""}: ${error?.message ?? "schema mismatch"}`);
  }

  return value;
}

export function validateBoardsScope(projectName: string): void {
  let decoded = projectName;

  for (let pass = 0; pass < 4; pass++) {
    const next = decoded.replace(/%([0-9a-f]{2})/gi, (encoded: string, hex: string) => {
      const byte = Number.parseInt(hex, 16);

      return byte <= 0x7f ? String.fromCharCode(byte) : encoded;
    });

    if (next === decoded) break;
    decoded = next;

    if (pass === 3) throw new Error("Invalid Azure Boards project encoding");
  }

  if (/[/\\]/.test(decoded) || decoded === "." || decoded === "..") {
    throw new Error("Invalid Azure Boards project path");
  }

  for (const character of decoded) {
    const code = character.charCodeAt(0);

    if (code < 32 || code === 127) throw new Error("Invalid Azure Boards project path");
  }
}

export function validateBoardsUrl(value: string, org: string, id: number, project?: string): void {
  const organization = org.startsWith("https://")
    ? new URL(org).hostname === "dev.azure.com"
      ? new URL(org).pathname.split("/")[1]!.toLowerCase()
      : new URL(org).hostname.slice(0, -".visualstudio.com".length).toLowerCase()
    : org.toLowerCase();

  const parsed = new URL(value);

  if (parsed.protocol !== "https:" || parsed.hostname !== "dev.azure.com" || parsed.username ||
      parsed.password || parsed.hash || (parsed.port && parsed.port !== "443")) {
    throw new Error("Invalid Azure Boards response URL");
  }

  const segments = parsed.pathname.split("/").slice(1).map(decodeURIComponent);
  const expectedTail = project === undefined ? ["_apis", "wit", "workitems", String(id)] : ["_workitems", "edit", String(id)];
  const tail = segments.slice(-expectedTail.length).map((segment) => segment.toLowerCase());

  if (segments[0]?.toLowerCase() !== organization ||
      JSON.stringify(tail) !== JSON.stringify(expectedTail) ||
      (project === undefined ? ![5, 6].includes(segments.length) : segments.length !== 5 || segments[1] !== project)) {
    throw new Error("Azure Boards response URL, ID, or organization mismatch");
  }
}

export function serializeBoardsResult(value: WorkItemSearchResult | WorkItemQueryResult | WorkItemGetResult): string {
  const serialized = JSON.stringify(value);

  if (Buffer.byteLength(serialized, "utf8") > MAX_BOARDS_OUTPUT_BYTES) {
    throw new Error("Azure Boards result exceeds 1 MiB; request fewer items or fields.");
  }

  return serialized;
}
