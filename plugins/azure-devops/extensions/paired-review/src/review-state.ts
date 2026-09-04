import { createHash, randomUUID } from "node:crypto";
import type {
  CreateReviewFindingInput,
  DiffSide,
  LineAnchor,
  ReviewFile,
  ReviewPass,
  ReviewState,
  ReviewThread,
} from "./review-schema.ts";

export type {
  CreateReviewFindingInput,
  DiffSide,
  LineAnchor,
  ReviewFile,
  ReviewPass,
  ReviewState,
  ReviewThread,
  ReviewThreadMessage,
} from "./review-schema.ts";

export interface AzurePullRequestLocation {
  organizationUrl: string;
  project: string;
  repository: string;
  pullRequestId: number;
}

export interface ReviewLineRange {
  start: number;
  end: number;
}

export interface FindingInsertion {
  review: ReviewState;
  thread: Extract<ReviewThread, { kind: "finding" }>;
  inserted: boolean;
}

export interface ReviewPassQueueResult {
  review: ReviewState;
  pass: ReviewPass;
  scheduled: boolean;
}

const FINDING_VERSION = "paired-review-finding-v1";

export function isAzurePullRequestUrl(value: string): boolean {
  try {
    parseAzurePullRequestUrl(value);
    return true;
  } catch {
    return false;
  }
}

export function parseAzurePullRequestUrl(value: string): AzurePullRequestLocation {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Azure DevOps pull request URLs must use HTTPS.");

  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const pullRequestIndex = parts.findIndex((part) => part.toLowerCase() === "pullrequest");
  const gitIndex = parts.findIndex((part) => part.toLowerCase() === "_git");
  if (gitIndex < 1 || pullRequestIndex !== gitIndex + 2) {
    throw new Error("URL is not an Azure DevOps pull request.");
  }
  const pullRequestId = Number(parts[pullRequestIndex + 1]);
  if (!Number.isSafeInteger(pullRequestId) || pullRequestId < 1) {
    throw new Error("URL does not contain a valid pull request ID.");
  }

  if (url.hostname === "dev.azure.com") {
    if (gitIndex < 2) throw new Error("URL does not contain an organization and project.");
    return {
      organizationUrl: `https://dev.azure.com/${encodeURIComponent(parts[0])}`,
      project: parts[1],
      repository: parts[gitIndex + 1],
      pullRequestId,
    };
  }

  if (url.hostname.endsWith(".visualstudio.com")) {
    const organization = url.hostname.slice(0, -".visualstudio.com".length);
    if (!organization) throw new Error("URL does not contain an organization.");
    return {
      organizationUrl: `https://${organization}.visualstudio.com`,
      project: parts[0],
      repository: parts[gitIndex + 1],
      pullRequestId,
    };
  }

  throw new Error("URL is not hosted by Azure DevOps.");
}

export function reviewInstanceId(prUrl: string): string {
  const url = new URL(prUrl);
  const match = url.pathname.match(/\/pullrequest\/(\d+)\/?$/i);
  const prId = match?.[1] ?? "review";
  const identity = `${url.origin.toLowerCase()}${url.pathname.replace(/\/$/, "").toLowerCase()}`;
  const suffix = createHash("sha256").update(identity).digest("hex").slice(0, 10);
  return `ado-pr-${prId}-${suffix}`;
}

export function createReviewState(instanceId: string, prUrl: string): ReviewState {
  return {
    instanceId,
    prUrl,
    title: "Azure DevOps paired review",
    status: "Loading pull request from Azure DevOps...",
    loaded: false,
    files: [],
    reviewPass: { kind: "idle" },
    threads: [],
    updatedAt: new Date().toISOString(),
  };
}

export function updateReviewState(
  current: ReviewState,
  input: Partial<Omit<ReviewState, "instanceId" | "prUrl" | "updatedAt">>,
): ReviewState {
  return {
    ...current,
    ...input,
    files: input.files ?? current.files,
    threads: input.threads ?? current.threads,
    reviewPass: input.reviewPass ?? current.reviewPass,
    updatedAt: new Date().toISOString(),
  };
}

export function queueReviewPass(review: ReviewState, requestId: string): ReviewPassQueueResult {
  const current = review.reviewPass;
  if (
    current.kind !== "idle" &&
    (current.requestId === requestId || current.kind === "queued" || current.kind === "running")
  ) {
    return { review, pass: current, scheduled: false };
  }
  const pass: ReviewPass = {
    kind: "queued",
    id: reviewPassId(requestId),
    requestId,
  };
  return {
    review: updateReviewState(review, { reviewPass: pass }),
    pass,
    scheduled: true,
  };
}

export function startQueuedReviewPass(review: ReviewState, passId: string): ReviewState {
  const pass = review.reviewPass;
  if (pass.kind !== "queued" || pass.id !== passId) return review;
  return updateReviewState(review, {
    reviewPass: { ...pass, kind: "running", findingCount: findingCount(review) },
  });
}

export function completeReviewPass(review: ReviewState, passId: string): ReviewState {
  const pass = review.reviewPass;
  if (pass.kind !== "running" || pass.id !== passId) return review;
  return updateReviewState(review, {
    reviewPass: { ...pass, kind: "completed", findingCount: findingCount(review) },
  });
}

export function failReviewPass(review: ReviewState, passId: string, error: string): ReviewState {
  const pass = review.reviewPass;
  if (pass.kind !== "running" || pass.id !== passId) return review;
  return updateReviewState(review, {
    reviewPass: {
      ...pass,
      kind: "failed",
      findingCount: findingCount(review),
      error,
    },
  });
}

export function insertReviewFinding(
  review: ReviewState,
  input: CreateReviewFindingInput,
  createdByPass: string,
): FindingInsertion {
  const anchor = reviewAnchor(review, input, true);
  if (!anchor) throw new Error("finding range is not part of the changed review content");
  const id = findingId(anchor, input.title, input.body);
  const existing = review.threads.find(
    (thread): thread is Extract<ReviewThread, { kind: "finding" }> =>
      thread.kind === "finding" && thread.finding.id === id,
  );
  if (existing) return { review, thread: existing, inserted: false };

  const thread: Extract<ReviewThread, { kind: "finding" }> = {
    kind: "finding",
    id,
    anchor,
    pending: false,
    collapsed: false,
    resolved: false,
    messages: [{
      id: randomUUID(),
      role: "assistant",
      body: input.body.trim(),
      createdAt: new Date().toISOString(),
    }],
    finding: {
      id,
      severity: input.severity,
      title: input.title.trim(),
      body: input.body.trim(),
      createdByPass,
      publication: { kind: "local" },
    },
  };
  const next = updateReviewState(review, { threads: [...review.threads, thread] });
  const updated = next.reviewPass.kind === "running"
    ? updateReviewState(next, {
        reviewPass: { ...next.reviewPass, findingCount: findingCount(next) },
      })
    : next;
  return {
    review: updated,
    thread,
    inserted: true,
  };
}

export function createQuestionThread(
  review: ReviewState,
  path: string,
  side: DiffSide,
  lineStart: number,
  lineEnd: number,
  body: string,
): { review: ReviewState; thread: Extract<ReviewThread, { kind: "question" }> } {
  const anchor = reviewAnchor(review, { path, side, lineStart, lineEnd }, false);
  if (!anchor) throw new Error("selected range is not part of the changed review content");
  const thread: Extract<ReviewThread, { kind: "question" }> = {
    kind: "question",
    id: randomUUID(),
    anchor,
    pending: true,
    collapsed: false,
    resolved: false,
    messages: [{
      id: randomUUID(),
      role: "user",
      body,
      createdAt: new Date().toISOString(),
    }],
  };
  return {
    review: updateReviewState(review, { threads: [...review.threads, thread] }),
    thread,
  };
}

export function findingId(anchor: LineAnchor, title: string, body: string): string {
  const fingerprint = [
    FINDING_VERSION,
    normalizePath(anchor.path),
    anchor.side,
    `${anchor.lineStart}-${anchor.lineEnd}`,
    anchor.sourceDigest ?? "",
    normalizeReviewText(title),
    normalizeReviewText(body),
  ];
  return `finding-${createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex").slice(0, 24)}`;
}

export function changedLineRanges(diff: string): { additions: ReviewLineRange[]; deletions: ReviewLineRange[] } {
  const additions: ReviewLineRange[] = [];
  const deletions: ReviewLineRange[] = [];
  let additionLine = 0;
  let deletionLine = 0;
  for (const line of diff.split("\n")) {
    const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      deletionLine = Number(header[1]);
      additionLine = Number(header[2]);
      continue;
    }
    if (!additionLine && !deletionLine) continue;
    if (line.startsWith("+")) {
      appendRange(additions, additionLine);
      additionLine++;
      continue;
    }
    if (line.startsWith("-")) {
      appendRange(deletions, deletionLine);
      deletionLine++;
      continue;
    }
    if (line.startsWith(" ")) {
      additionLine++;
      deletionLine++;
    }
  }
  return { additions, deletions };
}

export function findingThreads(
  review: ReviewState,
  selection: { kind: "finding_ids"; findingIds: string[] } | { kind: "all_open" },
): Extract<ReviewThread, { kind: "finding" }>[] {
  const requested = selection.kind === "finding_ids" ? new Set(selection.findingIds) : null;
  return review.threads.filter(
    (thread): thread is Extract<ReviewThread, { kind: "finding" }> =>
      thread.kind === "finding" &&
      !thread.resolved &&
      thread.finding.publication.kind === "local" &&
      (requested === null || requested.has(thread.finding.id)),
  );
}

export function linkFinding(
  review: ReviewState,
  findingId: string,
  remoteThreadId: number,
  disposition: "published" | "duplicate",
): ReviewState {
  return updateReviewState(review, {
    threads: review.threads.map((thread) =>
      thread.kind === "finding" && thread.finding.id === findingId
        ? {
            ...thread,
            finding: {
              ...thread.finding,
              publication: { kind: "linked", remoteThreadId, disposition },
            },
          }
        : thread,
    ),
  });
}

export function normalizeReviewText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trim();
}

export function normalizePath(value: string | undefined): string {
  return (value ?? "").normalize("NFC").replaceAll("\\", "/").replace(/^\/+/, "");
}

function reviewAnchor(
  review: ReviewState,
  input: Pick<LineAnchor, "path" | "side" | "lineStart" | "lineEnd">,
  requireChangedLines: boolean,
): LineAnchor | null {
  if (input.lineEnd < input.lineStart) return null;
  const file = review.files.find((candidate) => candidate.path === input.path);
  if (!file) return null;
  const content = input.side === "additions" ? file.newContent : file.oldContent;
  if (content === undefined || input.lineEnd > lineCount(content)) return null;
  if (requireChangedLines) {
    const ranges = file.changedLineRanges ?? changedLineRanges(file.diff);
    const sideRanges = input.side === "additions" ? ranges.additions : ranges.deletions;
    if (!sideRanges.some((range) => input.lineStart >= range.start && input.lineEnd <= range.end)) return null;
  }
  const selected = content.split(/\r?\n/).slice(input.lineStart - 1, input.lineEnd).join("\n");
  return {
    ...input,
    sourceDigest: createHash("sha256").update(selected).digest("hex"),
  };
}

function reviewPassId(requestId: string): string {
  return `review-pass-${createHash("sha256").update(requestId).digest("hex").slice(0, 20)}`;
}

function findingCount(review: ReviewState): number {
  return review.threads.filter((thread) => thread.kind === "finding").length;
}

function lineCount(content: string): number {
  return content.endsWith("\n") ? content.slice(0, -1).split(/\r?\n/).length : content.split(/\r?\n/).length;
}

function appendRange(ranges: ReviewLineRange[], line: number): void {
  const previous = ranges.at(-1);
  if (previous && previous.end + 1 === line) {
    previous.end = line;
    return;
  }
  ranges.push({ start: line, end: line });
}
