import { afterEach, describe, expect, it, vi } from "vitest";
import { createReviewState, updateReviewState } from "../src/review-state.ts";
import { startReviewServer } from "../src/server.ts";

const servers: Array<Awaited<ReturnType<typeof startReviewServer>>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function createServer() {
  const createThread = vi.fn(async () => "thread-1");
  const startReviewPass = vi.fn(async () => ({
    pass: { kind: "queued" as const, id: "pass-1", requestId: "request-1" },
    scheduled: true,
  }));
  const replyToThread = vi.fn(async () => {});
  const updateThread = vi.fn(async () => {});
  const server = await startReviewServer({
    getState: () => updateReviewState(
      createReviewState("review-1", "https://dev.azure.com/o/p/_git/r/pullrequest/1"),
      { loaded: true },
    ),
    startReviewPass,
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
  return { apiUrl, createThread, replyToThread, startReviewPass, updateThread };
}

describe("review thread API", () => {
  it("validates and starts an idempotent review pass without exposing publication", async () => {
    const { apiUrl, startReviewPass } = await createServer();
    const invalid = await fetch(apiUrl("/api/review-passes"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "" }),
    });
    expect(invalid.status).toBe(400);

    const malformed = await fetch(apiUrl("/api/review-passes"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "request body must contain valid JSON" });

    const started = await fetch(apiUrl("/api/review-passes"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "request-1" }),
    });
    expect(started.status).toBe(202);
    expect(startReviewPass).toHaveBeenCalledWith("review-1", "request-1");

    const publish = await fetch(apiUrl("/api/publish-review-findings"), { method: "POST" });
    expect(publish.status).toBe(404);
  });

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
