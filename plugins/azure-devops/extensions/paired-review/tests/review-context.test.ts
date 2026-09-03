import { describe, expect, it } from "vitest";
import {
  buildThreadPrompt,
  getReviewFileLines,
  getThreadContext,
  listReviewFiles,
} from "../src/review-context.ts";
import { createReviewState, updateReviewState } from "../src/review-state.ts";

function reviewFixture() {
  const initial = createReviewState(
    "review-1",
    "https://dev.azure.com/example/project/_git/repo/pullrequest/42",
  );
  return updateReviewState(initial, {
    title: "Bounded context",
    files: [{
      path: "src/example.ts",
      previousPath: "src/example.ts",
      diff: "partial diff",
      oldContent: "old one\nold two\nold three\n",
      newContent: "new one\nnew two\nnew three\nnew four\n",
    }],
    threads: [{
      id: "thread-1",
      path: "src/example.ts",
      side: "additions",
      lineStart: 2,
      lineEnd: 2,
      pending: true,
      collapsed: false,
      resolved: false,
      messages: [{
        id: "message-1",
        role: "user",
        body: "Why did this change?",
        createdAt: "2026-01-01T00:00:00.000Z",
      }],
    }],
  });
}

describe("paired-review context actions", () => {
  it("keeps the initial agent prompt free of eager diff and file-list content", () => {
    const review = reviewFixture();
    review.files.push({
      path: "src/another-file.ts",
      diff: "another secret diff",
    });
    const prompt = buildThreadPrompt(
      review,
      review.threads[0],
      "review-1",
      "azure-devops-paired-review",
    );
    expect(prompt).toContain("Why did this change?");
    expect(prompt).toContain("get_thread_context");
    expect(prompt).not.toContain("partial diff");
    expect(prompt).not.toContain("another secret diff");
    expect(prompt).not.toContain("src/another-file.ts");
  });

  it("returns bounded selected context without the full diff", () => {
    const context = getThreadContext(reviewFixture(), "thread-1", 1);
    expect(context.selectedContext).toMatchObject({
      available: true,
      startLine: 1,
      endLine: 3,
      text: "new one\nnew two\nnew three",
    });
    expect(JSON.stringify(context)).not.toContain("partial diff");
  });

  it("limits explicit file reads and paginates metadata", () => {
    const review = reviewFixture();
    expect(getReviewFileLines(review, "src/example.ts", "deletions", 2, 3)).toMatchObject({
      text: "old two\nold three",
    });
    expect(() =>
      getReviewFileLines(review, "src/example.ts", "additions", 1, 401)
    ).toThrow("cannot exceed 400 lines");
    expect(getReviewFileLines(review, "src/example.ts", "additions", 20, 21)).toMatchObject({
      startLine: 20,
      endLine: 19,
      text: "",
    });
    expect(listReviewFiles(review, 0, 1)).toMatchObject({
      total: 1,
      files: [{ path: "src/example.ts" }],
    });
  });
});
