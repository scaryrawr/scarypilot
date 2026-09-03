import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTwoFilesPatch } from "diff";
import {
  parseAzurePullRequestUrl,
  type ReviewFile,
} from "./review-state.ts";

const execFileAsync = promisify(execFile);
const MAX_AZ_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_CHANGED_FILES = 2_000;
const FILE_FETCH_CONCURRENCY = 6;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILE_RESPONSE_BYTES = MAX_FILE_BYTES * 6 + 64 * 1024;
const MAX_TOTAL_CONTENT_BYTES = 32 * 1024 * 1024;

interface PullRequestDetails {
  title?: string;
  sourceRefName?: string;
  targetRefName?: string;
  repository?: {
    id?: string;
    name?: string;
  };
  lastMergeSourceCommit?: { commitId?: string };
  lastMergeTargetCommit?: { commitId?: string };
}

interface PullRequestChange {
  changeType?: string;
  originalPath?: string;
  item?: {
    isFolder?: boolean;
    path?: string;
  };
}

interface PullRequestIteration {
  id?: number;
  commonRefCommit?: { commitId?: string };
  sourceRefCommit?: { commitId?: string };
}

export interface LoadedPullRequest {
  title: string;
  sourceBranch?: string;
  targetBranch?: string;
  files: ReviewFile[];
  status: string;
}

export interface AzureCliRunner {
  json(args: string[]): Promise<unknown>;
  file(args: string[]): Promise<Buffer>;
}

export async function loadAzurePullRequest(
  prUrl: string,
  runner: AzureCliRunner = defaultAzureCliRunner,
): Promise<LoadedPullRequest> {
  const location = parseAzurePullRequestUrl(prUrl);
  const scopeArgs = [
    "--org",
    location.organizationUrl,
    "--only-show-errors",
  ];

  const details = await runner.json([
    "repos",
    "pr",
    "show",
    "--id",
    String(location.pullRequestId),
    ...scopeArgs,
    "--output",
    "json",
  ]) as PullRequestDetails;

  const repositoryId = details.repository?.id;
  if (!repositoryId) {
    throw new Error("Azure DevOps did not return repository metadata for this pull request.");
  }

  const invokeScope = [
    "--area",
    "git",
    "--org",
    location.organizationUrl,
    "--api-version",
    "7.1",
    "--only-show-errors",
    "--output",
    "json",
  ];
  const route = [
    `project=${location.project}`,
    `repositoryId=${repositoryId}`,
    `pullRequestId=${location.pullRequestId}`,
  ];

  const iterationsPayload = await runner.json([
    "devops",
    "invoke",
    ...invokeScope,
    "--resource",
    "pullRequestIterations",
    "--route-parameters",
    ...route,
  ]);
  const iterations = collection<PullRequestIteration>(iterationsPayload);
  const iteration = iterations.reduce<PullRequestIteration | undefined>(
    (latest, candidate) =>
      (candidate.id ?? 0) > (latest?.id ?? 0) ? candidate : latest,
    undefined,
  );
  const iterationId = iteration?.id;
  const sourceCommit = iteration?.sourceRefCommit?.commitId;
  const targetCommit = iteration?.commonRefCommit?.commitId;
  if (!iterationId || !sourceCommit || !targetCommit) {
    throw new Error("Azure DevOps returned incomplete commit metadata for the latest pull request iteration.");
  }

  const changesPayload = await runner.json([
    "devops",
    "invoke",
    ...invokeScope,
    "--resource",
    "pullRequestIterationChanges",
    "--route-parameters",
    ...route,
    `iterationId=${iterationId}`,
    "--query-parameters",
    `$top=${MAX_CHANGED_FILES}`,
    "$compareTo=0",
  ]);
  const changes = changeCollection(changesPayload)
    .filter((change) => !change.item?.isFolder && change.item?.path)
    .slice(0, MAX_CHANGED_FILES);

  let remainingContentBytes = MAX_TOTAL_CONTENT_BYTES;
  let omittedFiles = 0;
  const files = await mapLimit(changes, FILE_FETCH_CONCURRENCY, async (change) => {
    const currentPath = normalizePath(change.item?.path);
    const previousPath = normalizePath(change.originalPath) || currentPath;
    const changeType = (change.changeType ?? "edit").toLowerCase();
    const added = changeType.includes("add");
    const deleted = changeType.includes("delete");
    if (remainingContentBytes <= 0) {
      omittedFiles++;
      return omittedReviewFile(currentPath, changeType, "total content limit reached");
    }
    const [before, after] = await Promise.all([
      added
        ? Promise.resolve(Buffer.alloc(0))
        : fetchItem(runner, invokeScope, location.project, repositoryId, previousPath, targetCommit),
      deleted
        ? Promise.resolve(Buffer.alloc(0))
        : fetchItem(runner, invokeScope, location.project, repositoryId, currentPath, sourceCommit),
    ]);

    if (before === null || after === null) {
      omittedFiles++;
      return omittedReviewFile(currentPath, changeType, "file exceeds 2 MiB");
    }
    const contentBytes = before.length + after.length;
    if (contentBytes > remainingContentBytes) {
      remainingContentBytes = 0;
      omittedFiles++;
      return omittedReviewFile(currentPath, changeType, "total content limit reached");
    }
    remainingContentBytes -= contentBytes;
    return buildReviewFile(previousPath, currentPath, changeType, before, after);
  });

  return {
    title: details.title ?? `Pull request ${location.pullRequestId}`,
    sourceBranch: stripRef(details.sourceRefName),
    targetBranch: stripRef(details.targetRefName),
    files,
    status: omittedFiles > 0
      ? `Loaded ${files.length - omittedFiles} changed files; omitted content for ${omittedFiles} files`
      : changes.length >= MAX_CHANGED_FILES
        ? `Loaded the first ${MAX_CHANGED_FILES} changed files`
        : `Loaded ${files.length} changed file${files.length === 1 ? "" : "s"}`,
  };
}

export const defaultAzureCliRunner: AzureCliRunner = {
  async json(args) {
    const { stdout } = await runAzureCli(args);
    return JSON.parse(stdout);
  },
  async file(args) {
    const { stdout } = await runAzureCli(args, MAX_FILE_RESPONSE_BYTES);
    const payload = JSON.parse(stdout) as {
      content?: unknown;
      value?: Array<{ content?: unknown }>;
    };
    const content = payload.content ?? payload.value?.[0]?.content;
    if (typeof content !== "string") return Buffer.from([0]);
    const buffer = Buffer.from(content, "utf8");
    if (buffer.length > MAX_FILE_BYTES) throw new FileTooLargeError(buffer.length);
    return buffer;
  },
};

class FileTooLargeError extends Error {
  constructor(readonly size: number) {
    super(`Azure DevOps file content exceeds ${MAX_FILE_BYTES} bytes`);
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
    if (error instanceof FileTooLargeError) return null;
    throw error;
  }
}

function buildReviewFile(
  previousPath: string,
  currentPath: string,
  changeType: string,
  before: Buffer,
  after: Buffer,
): ReviewFile {
  if (isBinary(before) || isBinary(after)) {
    return {
      path: currentPath,
      status: changeType,
      diff: [
        `diff --git a/${previousPath} b/${currentPath}`,
        `Binary files a/${previousPath} and b/${currentPath} differ`,
        "",
      ].join("\n"),
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
  const lines = diff.split("\n");
  return {
    path: currentPath,
    previousPath,
    status: changeType,
    additions: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
    deletions: lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
    diff,
    oldContent: before.toString("utf8"),
    newContent: after.toString("utf8"),
  };
}

function omittedReviewFile(
  filePath: string,
  changeType: string,
  reason: string,
): ReviewFile {
  return {
    path: filePath,
    status: `${changeType}, content omitted`,
    diff: `Diff content omitted: ${reason}.\n`,
  };
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
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
    ) {
      throw new FileTooLargeError(maxBuffer);
    }
    const message =
      error && typeof error === "object" && "stderr" in error
        ? String(error.stderr).trim()
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(`Azure CLI request failed: ${message || "unknown error"}`);
  }
}

function collection<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object" && Array.isArray((payload as { value?: unknown }).value)) {
    return (payload as { value: T[] }).value;
  }
  return [];
}

function changeCollection(payload: unknown): PullRequestChange[] {
  if (payload && typeof payload === "object") {
    const value = payload as {
      changeEntries?: PullRequestChange[];
      value?: PullRequestChange[];
    };
    return value.changeEntries ?? value.value ?? [];
  }
  return [];
}

function normalizePath(value: string | undefined): string {
  return (value ?? "").replaceAll("\\", "/").replace(/^\/+/, "");
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
