import { afterEach, describe, expect, it, vi } from "vitest";
import { createReviewState } from "../src/review-state.ts";
import { startReviewServer } from "../src/server.ts";

const servers: Array<Awaited<ReturnType<typeof startReviewServer>>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function createServer() {
  const createThread = vi.fn(async () => "thread-1");
  const replyToThread = vi.fn(async () => {});
  const updateThread = vi.fn(async () => {});
  const server = await startReviewServer({
    getState: () => createReviewState("review-1", "https://dev.azure.com/o/p/_git/r/pullrequest/1"),
    createThread,
    replyToThread,
    updateThread,
    setActivePath: vi.fn(),
  });
  servers.push(server);
  const canvasUrl = new URL(server.urlFor("review-1"));
  const apiUrl = (pathname: string) => {
    const url = new URL(canvasUrl);
    url.pathname = pathname;
    return url;
  };
  return { apiUrl, createThread, replyToThread, updateThread };
}

describe("review thread API", () => {
  it("validates and creates an inline thread", async () => {
    const { apiUrl, createThread } = await createServer();
    const response = await fetch(apiUrl("/api/threads"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: "src/index.ts",
        side: "additions",
        lineStart: 4,
        lineEnd: 6,
        body: "  Is this safe?  ",
      }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, threadId: "thread-1" });
    expect(createThread).toHaveBeenCalledWith("review-1", {
      path: "src/index.ts",
      side: "additions",
      lineStart: 4,
      lineEnd: 6,
      body: "Is this safe?",
    });

  });

  it("updates collapsed and resolved thread state", async () => {
    const { apiUrl, updateThread } = await createServer();
    const response = await fetch(apiUrl("/api/threads/thread-1"), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ collapsed: true, resolved: true }),
    });
    expect(response.status).toBe(200);
    expect(updateThread).toHaveBeenCalledWith("review-1", "thread-1", {
      collapsed: true,
      resolved: true,
    });
  });

  it("rejects invalid ranges and forwards valid replies", async () => {
    const { apiUrl, createThread, replyToThread } = await createServer();
    const invalid = await fetch(apiUrl("/api/threads"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: "src/index.ts",
        side: "additions",
        lineStart: 8,
        lineEnd: 3,
        body: "Question",
      }),
    });
    expect(invalid.status).toBe(400);
    expect(createThread).not.toHaveBeenCalled();

    const reply = await fetch(apiUrl("/api/threads/thread-1/messages"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "  Follow up  " }),
    });
    expect(reply.status).toBe(202);
    expect(replyToThread).toHaveBeenCalledWith("review-1", "thread-1", "Follow up");
  });
});
