import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { ReviewStateSchema } from "../src/review-schema.ts";
import {
  createReviewState,
  isAzurePullRequestUrl,
  parseAzurePullRequestUrl,
  reviewInstanceId,
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
