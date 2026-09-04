import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { ReviewStateSchema } from "../src/review-schema.ts";
import {
  changedLineRanges,
  createQuestionThread,
  createReviewState,
  failReviewPass,
  findingId,
  insertReviewFinding,
  isAzurePullRequestUrl,
  parseAzurePullRequestUrl,
  queueReviewPass,
  reviewInstanceId,
  startQueuedReviewPass,
  completeReviewPass,
  updateReviewState,
} from "../src/review-state.ts";

describe("isAzurePullRequestUrl", () => {
  it("accepts current and legacy Azure DevOps pull request URLs", () => {
    expect(
      isAzurePullRequestUrl(
        "https://dev.azure.com/example/project/_git/repo/pullrequest/4821",
      ),
    ).toBe(true);
    expect(
      isAzurePullRequestUrl(
        "https://example.visualstudio.com/project/_git/repo/pullrequest/4821",
      ),
    ).toBe(true);
  });

  it("rejects non-HTTPS and unrelated URLs", () => {
    expect(
      isAzurePullRequestUrl(
        "http://dev.azure.com/example/project/_git/repo/pullrequest/4821",
      ),
    ).toBe(false);
    expect(isAzurePullRequestUrl("https://github.com/example/repo/pull/1")).toBe(false);
  });
});

describe("parseAzurePullRequestUrl", () => {
  it("extracts scope from current Azure DevOps URLs", () => {
    expect(
      parseAzurePullRequestUrl(
        "https://dev.azure.com/example/My%20Project/_git/repo/pullrequest/4821?_a=files",
      ),
    ).toEqual({
      organizationUrl: "https://dev.azure.com/example",
      project: "My Project",
      repository: "repo",
      pullRequestId: 4821,
    });
  });
});

describe("reviewInstanceId", () => {
  it("distinguishes the same PR number in different repositories", () => {
    const first = reviewInstanceId(
      "https://dev.azure.com/example/project/_git/one/pullrequest/42",
    );
    const second = reviewInstanceId(
      "https://dev.azure.com/example/project/_git/two/pullrequest/42",
    );
    expect(first).not.toBe(second);
  });

  it("ignores view query parameters for the same pull request", () => {
    const base = "https://dev.azure.com/example/project/_git/repo/pullrequest/42";
    expect(reviewInstanceId(`${base}?_a=files`)).toBe(reviewInstanceId(base));
  });
});

describe("updateReviewState", () => {
  it("preserves files when only the status changes", () => {
    const initial = createReviewState("review-1", "https://dev.azure.com/o/p/_git/r/pullrequest/1");
    const withFiles = updateReviewState(initial, {
      files: [{ path: "src/index.ts", diff: "+hello" }],
    });
    const updated = updateReviewState(withFiles, { status: "Ready" });
    expect(updated.files).toEqual(withFiles.files);
    expect(updated.status).toBe("Ready");
    expect(Value.Check(ReviewStateSchema, updated)).toBe(true);
  });
});

function changedReview() {
  return updateReviewState(
    createReviewState("review-1", "https://dev.azure.com/o/p/_git/r/pullrequest/1"),
    {
      loaded: true,
      files: [{
        path: "src/example.ts",
        diff: "@@ -2,2 +2,2 @@\n-old value\n+new value\n same\n",
        oldContent: "one\nold value\nsame\n",
        newContent: "one\nnew value\nsame\n",
        changedLineRanges: changedLineRanges("@@ -2,2 +2,2 @@\n-old value\n+new value\n same\n"),
      }],
    },
  );
}

describe("review pass lifecycle", () => {
  it("queues one pass per request and reports each lifecycle state", () => {
    const queued = queueReviewPass(changedReview(), "request-1");
    expect(queued.scheduled).toBe(true);
    expect(queueReviewPass(queued.review, "request-1").scheduled).toBe(false);
    expect(queueReviewPass(queued.review, "request-2").scheduled).toBe(false);
    if (queued.pass.kind !== "queued") throw new Error("expected queued pass");

    const running = startQueuedReviewPass(queued.review, queued.pass.id);
    expect(running.reviewPass).toMatchObject({ kind: "running", requestId: "request-1" });
    const completed = completeReviewPass(running, queued.pass.id);
    expect(completed.reviewPass).toMatchObject({ kind: "completed", findingCount: 0 });
    expect(queueReviewPass(completed, "request-1").scheduled).toBe(false);
    expect(failReviewPass(running, queued.pass.id, "session failed").reviewPass)
      .toMatchObject({ kind: "failed", error: "session failed" });
  });
});

describe("Copilot findings", () => {
  const input = {
    path: "src/example.ts",
    side: "additions" as const,
    lineStart: 2,
    lineEnd: 2,
    severity: "info" as const,
    title: "Incorrect value",
    body: "The value stays stale.",
  };

  it("uses a severity-independent fingerprint and starts with Copilot", () => {
    const first = insertReviewFinding(changedReview(), input, "pass-1");
    const second = insertReviewFinding(first.review, { ...input, severity: "blocking" }, "pass-2");
    expect(first.thread.messages[0]?.role).toBe("assistant");
    expect(first.thread.finding.createdByPass).toBe("pass-1");
    expect(second.inserted).toBe(false);
    expect(second.thread.id).toBe(first.thread.id);
    expect(findingId(first.thread.anchor, " Incorrect value ", "The value stays stale.\r\n"))
      .toBe(first.thread.finding.id);
    expect(findingId(first.thread.anchor, "Incorrect  value", "The value stays stale."))
      .not.toBe(first.thread.finding.id);
  });

  it("updates the running pass finding count", () => {
    const queued = queueReviewPass(changedReview(), "request-1");
    if (queued.pass.kind !== "queued") throw new Error("expected queued pass");
    const running = startQueuedReviewPass(queued.review, queued.pass.id);

    const inserted = insertReviewFinding(running, input, queued.pass.id);

    expect(inserted.review.reviewPass).toMatchObject({ kind: "running", findingCount: 1 });
  });

  describe("changed line ranges", () => {
    it("keeps source lines that begin with diff header markers", () => {
      const ranges = changedLineRanges(
        "@@ -1,2 +1,2 @@\n----\n++++\n-old\n+new\n",
      );
      expect(ranges).toEqual({
        additions: [{ start: 1, end: 2 }],
        deletions: [{ start: 1, end: 2 }],
      });
    });
  });

  it("rejects ranges outside changed review lines", () => {
    expect(() => insertReviewFinding(changedReview(), { ...input, lineStart: 3, lineEnd: 3 }, "pass-1"))
      .toThrow("not part of the changed review content");
  });

  it("keeps user questions available on unchanged context lines", () => {
    const created = createQuestionThread(
      changedReview(),
      "src/example.ts",
      "additions",
      3,
      3,
      "How does this context affect the change?",
    );
    expect(created.thread.anchor).toMatchObject({ lineStart: 3, lineEnd: 3 });
  });
});
