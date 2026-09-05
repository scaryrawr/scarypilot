import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createTwoFilesPatch } from "diff";
import {
  changedLineRanges,
  findingThreads,
  normalizePath,
  normalizeReviewText,
  parseAzurePullRequestUrl,
  type ReviewFile,
  type ReviewState,
  type ReviewThread,
} from "./review-state.ts";

const execFileAsync = promisify(execFile);
const MAX_AZ_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_CHANGED_FILES = 2_000;
const FILE_FETCH_CONCURRENCY = 6;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILE_RESPONSE_BYTES = MAX_FILE_BYTES * 6 + 64 * 1024;
const MAX_TOTAL_CONTENT_BYTES = 32 * 1024 * 1024;
const publicationQueues = new Map<string, Promise<void>>();

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
  json(args: string[], body?: unknown): Promise<unknown>;
  file(args: string[]): Promise<Buffer>;
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

  const changes = parseChanges(await runner.json([
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
  ])).slice(0, MAX_CHANGED_FILES);

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
      : changes.length >= MAX_CHANGED_FILES
        ? `Loaded the first ${MAX_CHANGED_FILES} changed files`
        : `Loaded ${files.length} changed file${files.length === 1 ? "" : "s"}`}${
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
  const details = parsePullRequestDetails(await runner.json([
    "repos",
    "pr",
    "show",
    "--id",
    String(location.pullRequestId),
    "--org",
    location.organizationUrl,
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
  for (const finding of findingThreads(review, selection)) {
    try {
      const currentThreads = await listRemoteThreads(runner, scope.invokeScope, scope.route);
      const duplicate = currentThreads.find((thread) => remoteThreadMatches(thread, finding));
      if (duplicate) {
        results.push({ kind: "duplicate", findingId: finding.finding.id, remoteThreadId: duplicate.id });
        continue;
      }
      const file = review.files.find((candidate) => candidate.path === finding.anchor.path);
      if (file?.changeTrackingId === undefined || file.iterationId === undefined) {
        throw new Error("Azure DevOps did not provide the change tracking context for this finding.");
      }
      const created = parseCreatedThread(await runner.json([
        "devops",
        "invoke",
        ...scope.invokeScope,
        "--resource",
        "pullRequestThreads",
        "--route-parameters",
        ...scope.route,
        "--http-method",
        "POST",
      ], azureThreadPayload(finding, file)));
      results.push({ kind: "published", findingId: finding.finding.id, remoteThreadId: created });
    } catch (error) {
      results.push({
        kind: "failed",
        findingId: finding.finding.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

async function serializePublication<T>(
  prUrl: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = publicationQueues.get(prUrl) ?? Promise.resolve();
  let release: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => {}).then(() => gate);
  publicationQueues.set(prUrl, tail);
  await previous.catch(() => {});
  try {
    return await work();
  } finally {
    release!();
    if (publicationQueues.get(prUrl) === tail) publicationQueues.delete(prUrl);
  }
}

export const defaultAzureCliRunner: AzureCliRunner = {
  async json(args, body) {
    if (body === undefined) return JSON.parse((await runAzureCli(args)).stdout);
    const directory = await mkdtemp(path.join(os.tmpdir(), "paired-review-"));
    const inputPath = path.join(directory, "request.json");
    try {
      await writeFile(inputPath, JSON.stringify(body));
      return JSON.parse((await runAzureCli([...args, "--in-file", inputPath])).stdout);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  async file(args) {
    const payload = JSON.parse((await runAzureCli(args, MAX_FILE_RESPONSE_BYTES)).stdout);
    const content = itemContent(payload);
    if (content === undefined) return Buffer.from([0]);
    const buffer = Buffer.from(content, "utf8");
    if (buffer.length > MAX_FILE_BYTES) throw new AzureResponseTooLargeError(MAX_FILE_BYTES);
    return buffer;
  },
};

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
    normalizeReviewText(removeFindingMarker(firstComment)) ===
      normalizeReviewText(removeFindingMarker(visibleFindingComment(finding))),
  );
}

function azureThreadPayload(
  finding: Extract<ReviewThread, { kind: "finding" }>,
  file: ReviewFile,
): unknown {
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
  return `**${finding.finding.title}**\n\n${finding.finding.body}\n\n${findingMarker(finding.finding.id)}`;
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

async function runAzureCli(
  args: string[],
  maxBuffer = MAX_AZ_OUTPUT_BYTES,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("az", args, {
      encoding: "utf8",
      env: { ...process.env, AZURE_CORE_ONLY_SHOW_ERRORS: "1" },
      maxBuffer,
      windowsHide: true,
    });
  } catch (error) {
    if (isRecord(error) && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new AzureResponseTooLargeError(maxBuffer);
    }
    const message = isRecord(error) && typeof error.stderr === "string"
      ? error.stderr.trim()
      : error instanceof Error
        ? error.message
        : String(error);
    throw new Error(`Azure CLI request failed: ${message || "unknown error"}`);
  }
}

function parsePullRequestDetails(value: unknown): PullRequestDetails {
  if (!isRecord(value)) return {};
  const repository = isRecord(value.repository) ? value.repository : undefined;
  return {
    title: stringAt(value, "title"),
    sourceRefName: stringAt(value, "sourceRefName"),
    targetRefName: stringAt(value, "targetRefName"),
    repositoryId: repository ? stringAt(repository, "id") : undefined,
  };
}

function parseIterations(value: unknown): PullRequestIteration[] {
  return collection(value).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const id = numberAt(entry, "id");
    const common = isRecord(entry.commonRefCommit) ? stringAt(entry.commonRefCommit, "commitId") : undefined;
    const source = isRecord(entry.sourceRefCommit) ? stringAt(entry.sourceRefCommit, "commitId") : undefined;
    return id && common && source ? [{ id, commonRefCommit: common, sourceRefCommit: source }] : [];
  });
}

function parseChanges(value: unknown): PullRequestChange[] {
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

function parseRemoteThreads(value: unknown): RemoteThread[] {
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

function remoteThreadIsResolved(status: unknown): boolean {
  return status !== undefined && status !== 1 && status !== "active";
}

function parseRemoteAnchor(value: unknown): RemoteAnchor | undefined {
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

function parseCreatedThread(value: unknown): number {
  if (!isRecord(value)) {
    throw new Error("Azure DevOps did not return a created review thread ID.");
  }
  const id = numberAt(value, "id");
  if (!id) throw new Error("Azure DevOps did not return a created review thread ID.");
  return id;
}

function itemContent(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const direct = stringAt(value, "content");
  if (direct !== undefined) return direct;
  if (!Array.isArray(value.value) || !isRecord(value.value[0])) return undefined;
  return stringAt(value.value[0], "content");
}

function collection(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return isRecord(value) && Array.isArray(value.value) ? value.value : [];
}

function positionLine(value: unknown): number | undefined {
  return isRecord(value) ? numberAt(value, "line") : undefined;
}

function lineCount(content: string): number {
  return content.endsWith("\n")
    ? content.slice(0, -1).split(/\r?\n/).length
    : content.split(/\r?\n/).length;
}

function stringAt(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function numberAt(value: Record<string, unknown>, key: string): number | undefined {
  return typeof value[key] === "number" && Number.isSafeInteger(value[key]) ? value[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
  const results = new Array<R>(values.length);
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
