import { createTwoFilesPatch } from "diff";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { bridgeReadRequest, runBridge, type BridgeRequest, type BridgeRunner } from "./ado-bridge.ts";
import {
  changedLineRanges,
  findingThreads,
  lineCount,
  normalizePath,
  normalizeReviewText,
  parseAzurePullRequestUrl,
  type ReviewFile,
  type ReviewState,
  type ReviewThread,
} from "./review-state.ts";

const MAX_BRIDGE_OUTPUT_BYTES = 32 * 1024 * 1024;

const MAX_CHANGED_FILES = 2_000;

const FILE_FETCH_CONCURRENCY = 2;

const MAX_FILE_BYTES = 2 * 1024 * 1024;

const MAX_FILE_RESPONSE_BYTES = MAX_FILE_BYTES * 6 + 64 * 1024;

const MAX_TOTAL_CONTENT_BYTES = 32 * 1024 * 1024;

const publicationQueues = new Map<string, Promise<void>>();

const JsonValueSchema = Type.Recursive((self) =>
  Type.Union([
    Type.Boolean(),
    Type.Null(),
    Type.Number(),
    Type.String(),
    Type.Array(self),
    Type.Record(Type.String(), self),
  ]),
);

const JsonObjectSchema = Type.Record(Type.String(), JsonValueSchema);

const StringSchema = Type.String();

const NumberSchema = Type.Number();

export type JsonValue = Static<typeof JsonValueSchema>;

type JsonObject = Static<typeof JsonObjectSchema>;

interface PullRequestDetails {
  title?: string;
  sourceRefName?: string;
  targetRefName?: string;
  repositoryId?: string;
}

interface PullRequestChange {
  changeType: string;
  originalPath?: string;
  path: string;
  changeTrackingId?: number;
}

interface PullRequestIteration {
  id: number;
  commonRefCommit: string;
  sourceRefCommit: string;
}

interface RemoteThread {
  id: number;
  anchor?: RemoteAnchor;
  resolved: boolean;
  firstComment?: string;
  messages: RemoteThreadMessage[];
}

interface RemoteThreadMessage {
  id: string;
  author?: string;
  body: string;
  createdAt: string;
}

interface RemoteAnchor {
  path: string;
  side: "additions" | "deletions";
  lineStart: number;
  lineEnd: number;
}

export interface LoadedPullRequest {
  title: string;
  sourceBranch?: string;
  targetBranch?: string;
  files: ReviewFile[];
  threads: ReviewThread[];
  status: string;
  loaded: true;
}

export interface AzureCliRunner {
  json(args: string[], body?: AzureThreadPayload): Promise<JsonValue>;
  file(args: string[]): Promise<Buffer>;
  publishBatch?(request: Extract<BridgeRequest, { operation: "publish" }>): Promise<PublicationResult[]>;
}

export type PublicationResult =
  | { kind: "published"; findingId: string; remoteThreadId: number }
  | { kind: "duplicate"; findingId: string; remoteThreadId: number }
  | { kind: "failed"; findingId: string; error: string };

export async function loadAzurePullRequest(
  prUrl: string,
  runner: AzureCliRunner = defaultAzureCliRunner,
): Promise<LoadedPullRequest> {
  const location = parseAzurePullRequestUrl(prUrl);
  const scopeArgs = ["--org", location.organizationUrl, "--only-show-errors"];

  const details = parsePullRequestDetails(await runner.json([
    "repos",
    "pr",
    "show",
    "--id",
    String(location.pullRequestId),
    "--project",
    location.project,
    ...scopeArgs,
    "--output",
    "json",
  ]));

  if (!details.repositoryId) {
    throw new Error("Azure DevOps did not return repository metadata for this pull request.");
  }

  const repositoryId = details.repositoryId;

  const invokeScope = azureInvokeScope(location.organizationUrl);
  const route = azureRoute(location.project, repositoryId, location.pullRequestId);

  const iterations = parseIterations(await runner.json([
    "devops",
    "invoke",
    ...invokeScope,
    "--resource",
    "pullRequestIterations",
    "--route-parameters",
    ...route,
  ]));

  const iteration = iterations.reduce<PullRequestIteration | undefined>(
    (latest, candidate) => candidate.id > (latest?.id ?? 0) ? candidate : latest,
    undefined,
  );

  if (!iteration) {
    throw new Error("Azure DevOps returned incomplete commit metadata for the latest pull request iteration.");
  }

  const allChanges = parseChanges(await runner.json([
    "devops",
    "invoke",
    ...invokeScope,
    "--resource",
    "pullRequestIterationChanges",
    "--route-parameters",
    ...route,
    `iterationId=${iteration.id}`,
    "--query-parameters",
    `$top=${MAX_CHANGED_FILES}`,
    "$compareTo=0",
  ]));

  const changes = allChanges.slice(0, MAX_CHANGED_FILES);
  const displayOmissions = allChanges.length - changes.length;

  let remainingContentBytes = MAX_TOTAL_CONTENT_BYTES;
  let omittedFiles = 0;

  const files = await mapLimit(changes, FILE_FETCH_CONCURRENCY, async (change) => {
    const currentPath = normalizePath(change.path);
    const previousPath = normalizePath(change.originalPath) || currentPath;
    const added = change.changeType.includes("add");
    const deleted = change.changeType.includes("delete");

    if (remainingContentBytes <= 0) {
      omittedFiles++;

      return omittedReviewFile(currentPath, change.changeType, "total content limit reached");
    }

    const [before, after] = await Promise.all([
      added
        ? Promise.resolve(Buffer.alloc(0))
        : fetchItem(runner, invokeScope, location.project, repositoryId, previousPath, iteration.commonRefCommit),
      deleted
        ? Promise.resolve(Buffer.alloc(0))
        : fetchItem(runner, invokeScope, location.project, repositoryId, currentPath, iteration.sourceRefCommit),
    ]);

    if (before === null || after === null) {
      omittedFiles++;

      return omittedReviewFile(currentPath, change.changeType, "file exceeds 2 MiB");
    }

    const contentBytes = before.length + after.length;

    if (contentBytes > remainingContentBytes) {
      remainingContentBytes = 0;
      omittedFiles++;

      return omittedReviewFile(currentPath, change.changeType, "total content limit reached");
    }

    remainingContentBytes -= contentBytes;

    return buildReviewFile(
      previousPath,
      currentPath,
      change.changeType,
      before,
      after,
      change.changeTrackingId,
      iteration.id,
    );
  });

  let threads: ReviewThread[] = [];
  let threadLoadError: string | undefined;

  try {
    threads = remoteThreadsForFiles(
      await listRemoteThreads(runner, invokeScope, route),
      files,
    );
  } catch (error) {
    threadLoadError = error instanceof Error ? error.message : String(error);
  }

  return {
    title: details.title ?? `Pull request ${location.pullRequestId}`,
    sourceBranch: stripRef(details.sourceRefName),
    targetBranch: stripRef(details.targetRefName),
    files,
    threads,
    loaded: true,
    status: `${omittedFiles > 0
      ? `Loaded ${files.length - omittedFiles} changed files; omitted content for ${omittedFiles} files`
      : `Loaded ${files.length} changed file${files.length === 1 ? "" : "s"}`}${
      displayOmissions ? `; omitted ${displayOmissions} changed files from display (${MAX_CHANGED_FILES} file display limit)` : ""
    }${
      threadLoadError
        ? `; could not load Azure DevOps threads: ${threadLoadError}`
        : `; loaded ${threads.length} inline Azure DevOps thread${threads.length === 1 ? "" : "s"}`
    }`,
  };
}

export async function publishReviewFindings(
  review: ReviewState,
  selection: { kind: "finding_ids"; findingIds: string[] } | { kind: "all_open" },
  runner: AzureCliRunner = defaultAzureCliRunner,
): Promise<PublicationResult[]> {
  return serializePublication(review.prUrl, () =>
    publishReviewFindingsOnce(review, selection, runner)
  );
}

async function publishReviewFindingsOnce(
  review: ReviewState,
  selection: { kind: "finding_ids"; findingIds: string[] } | { kind: "all_open" },
  runner: AzureCliRunner,
): Promise<PublicationResult[]> {
  const location = parseAzurePullRequestUrl(review.prUrl);
  const findings = findingThreads(review, selection);

  if (!findings.length) return [];

  const details = parsePullRequestDetails(await runner.json([
    "repos",
    "pr",
    "show",
    "--id",
    String(location.pullRequestId),
    "--org",
    location.organizationUrl,
    "--project",
    location.project,
    "--only-show-errors",
    "--output",
    "json",
  ]));

  if (!details.repositoryId) throw new Error("Azure DevOps did not return repository metadata for this pull request.");

  const scope = {
    invokeScope: azureInvokeScope(location.organizationUrl),
    route: azureRoute(location.project, details.repositoryId, location.pullRequestId),
  };

  const results: PublicationResult[] = [];

  const iterations = runner.publishBatch ? [] : collection(await runner.json([
    "devops", "invoke", ...scope.invokeScope,
    "--resource", "pullRequestIterations",
    "--route-parameters", ...scope.route,
  ]));

  const latestIteration = iterations.reduce<number | undefined>((latest, entry) => {
    const id = isRecord(entry) ? numberAt(entry, "id") : undefined;

    return id !== undefined && id >= 0 ? Math.max(latest ?? 0, id) : latest;
  }, undefined);

  const pending: Array<{ finding: typeof findings[number]; payload: AzureThreadPayload }> = [];

  for (const finding of findings) {
    try {
      const file = review.files.find((candidate) => candidate.path === finding.anchor.path);

      if (file?.changeTrackingId === undefined || file.iterationId === undefined) {
        throw new Error("Azure DevOps did not provide the change tracking context for this finding.");
      }

      if (!runner.publishBatch && (latestIteration === undefined || latestIteration !== file.iterationId)) {
        throw new Error("The pull request iteration changed or could not be verified. Reload the review before publishing.");
      }

      pending.push({ finding, payload: azureThreadPayload(finding, file) });
    } catch (error) {
      results.push({
        kind: "failed",
        findingId: finding.finding.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (pending.length) {
    try {
      if (runner.publishBatch) {
        results.push(...await runner.publishBatch({
          operation: "publish",
          org: location.organizationUrl,
          project: location.project,
          repositoryId: details.repositoryId,
          pullRequestId: location.pullRequestId,
          findings: pending.map(({ finding, payload }) => ({ findingId: finding.finding.id, payload })),
        }));
      } else {
        const currentThreads = await listRemoteThreads(runner, scope.invokeScope, scope.route);
        const uncertain: typeof findings = [];

        for (const { finding, payload } of pending) {
          try {
            const duplicate = currentThreads.find((thread) => remoteThreadMatches(thread, finding));

            if (duplicate) {
              results.push({ kind: "duplicate", findingId: finding.finding.id, remoteThreadId: duplicate.id });
              continue;
            }

            if (uncertain.some((previous) => remoteThreadMatches({
              id: 0, resolved: false, messages: [],
              firstComment: visibleFindingComment(previous), anchor: previous.anchor,
            }, finding))) {
              throw new Error("An earlier matching write has an uncertain outcome. Check Azure DevOps before publishing again.");
            }

            let created: number;

            try {
              created = parseCreatedThread(await runner.json([
                "devops", "invoke", ...scope.invokeScope,
                "--resource", "pullRequestThreads", "--route-parameters", ...scope.route,
                "--http-method", "POST",
              ], payload));
            } catch (error) {
              uncertain.push(finding);
              throw error;
            }

            currentThreads.push({
              id: created, anchor: finding.anchor, resolved: false,
              firstComment: payload.comments[0]!.content, messages: [],
            });
            results.push({ kind: "published", findingId: finding.finding.id, remoteThreadId: created });
          } catch (error) {
            results.push({ kind: "failed", findingId: finding.finding.id, error: error instanceof Error ? error.message : String(error) });
          }
        }
      }
    } catch (error) {
      for (const { finding } of pending) {
        if (!results.some((result) => result.findingId === finding.finding.id)) {
          results.push({ kind: "failed", findingId: finding.finding.id, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
  }

  return findings.map((finding) => results.find((result) => result.findingId === finding.finding.id)!);
}

async function serializePublication<T>(
  prUrl: string,
  work: () => Promise<T>,
): Promise<T> {
  const location = parseAzurePullRequestUrl(prUrl);
  const org = new URL(location.organizationUrl);

  const organization = org.hostname === "dev.azure.com"
    ? decodeURIComponent(org.pathname.slice(1))
    : org.hostname.slice(0, -".visualstudio.com".length);

  const key = `${organization.toLowerCase()}/${location.pullRequestId}`;
  const previous = publicationQueues.get(key) ?? Promise.resolve();
  let release: () => void;

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const tail = previous.catch(() => {}).then(() => gate);
  publicationQueues.set(key, tail);
  await previous.catch(() => {});

  try {
    return await work();
  } finally {
    release!();

    if (publicationQueues.get(key) === tail) publicationQueues.delete(key);
  }
}

const PublicationResponseSchema = Type.Object({
  results: Type.Array(Type.Union([
    Type.Object({
      kind: Type.Union([Type.Literal("published"), Type.Literal("duplicate")]),
      findingId: Type.String(),
      remoteThreadId: Type.Integer({ minimum: 1 }),
    }),
    Type.Object({ kind: Type.Literal("failed"), findingId: Type.String(), error: Type.String() }),
  ])),
});

export function createAzureBridgeRunner(bridge: BridgeRunner = runBridge): AzureCliRunner {
  return {
    async json(args, body) {
      if (body !== undefined) throw new Error("Azure DevOps writes require a coordinated publication batch.");

      return bridge(bridgeReadRequest(args), MAX_BRIDGE_OUTPUT_BYTES);
    },
    async file(args) {
      let payload: JsonValue;

      try {
        payload = await bridge(bridgeReadRequest(args), MAX_FILE_RESPONSE_BYTES);
      } catch (error) {
        if (error instanceof Error && /content_too_large|item content exceeds (?:2097152 bytes|2 MiB limit)/.test(error.message)) {
          throw new AzureResponseTooLargeError(MAX_FILE_BYTES);
        }

        throw error;
      }

      const content = itemContent(payload);

      if (content === undefined) return Buffer.from([0]);
      const buffer = Buffer.from(content, "utf8");

      if (buffer.length > MAX_FILE_BYTES) throw new AzureResponseTooLargeError(MAX_FILE_BYTES);

      return buffer;
    },
    async publishBatch(request) {
      const { results } = Value.Parse(PublicationResponseSchema, await bridge(request));
      const expected = new Set(request.findings.map((finding) => finding.findingId));

      for (const result of results) {
        if (!expected.delete(result.findingId)) throw new Error("Azure DevOps bridge returned an unexpected publication result.");
      }

      if (expected.size) throw new Error("Azure DevOps bridge returned incomplete publication results.");

      return results;
    },
  };
}

export const defaultAzureCliRunner = createAzureBridgeRunner();

function azureInvokeScope(organizationUrl: string): string[] {
  return [
    "--area",
    "git",
    "--org",
    organizationUrl,
    "--api-version",
    "7.1",
    "--only-show-errors",
    "--output",
    "json",
  ];
}

function azureRoute(project: string, repositoryId: string, pullRequestId: number): string[] {
  return [`project=${project}`, `repositoryId=${repositoryId}`, `pullRequestId=${pullRequestId}`];
}

async function listRemoteThreads(
  runner: AzureCliRunner,
  invokeScope: string[],
  route: string[],
): Promise<RemoteThread[]> {
  return parseRemoteThreads(await runner.json([
    "devops",
    "invoke",
    ...invokeScope,
    "--resource",
    "pullRequestThreads",
    "--route-parameters",
    ...route,
  ]));
}

function remoteThreadMatches(
  remote: RemoteThread,
  finding: Extract<ReviewThread, { kind: "finding" }>,
): boolean {
  const firstComment = remote.firstComment;

  if (firstComment?.includes(findingMarker(finding.finding.id))) return true;

  return Boolean(
    remote.anchor &&
    firstComment &&
    sameAnchor(remote.anchor, finding.anchor) &&
    normalizeReviewText(removeAiAttribution(removeFindingMarker(firstComment))) ===
      normalizeReviewText(removeAiAttribution(removeFindingMarker(visibleFindingComment(finding)))),
  );
}

export type AzureThreadPayload = {
  comments: Array<{
    parentCommentId: number;
    content: string;
    commentType: number;
  }>;
  status: number;
  threadContext: {
    filePath: string;
    rightFileStart?: { line: number; offset: number };
    rightFileEnd?: { line: number; offset: number };
    leftFileStart?: { line: number; offset: number };
    leftFileEnd?: { line: number; offset: number };
  };
  pullRequestThreadContext: {
    changeTrackingId?: number;
    iterationContext: {
      firstComparingIteration: number;
      secondComparingIteration?: number;
    };
  };
};

function azureThreadPayload(
  finding: Extract<ReviewThread, { kind: "finding" }>,
  file: ReviewFile,
): AzureThreadPayload {
  const position = {
    line: finding.anchor.lineStart,
    offset: 1,
  };

  const endPosition = {
    line: finding.anchor.lineEnd,
    offset: 1,
  };

  const context = finding.anchor.side === "additions"
    ? {
        filePath: `/${finding.anchor.path}`,
        rightFileStart: position,
        rightFileEnd: endPosition,
      }
    : {
        filePath: `/${finding.anchor.path}`,
        leftFileStart: position,
        leftFileEnd: endPosition,
      };

  return {
    comments: [{
      parentCommentId: 0,
      content: visibleFindingComment(finding),
      commentType: 1,
    }],
    status: 1,
    threadContext: context,
    pullRequestThreadContext: {
      changeTrackingId: file.changeTrackingId,
      iterationContext: {
        firstComparingIteration: 1,
        secondComparingIteration: file.iterationId,
      },
    },
  };
}

function visibleFindingComment(finding: Extract<ReviewThread, { kind: "finding" }>): string {
  const body = removeAiAttribution(finding.finding.body);

  return `**${finding.finding.title}**${body ? `\n\n${body}` : ""}\n\n- Generated with AI 🤖\n\n${findingMarker(finding.finding.id)}`;
}

function findingMarker(findingId: string): string {
  return `<!-- paired-review-finding:${findingId} -->`;
}

function sameAnchor(remote: RemoteAnchor, local: ReviewThread["anchor"]): boolean {
  return remote.path === normalizePath(local.path) &&
    remote.side === local.side &&
    remote.lineStart === local.lineStart &&
    remote.lineEnd === local.lineEnd;
}

function removeFindingMarker(content: string): string {
  return content.replace(/<!-- paired-review-finding:[a-z0-9-]+ -->/g, "");
}

function removeAiAttribution(content: string): string {
  return content.trimEnd().replace(/(?:^|\r?\n\r?\n)(?:- Generated with AI 🤖|🤖 Generated with AI)$/, "");
}

function buildReviewFile(
  previousPath: string,
  currentPath: string,
  changeType: string,
  before: Buffer,
  after: Buffer,
  changeTrackingId: number | undefined,
  iterationId: number,
): ReviewFile {
  if (isBinary(before) || isBinary(after)) {
    return {
      path: currentPath,
      status: changeType,
      diff: `diff --git a/${previousPath} b/${currentPath}\nBinary files a/${previousPath} and b/${currentPath} differ\n`,
      changeTrackingId,
      iterationId,
    };
  }

  const diff = [
    `diff --git a/${previousPath} b/${currentPath}`,
    createTwoFilesPatch(
      `a/${previousPath}`,
      `b/${currentPath}`,
      before.toString("utf8"),
      after.toString("utf8"),
      "",
      "",
      { context: 3 },
    ).trimEnd(),
    "",
  ].join("\n");

  const ranges = changedLineRanges(diff);

  return {
    path: currentPath,
    previousPath,
    status: changeType,
    additions: ranges.additions.reduce((total, range) => total + range.end - range.start + 1, 0),
    deletions: ranges.deletions.reduce((total, range) => total + range.end - range.start + 1, 0),
    diff,
    oldContent: before.toString("utf8"),
    newContent: after.toString("utf8"),
    changedLineRanges: ranges,
    changeTrackingId,
    iterationId,
  };
}

function omittedReviewFile(filePath: string, changeType: string, reason: string): ReviewFile {
  return {
    path: filePath,
    status: `${changeType}, content omitted`,
    diff: `Diff content omitted: ${reason}.\n`,
  };
}

class AzureResponseTooLargeError extends Error {
  constructor(limit: number) {
    super(`Azure DevOps response exceeds ${limit} bytes`);
  }
}

async function fetchItem(
  runner: AzureCliRunner,
  invokeScope: string[],
  project: string,
  repositoryId: string,
  filePath: string,
  commit: string,
): Promise<Buffer | null> {
  try {
    return await runner.file([
      "devops",
      "invoke",
      ...invokeScope,
      "--resource",
      "items",
      "--route-parameters",
      `project=${project}`,
      `repositoryId=${repositoryId}`,
      "--query-parameters",
      `path=/${filePath}`,
      `versionDescriptor.version=${commit}`,
      "versionDescriptor.versionType=commit",
      "includeContent=true",
      "--accept-media-type",
      "application/json",
    ]);
  } catch (error) {
    if (error instanceof AzureResponseTooLargeError) return null;
    throw error;
  }
}

function parsePullRequestDetails(value: JsonValue): PullRequestDetails {
  if (!isRecord(value)) return {};
  const repository = isRecord(value.repository) ? value.repository : undefined;

  return {
    title: stringAt(value, "title"),
    sourceRefName: stringAt(value, "sourceRefName"),
    targetRefName: stringAt(value, "targetRefName"),
    repositoryId: repository ? stringAt(repository, "id") : undefined,
  };
}

function parseIterations(value: JsonValue): PullRequestIteration[] {
  return collection(value).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const id = numberAt(entry, "id");
    const common = isRecord(entry.commonRefCommit) ? stringAt(entry.commonRefCommit, "commitId") : undefined;
    const source = isRecord(entry.sourceRefCommit) ? stringAt(entry.sourceRefCommit, "commitId") : undefined;

    return id && common && source ? [{ id, commonRefCommit: common, sourceRefCommit: source }] : [];
  });
}

function parseChanges(value: JsonValue): PullRequestChange[] {
  const entries = isRecord(value) && Array.isArray(value.changeEntries)
    ? value.changeEntries
    : collection(value);

  return entries.flatMap((entry) => {
    if (!isRecord(entry) || !isRecord(entry.item) || entry.item.isFolder === true) return [];
    const path = stringAt(entry.item, "path");

    if (!path) return [];

    return [{
      path,
      changeType: (stringAt(entry, "changeType") ?? "edit").toLowerCase(),
      originalPath: stringAt(entry, "originalPath"),
      changeTrackingId: numberAt(entry, "changeTrackingId"),
    }];
  });
}

function parseRemoteThreads(value: JsonValue): RemoteThread[] {
  return collection(value).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const id = numberAt(entry, "id");

    if (!id) return [];
    const comments = Array.isArray(entry.comments) ? entry.comments : [];

    const firstComment = comments.flatMap((comment) =>
      isRecord(comment) && stringAt(comment, "content")?.trim()
        ? [stringAt(comment, "content")!.trim()]
        : []
    )[0];

    const messages = comments.flatMap((comment, index) => {
      if (!isRecord(comment)) return [];
      const body = stringAt(comment, "content")?.trim();

      if (!body) return [];
      const commentId = numberAt(comment, "id") ?? index;
      const identity = isRecord(comment.author) ? comment.author : undefined;

      return [{
        id: `remote-${id}-${commentId}`,
        author: identity
          ? stringAt(identity, "displayName") ?? stringAt(identity, "uniqueName")
          : undefined,
        body: removeFindingMarker(body).trim(),
        createdAt: stringAt(comment, "publishedDate") ?? new Date(0).toISOString(),
      }];
    });

    if (!messages.length) return [];

    return [{
      id,
      anchor: parseRemoteAnchor(entry.threadContext),
      resolved: remoteThreadIsResolved(entry.status),
      firstComment,
      messages,
    }];
  });
}

function remoteThreadsForFiles(remoteThreads: RemoteThread[], files: ReviewFile[]): ReviewThread[] {
  return remoteThreads.flatMap((thread) => {
    if (!thread.anchor) return [];

    const file = files.find((candidate) =>
      candidate.path === thread.anchor!.path || candidate.previousPath === thread.anchor!.path
    );

    if (!file) return [];
    const content = thread.anchor.side === "additions" ? file.newContent : file.oldContent;

    if (
      content === undefined ||
      thread.anchor.lineEnd > lineCount(content)
    ) {
      return [];
    }

    return [{
      kind: "remote" as const,
      id: `remote-${thread.id}`,
      remoteThreadId: thread.id,
      anchor: { ...thread.anchor, path: file.path },
      pending: false,
      fixing: false,
      collapsed: thread.resolved,
      resolved: thread.resolved,
      messages: thread.messages.map((message) => ({
        ...message,
        role: "reviewer" as const,
      })),
    }];
  });
}

function remoteThreadIsResolved(status: JsonValue | undefined): boolean {
  return status !== undefined && status !== 1 && status !== "active";
}

function parseRemoteAnchor(value: JsonValue | undefined): RemoteAnchor | undefined {
  if (!isRecord(value)) return undefined;
  const path = stringAt(value, "filePath");
  const rightStart = positionLine(value.rightFileStart);
  const rightEnd = positionLine(value.rightFileEnd);

  if (path && rightStart && rightEnd) {
    return { path: normalizePath(path), side: "additions", lineStart: rightStart, lineEnd: rightEnd };
  }

  const leftStart = positionLine(value.leftFileStart);
  const leftEnd = positionLine(value.leftFileEnd);

  if (path && leftStart && leftEnd) {
    return { path: normalizePath(path), side: "deletions", lineStart: leftStart, lineEnd: leftEnd };
  }

  return undefined;
}

function parseCreatedThread(value: JsonValue): number {
  if (!isRecord(value)) {
    throw new Error("Azure DevOps did not return a created review thread ID.");
  }

  const id = numberAt(value, "id");

  if (!id) throw new Error("Azure DevOps did not return a created review thread ID.");

  return id;
}

function itemContent(value: JsonValue): string | undefined {
  if (!isRecord(value)) return undefined;
  const direct = stringAt(value, "content");

  if (direct !== undefined) return direct;

  if (!Array.isArray(value.value) || !isRecord(value.value[0])) return undefined;

  return stringAt(value.value[0], "content");
}

function collection(value: JsonValue): JsonValue[] {
  if (Array.isArray(value)) return value;

  return isRecord(value) && Array.isArray(value.value) ? value.value : [];
}

function positionLine(value: JsonValue | undefined): number | undefined {
  return isRecord(value) ? numberAt(value, "line") : undefined;
}

function stringAt(value: JsonObject, key: string): string | undefined {
  const item = value[key];

  return Value.Check(StringSchema, item) ? item : undefined;
}

function numberAt(value: JsonObject, key: string): number | undefined {
  const item = value[key];

  return Value.Check(NumberSchema, item) && Number.isSafeInteger(item) ? item : undefined;
}

function isRecord(value: JsonValue | undefined): value is JsonObject {
  return Value.Check(JsonObjectSchema, value);
}

function stripRef(value: string | undefined): string | undefined {
  return value?.replace(/^refs\/heads\//, "");
}

function isBinary(content: Buffer): boolean {
  return content.subarray(0, 8_000).includes(0);
}

async function mapLimit<T, R>(
  values: T[],
  limit: number,
  callback: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  results.length = values.length;
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;
        results[index] = await callback(values[index], index);
      }
    }),
  );

  return results;
}
