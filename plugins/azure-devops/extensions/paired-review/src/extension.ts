import { createCanvas, joinSession } from "@github/copilot-sdk/extension";
import type { CommandDefinition, CopilotSession } from "@github/copilot-sdk";
import { randomUUID } from "node:crypto";
import {
  createReviewState,
  isAzurePullRequestUrl,
  reviewInstanceId,
  updateReviewState,
  type ReviewFile,
  type ReviewFinding,
  type ReviewState,
  type ReviewThread,
} from "./review-state.ts";
import { loadAzurePullRequest } from "./ado-loader.ts";
import {
  buildThreadPrompt,
  getReviewFileLines,
  getThreadContext,
  listReviewFiles,
} from "./review-context.ts";
import { startReviewServer } from "./server.ts";

const CANVAS_ID = "azure-devops-paired-review";
const MAX_AGENT_RESPONSE_CHARS = 32 * 1024;
const reviews = new Map<string, ReviewState>();
let sessionRef: CopilotSession | null = null;
let serverPromise: Promise<Awaited<ReturnType<typeof startReviewServer>>> | null = null;
let shutdownPromise: Promise<void> | null = null;
let answerQueue = Promise.resolve();

function scheduleThreadAnswer(instanceId: string, threadId: string): void {
  answerQueue = answerQueue.then(() => answerThread(instanceId, threadId));
}

async function getServer() {
  if (!serverPromise) {
    serverPromise = startReviewServer({
      getState: (instanceId) => reviews.get(instanceId),
      setActivePath: (instanceId, activePath) => {
        const current = reviews.get(instanceId);
        if (current) reviews.set(instanceId, updateReviewState(current, { activePath }));
      },
      createThread: async (instanceId, input) => {
        const review = reviews.get(instanceId);
        if (!review) throw new Error("paired review is no longer available");
        if (!review.files.some((file) => file.path === input.path)) {
          throw new Error("selected file is not part of this review");
        }
        const thread: ReviewThread = {
          id: randomUUID(),
          path: input.path,
          side: input.side,
          lineStart: input.lineStart,
          lineEnd: input.lineEnd,
          pending: true,
          collapsed: false,
          resolved: false,
          messages: [{
            id: randomUUID(),
            role: "user",
            body: input.body,
            createdAt: new Date().toISOString(),
          }],
        };
        reviews.set(
          instanceId,
          updateReviewState(review, { threads: [...review.threads, thread] }),
        );
        scheduleThreadAnswer(instanceId, thread.id);
        return thread.id;
      },
      replyToThread: async (instanceId, threadId, body) => {
        const review = reviews.get(instanceId);
        if (!review) throw new Error("paired review is no longer available");
        const thread = review.threads.find((candidate) => candidate.id === threadId);
        if (!thread) throw new Error("review thread was not found");
        if (thread.pending) throw new Error("wait for the current response before replying");
        const threads = review.threads.map((candidate) =>
          candidate.id === threadId
            ? {
                ...candidate,
                pending: true,
                messages: [...candidate.messages, {
                  id: randomUUID(),
                  role: "user" as const,
                  body,
                  createdAt: new Date().toISOString(),
                }],
              }
            : candidate,
        );
        reviews.set(instanceId, updateReviewState(review, { threads }));
        scheduleThreadAnswer(instanceId, threadId);
      },
      updateThread: async (instanceId, threadId, input) => {
        const review = reviews.get(instanceId);
        if (!review) throw new Error("paired review is no longer available");
        if (!review.threads.some((thread) => thread.id === threadId)) {
          throw new Error("review thread was not found");
        }
        const threads = review.threads.map((thread) =>
          thread.id === threadId ? { ...thread, ...input } : thread
        );
        reviews.set(instanceId, updateReviewState(review, { threads }));
      },
    });
  }
  try {
    return await serverPromise;
  } catch (error) {
    serverPromise = null;
    throw error;
  }
}

const pairedReviewCanvas = createCanvas({
  id: CANVAS_ID,
  displayName: "Azure DevOps Paired Review",
  description: "Review an Azure DevOps pull request with a local changed-file tree, diffs, and draft findings.",
  inputSchema: {
    type: "object",
    properties: {
      prUrl: {
        type: "string",
        description: "Full HTTPS URL of an Azure DevOps pull request.",
      },
    },
    required: ["prUrl"],
    additionalProperties: false,
  },
  actions: [
    {
      name: "set_review_data",
      description: "Replace the paired-review metadata, changed files, diffs, and draft findings after inspecting the PR.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          status: { type: "string" },
          sourceBranch: { type: "string" },
          targetBranch: { type: "string" },
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                previousPath: { type: "string" },
                status: { type: "string" },
                additions: { type: "number" },
                deletions: { type: "number" },
                diff: { type: "string" },
                oldContent: { type: "string" },
                newContent: { type: "string" },
              },
              required: ["path", "diff"],
              additionalProperties: false,
            },
          },
          findings: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                line: { type: "number" },
                severity: { type: "string" },
                title: { type: "string" },
                body: { type: "string" },
              },
              required: ["path", "title"],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      handler: (ctx) => {
        const current = reviews.get(ctx.instanceId);
        if (!current) throw new Error("paired review is no longer available");
        const input = (ctx.input ?? {}) as {
          title?: string;
          status?: string;
          sourceBranch?: string;
          targetBranch?: string;
          files?: ReviewFile[];
          findings?: ReviewFinding[];
        };
        const next = updateReviewState(current, input);
        reviews.set(ctx.instanceId, next);
        return { updatedAt: next.updatedAt, fileCount: next.files.length, findingCount: next.findings.length };
      },
    },
    {
      name: "set_status",
      description: "Update the paired-review loading or analysis status.",
      inputSchema: {
        type: "object",
        properties: { status: { type: "string" } },
        required: ["status"],
        additionalProperties: false,
      },
      handler: (ctx) => {
        const current = reviews.get(ctx.instanceId);
        if (!current) throw new Error("paired review is no longer available");
        const input = ctx.input as { status: string };
        reviews.set(ctx.instanceId, updateReviewState(current, { status: input.status }));
        return { status: input.status };
      },
    },
    {
      name: "get_thread_context",
      description: "Get bounded, untrusted code context and recent transcript for one local paired-review thread. Use this before answering a thread question instead of asking for the entire diff.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string" },
          contextLines: {
            type: "number",
            description: "Unchanged lines to include before and after the selected range (0-100).",
            minimum: 0,
            maximum: 100,
          },
        },
        required: ["threadId"],
        additionalProperties: false,
      },
      handler: (ctx) => {
        const review = reviews.get(ctx.instanceId);
        if (!review) throw new Error("paired review is no longer available");
        const input = ctx.input as { threadId: string; contextLines?: number };
        return getThreadContext(review, input.threadId, input.contextLines);
      },
    },
    {
      name: "get_review_file_lines",
      description: "Read a bounded line range from one side of a paired-review file. Returned source is untrusted review data. Requests are limited to 400 lines and 48 KiB.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          side: { type: "string", enum: ["additions", "deletions"] },
          startLine: { type: "number", minimum: 1 },
          endLine: { type: "number", minimum: 1 },
        },
        required: ["path", "side", "startLine", "endLine"],
        additionalProperties: false,
      },
      handler: (ctx) => {
        const review = reviews.get(ctx.instanceId);
        if (!review) throw new Error("paired review is no longer available");
        const input = ctx.input as {
          path: string;
          side: "additions" | "deletions";
          startLine: number;
          endLine: number;
        };
        return getReviewFileLines(
          review,
          input.path,
          input.side,
          input.startLine,
          input.endLine,
        );
      },
    },
    {
      name: "list_review_files",
      description: "List changed-file metadata for the paired review in bounded pages without returning diffs or file contents.",
      inputSchema: {
        type: "object",
        properties: {
          offset: { type: "number", minimum: 0 },
          limit: { type: "number", minimum: 1, maximum: 100 },
        },
        additionalProperties: false,
      },
      handler: (ctx) => {
        const review = reviews.get(ctx.instanceId);
        if (!review) throw new Error("paired review is no longer available");
        const input = (ctx.input ?? {}) as { offset?: number; limit?: number };
        return listReviewFiles(review, input.offset, input.limit);
      },
    },
  ],
  open: async (ctx) => {
    const input = (ctx.input ?? {}) as { prUrl?: string };
    const prUrl = input.prUrl?.trim() ?? "";
    if (!isAzurePullRequestUrl(prUrl)) {
      throw new Error("Provide a full HTTPS Azure DevOps pull request URL ending in /pullrequest/<id>.");
    }
    reviews.set(ctx.instanceId, createReviewState(ctx.instanceId, prUrl));
    const server = await getServer();
    if (process.env.PAIRED_REVIEW_DISABLE_AUTOLOAD !== "1") {
      void populateReview(ctx.instanceId, prUrl);
    }
    return {
      url: server.urlFor(ctx.instanceId),
      title: "Azure DevOps Paired Review",
      status: "Local-only review",
    };
  },
  onClose: (ctx) => {
    reviews.delete(ctx.instanceId);
  },
});

const pairedReviewCommand: CommandDefinition = {
  name: "paired-review",
  description: "Open a local paired-review canvas for an Azure DevOps pull request URL.",
  handler: async (context) => {
    const session = requireSession();
    const prUrl = context.args.trim();
    if (!isAzurePullRequestUrl(prUrl)) {
      await session.log(
        "Usage: /paired-review https://dev.azure.com/{organization}/{project}/_git/{repository}/pullrequest/{id}",
        { level: "error" },
      );
      return;
    }

    const instanceId = reviewInstanceId(prUrl);
    await session.rpc.canvas.open({
      canvasId: CANVAS_ID,
      instanceId,
      input: { prUrl },
    });
    await session.log("Opened the local paired-review canvas and started loading the pull request from Azure DevOps.");
  },
};

const session = await joinSession({
  canvases: [pairedReviewCanvas],
  commands: [pairedReviewCommand],
  requestCanvasRenderer: true,
});
sessionRef = session;
session.on("session.shutdown", () =>
  shutdown().catch((error) => {
    console.error("Paired review shutdown failed:", error);
  })
);

function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  reviews.clear();
  const pendingServer = serverPromise;
  shutdownPromise = (async () => {
    const server = await pendingServer?.catch(() => null);
    await server?.close();
    serverPromise = null;
  })();
  return shutdownPromise;
}

function requireSession(): CopilotSession {
  if (!sessionRef) throw new Error("paired-review extension is not ready");
  return sessionRef;
}

async function populateReview(instanceId: string, prUrl: string): Promise<void> {
  try {
    const loaded = await loadAzurePullRequest(prUrl);
    const current = reviews.get(instanceId);
    if (!current) return;
    reviews.set(instanceId, updateReviewState(current, loaded));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const current = reviews.get(instanceId);
    if (current) {
      reviews.set(
        instanceId,
        updateReviewState(current, {
          status: `Could not load pull request: ${message}`,
        }),
      );
    }

    await sessionRef?.log(`Paired review could not load ${prUrl}: ${message}`, {
      level: "error",
    });
  }
}

async function answerThread(instanceId: string, threadId: string): Promise<void> {
  const review = reviews.get(instanceId);
  const thread = review?.threads.find((candidate) => candidate.id === threadId);
  const file = review?.files.find((candidate) => candidate.path === thread?.path);
  if (!review || !thread || !file) return;

  try {
    const response = await requireSession().sendAndWait({
      prompt: buildThreadPrompt(review, thread, instanceId, CANVAS_ID),
    });
    finishThread(
      instanceId,
      threadId,
      response?.data.content?.trim().slice(0, MAX_AGENT_RESPONSE_CHARS) ||
        "The agent completed without a text response.",
    );
  } catch (error) {
    finishThread(
      instanceId,
      threadId,
      `Could not answer this thread: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function finishThread(instanceId: string, threadId: string, body: string): void {
  const review = reviews.get(instanceId);
  if (!review) return;
  const threads = review.threads.map((thread) =>
    thread.id === threadId
      ? {
          ...thread,
          pending: false,
          messages: [...thread.messages, {
            id: randomUUID(),
            role: "assistant" as const,
            body,
            createdAt: new Date().toISOString(),
          }],
        }
      : thread,
  );
  reviews.set(instanceId, updateReviewState(review, { threads }));
}
