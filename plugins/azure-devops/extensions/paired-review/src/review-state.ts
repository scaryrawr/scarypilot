import { createHash } from "node:crypto";
import type { ReviewState } from "./review-schema.ts";

export type {
  ReviewFile,
  ReviewFinding,
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
    files: [],
    findings: [],
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
    findings: input.findings ?? current.findings,
    threads: input.threads ?? current.threads,
    updatedAt: new Date().toISOString(),
  };
}
