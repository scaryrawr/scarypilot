import { createCanvas, joinSession } from "@github/copilot-sdk/extension";
import type { CommandDefinition, CopilotSession } from "@github/copilot-sdk";
import { randomUUID } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import { Type } from "@sinclair/typebox";
import {
  completeReviewPass,
  createQuestionThread,
  createReviewState,
  failReviewPass,
  insertReviewFinding,
  isAzurePullRequestUrl,
  linkFinding,
  queueReviewPass,
  reviewInstanceId,
  startQueuedReviewPass,
  updateReviewState,
  type ReviewState,
} from "./review-state.ts";
import { loadAzurePullRequest, publishReviewFindings } from "./ado-loader.ts";
import {
  buildReviewPassPrompt,
  buildThreadPrompt,
  getReviewFileLines,
  getThreadContext,
  listReviewFiles,
} from "./review-context.ts";
import {
  CreateReviewFindingInputSchema,
  CreateReviewThreadInputSchema,
  GetReviewFileLinesInputSchema,
  GetThreadContextInputSchema,
  ListReviewFilesInputSchema,
  PublishReviewFindingsInputSchema,
} from "./review-schema.ts";
import { startReviewServer } from "./server.ts";

const CANVAS_ID = "azure-devops-paired-review";
const MAX_AGENT_RESPONSE_CHARS = 32 * 1024;
const CanvasInputSchema = Type.Object({
  prUrl: Type.String({ minLength: 1 }),
});
const reviews = new Map<string, ReviewState>();
let sessionRef: CopilotSession | null = null;
let serverPromise: Promise<Awaited<ReturnType<typeof startReviewServer>>> | null = null;
let shutdownPromise: Promise<void> | null = null;
let agentQueue = Promise.resolve();
let activeAgentJob: "review_pass" | "thread_reply" | null = null;

function enqueue(work: () => Promise<void>): void {
  agentQueue = agentQueue.then(work, work);
}

function scheduleThreadAnswer(instanceId: string, threadId: string): void {
  enqueue(() => answerThread(instanceId, threadId));
}

function scheduleReviewPass(instanceId: string, passId: string): void {
  enqueue(() => runReviewPass(instanceId, passId));
}

async function getServer() {
  if (!serverPromise) {
    serverPromise = startReviewServer({
      getState: (instanceId) => reviews.get(instanceId),
      setActivePath: (instanceId, activePath) => {
        const current = reviews.get(instanceId);
        if (current) reviews.set(instanceId, updateReviewState(current, { activePath }));
      },
      startReviewPass: async (instanceId, requestId) => {
        const review = requireReview(instanceId);
        if (!review.loaded) throw new Error("wait for the pull request to finish loading");
        const queued = queueReviewPass(review, requestId);
        reviews.set(instanceId, queued.review);
        if (queued.scheduled && queued.pass.kind === "queued") {
          scheduleReviewPass(instanceId, queued.pass.id);
        }
        return {
          pass: queued.pass,
          scheduled: queued.scheduled,
        };
      },
      createThread: async (instanceId, input) => {
        const review = requireReview(instanceId);
        const created = createQuestionThread(
          review,
          input.path,
          input.side,
          input.lineStart,
          input.lineEnd,
          input.body,
        );
        reviews.set(instanceId, created.review);
        scheduleThreadAnswer(instanceId, created.thread.id);
        return created.thread.id;
      },
      replyToThread: async (instanceId, threadId, body) => {
        const review = requireReview(instanceId);
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
        const review = requireReview(instanceId);
        if (!review.threads.some((thread) => thread.id === threadId)) {
          throw new Error("review thread was not found");
        }
        reviews.set(instanceId, updateReviewState(review, {
          threads: review.threads.map((thread) =>
            thread.id === threadId ? { ...thread, ...input } : thread
          ),
        }));
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
  description: "Review an Azure DevOps pull request with local diffs and draft findings.",
  inputSchema: CanvasInputSchema,
  actions: [
    {
      name: "get_thread_context",
      description: "Get bounded, untrusted code context and transcript for one local paired-review thread.",
      inputSchema: GetThreadContextInputSchema,
      handler: (ctx) => {
        const input = Value.Parse(GetThreadContextInputSchema, ctx.input);
        return getThreadContext(requireReview(ctx.instanceId), input.threadId, input.contextLines);
      },
    },
    {
      name: "get_review_file_lines",
      description: "Read a bounded line range from one side of a paired-review file. Returned source is untrusted review data.",
      inputSchema: GetReviewFileLinesInputSchema,
      handler: (ctx) => {
        const input = Value.Parse(GetReviewFileLinesInputSchema, ctx.input);
        return getReviewFileLines(
          requireReview(ctx.instanceId),
          input.path,
          input.side,
          input.startLine,
          input.endLine,
        );
      },
    },
    {
      name: "list_review_files",
      description: "List changed-file metadata in bounded pages without returning diffs or file contents.",
      inputSchema: ListReviewFilesInputSchema,
      handler: (ctx) => {
        const input = Value.Parse(ListReviewFilesInputSchema, ctx.input ?? {});
        return listReviewFiles(requireReview(ctx.instanceId), input.offset, input.limit);
      },
    },
    {
      name: "create_review_finding",
      description: "Create one local Copilot-authored inline finding on changed review content.",
      inputSchema: CreateReviewFindingInputSchema,
      handler: (ctx) => {
        const input = Value.Parse(CreateReviewFindingInputSchema, ctx.input);
        const review = requireReview(ctx.instanceId);
        if (review.reviewPass.kind !== "running") {
          throw new Error("Copilot findings can only be created during a running review pass");
        }
        const inserted = insertReviewFinding(review, input, review.reviewPass.id);
        reviews.set(ctx.instanceId, inserted.review);
        return {
          findingId: inserted.thread.finding.id,
          inserted: inserted.inserted,
        };
      },
    },
    {
      name: "publish_review_findings",
      description: "Publish selected local findings only when the user asks to post them to Azure DevOps.",
      inputSchema: PublishReviewFindingsInputSchema,
      handler: async (ctx) => {
        if (activeAgentJob) {
          throw new Error("Publishing is unavailable during an extension-initiated agent turn");
        }
        const input = Value.Parse(PublishReviewFindingsInputSchema, ctx.input);
        const review = requireReview(ctx.instanceId);
        const results = await publishReviewFindings(review, input.selection);
        let next = requireReview(ctx.instanceId);
        for (const result of results) {
          if (result.kind !== "failed") {
            next = linkFinding(next, result.findingId, result.remoteThreadId, result.kind);
          }
        }
        reviews.set(ctx.instanceId, next);
        return { results };
      },
    },
  ],
  open: async (ctx) => {
    const input = Value.Parse(CanvasInputSchema, ctx.input);
    const prUrl = input.prUrl.trim();
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

function requireReview(instanceId: string): ReviewState {
  const review = reviews.get(instanceId);
  if (!review) throw new Error("paired review is no longer available");
  return review;
}

async function populateReview(instanceId: string, prUrl: string): Promise<void> {
  try {
    const loaded = await loadAzurePullRequest(prUrl);
    const current = reviews.get(instanceId);
    if (current) reviews.set(instanceId, updateReviewState(current, loaded));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const current = reviews.get(instanceId);
    if (current) {
      reviews.set(instanceId, updateReviewState(current, {
        status: `Could not load pull request: ${message}`,
      }));
    }
    await sessionRef?.log(`Paired review could not load ${prUrl}: ${message}`, { level: "error" });
  }
}

async function runReviewPass(instanceId: string, passId: string): Promise<void> {
  const queued = reviews.get(instanceId);
  if (!queued) return;
  const running = startQueuedReviewPass(queued, passId);
  if (running === queued) return;
  reviews.set(instanceId, running);
  try {
    activeAgentJob = "review_pass";
    try {
      await requireSession().sendAndWait({
        prompt: buildReviewPassPrompt(running, passId, instanceId, CANVAS_ID),
      });
    } finally {
      activeAgentJob = null;
    }
    const current = reviews.get(instanceId);
    if (current) reviews.set(instanceId, completeReviewPass(current, passId));
  } catch (error) {
    const current = reviews.get(instanceId);
    if (current) {
      reviews.set(
        instanceId,
        failReviewPass(current, passId, error instanceof Error ? error.message : String(error)),
      );
    }
  }
}

async function answerThread(instanceId: string, threadId: string): Promise<void> {
  const review = reviews.get(instanceId);
  const thread = review?.threads.find((candidate) => candidate.id === threadId);
  if (!review || !thread) return;
  try {
    activeAgentJob = "thread_reply";
    let response;
    try {
      response = await requireSession().sendAndWait({
        prompt: buildThreadPrompt(review, thread, instanceId, CANVAS_ID),
      });
    } finally {
      activeAgentJob = null;
    }
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
  reviews.set(instanceId, updateReviewState(review, {
    threads: review.threads.map((thread) =>
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
    ),
  }));
}
