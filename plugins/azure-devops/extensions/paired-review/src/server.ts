import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "@sinclair/typebox/value";
import {
  CreateReviewThreadInputSchema,
  FocusReviewFileInputSchema,
  ReplyToReviewThreadInputSchema,
  StartReviewPassInputSchema,
  UpdateReviewThreadInputSchema,
  type CreateReviewThreadInput,
  type ReviewPass,
  type UpdateReviewThreadInput,
} from "./review-schema.ts";
import type { ReviewState } from "./review-state.ts";

interface ReviewServerOptions {
  getState: (instanceId: string) => ReviewState | undefined;
  startReviewPass: (
    instanceId: string,
    requestId: string,
  ) => Promise<{ pass: ReviewPass; scheduled: boolean }>;
  createThread: (instanceId: string, input: CreateReviewThreadInput) => Promise<string>;
  replyToThread: (instanceId: string, threadId: string, body: string) => Promise<void>;
  updateThread: (instanceId: string, threadId: string, input: UpdateReviewThreadInput) => Promise<void>;
  setActivePath: (instanceId: string, activePath: string) => void;
}

const MAX_BODY_BYTES = 128 * 1024;
const assetsDirectory = fileURLToPath(new URL("../public", import.meta.url));
const canvasPath = "/app";

export async function startReviewServer(options: ReviewServerOptions) {
  const token = randomBytes(24).toString("hex");
  const server = createServer(async (request, response) => {
    try {
      await route(request, response, token, options);
    } catch (error) {
      respondJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;
  return {
    urlFor(instanceId: string) {
      const query = new URLSearchParams({ instance: instanceId, token });
      return `http://127.0.0.1:${address.port}${canvasPath}?${query}`;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  options: ReviewServerOptions,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (request.method === "GET" && url.pathname.startsWith(`${canvasPath}/`)) {
    await serveAsset(url.pathname, response);
    return;
  }

  if (url.searchParams.get("token") !== token) {
    respondJson(response, 403, { error: "invalid canvas token" });
    return;
  }

  if (request.method === "GET" && (url.pathname === canvasPath || url.pathname === `${canvasPath}/`)) {
    await serveAsset("/app/index.html", response, true);
    return;
  }

  const instanceId = url.searchParams.get("instance") ?? "";
  if (!instanceId) {
    respondJson(response, 400, { error: "missing instance" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/state") {
    const state = options.getState(instanceId);
    respondJson(response, state ? 200 : 404, state ?? { error: "review not found" });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/review-passes") {
    const review = options.getState(instanceId);
    if (!review) {
      respondJson(response, 404, { error: "review not found" });
      return;
    }
    if (!review.loaded) {
      respondJson(response, 409, { error: "pull request is still loading" });
      return;
    }
    const body = await readJsonBody(request);
    if (!Value.Check(StartReviewPassInputSchema, body)) {
      respondJson(response, 400, { error: "requestId is required" });
      return;
    }
    const requestId = body.requestId.trim();
    if (!requestId) {
      respondJson(response, 400, { error: "requestId is required" });
      return;
    }
    const started = await options.startReviewPass(instanceId, requestId);
    respondJson(response, 202, {
      accepted: true,
      scheduled: started.scheduled,
      reviewPass: started.pass,
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/threads") {
    const body = await readJsonBody(request);
    const thread = parseThreadInput(body);
    if (!thread) {
      respondJson(response, 400, { error: "valid path, side, line range, and body are required" });
      return;
    }
    const threadId = await options.createThread(instanceId, thread);
    respondJson(response, 202, { accepted: true, threadId });
    return;
  }

  const replyMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/messages$/);
  if (request.method === "POST" && replyMatch) {
    const body = await readJsonBody(request);
    const message = Value.Check(ReplyToReviewThreadInputSchema, body)
      ? body.body.trim()
      : "";
    if (!message) {
      respondJson(response, 400, { error: "message is required" });
      return;
    }
    await options.replyToThread(instanceId, decodeURIComponent(replyMatch[1]), message);
    respondJson(response, 202, { accepted: true });
    return;
  }

  const threadMatch = url.pathname.match(/^\/api\/threads\/([^/]+)$/);
  if (request.method === "PATCH" && threadMatch) {
    const body = await readJsonBody(request);
    if (
      !Value.Check(UpdateReviewThreadInputSchema, body) ||
      (body.collapsed === undefined && body.resolved === undefined)
    ) {
      respondJson(response, 400, { error: "collapsed or resolved state is required" });
      return;
    }
    await options.updateThread(instanceId, decodeURIComponent(threadMatch[1]), body);
    respondJson(response, 200, { updated: true });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/focus") {
    const body = await readJsonBody(request);
    const activePath = Value.Check(FocusReviewFileInputSchema, body)
      ? body.activePath
      : "";
    options.setActivePath(instanceId, activePath);
    respondJson(response, 200, { activePath });
    return;
  }

  respondJson(response, 404, { error: "not found" });
}

function parseThreadInput(body: unknown): CreateReviewThreadInput | null {
  if (!Value.Check(CreateReviewThreadInputSchema, body)) return null;
  const message = body.body.trim();
  if (body.lineEnd < body.lineStart || !message) return null;
  return { ...body, body: message };
}

async function serveAsset(
  requestPath: string,
  response: ServerResponse,
  html = false,
): Promise<void> {
  const relativePath = requestPath.replace(/^\/app\/?/, "") || "index.html";
  const filePath = path.resolve(assetsDirectory, relativePath);
  if (!filePath.startsWith(`${assetsDirectory}${path.sep}`)) {
    respondJson(response, 404, { error: "not found" });
    return;
  }
  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Cache-Control": "no-store",
      ...(html ? {
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; worker-src 'self' blob:",
      } : {}),
    });
    response.end(content);
  } catch {
    respondJson(response, 404, { error: "not found" });
  }
}

function contentType(filePath: string): string {
  switch (path.extname(filePath)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body is too large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function respondJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}
