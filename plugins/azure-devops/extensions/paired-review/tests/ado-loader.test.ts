import { describe, expect, it } from "vitest";
import {
  loadAzurePullRequest,
  publishReviewFindings,
  type AzureCliRunner,
} from "../src/ado-loader.ts";
import {
  changedLineRanges,
  createReviewState,
  insertReviewFinding,
  updateReviewState,
} from "../src/review-state.ts";

describe("loadAzurePullRequest", () => {
  it("loads changed contents and builds a unified patch", async () => {
    const jsonCalls: string[][] = [];
    const fileCalls: string[][] = [];
    const runner: AzureCliRunner = {
      async json(args) {
        jsonCalls.push(args);
        if (args.includes("show")) {
          return {
            title: "Update greeting",
            sourceRefName: "refs/heads/feature",
            targetRefName: "refs/heads/main",
            repository: { id: "repo-id" },
          };
        }
        if (args.includes("pullRequestIterations")) {
          return {
            value: [{
              id: 2,
              commonRefCommit: { commitId: "target-sha" },
              sourceRefCommit: { commitId: "source-sha" },
            }],
          };
        }
        return { changeEntries: [{ changeType: "edit", item: { path: "/src/greeting.ts" } }] };
      },
      async file(args) {
        fileCalls.push(args);
        return Buffer.from(args.includes("versionDescriptor.version=source-sha")
          ? 'export const greeting = "hello";\n'
          : 'export const greeting = "hi";\n');
      },
    };

    const loaded = await loadAzurePullRequest(
      "https://dev.azure.com/example/project/_git/repo/pullrequest/42",
      runner,
    );

    expect(loaded).toMatchObject({
      title: "Update greeting",
      sourceBranch: "feature",
      targetBranch: "main",
      status: "Loaded 1 changed file",
      loaded: true,
    });
    expect(loaded.files[0]).toMatchObject({
      path: "src/greeting.ts",
      previousPath: "src/greeting.ts",
      additions: 1,
      deletions: 1,
      oldContent: 'export const greeting = "hi";\n',
      newContent: 'export const greeting = "hello";\n',
      iterationId: 2,
    });
    expect(jsonCalls.some((args) => args.includes("pullRequestIterationChanges"))).toBe(true);
    expect(fileCalls).toHaveLength(2);
  });
});

function reviewWithFindings(changeTrackingId = 17, iterationId = 3) {
  const review = updateReviewState(
    createReviewState("review-1", "https://dev.azure.com/example/project/_git/repo/pullrequest/42"),
    {
      loaded: true,
      files: [{
        path: "src/example.ts",
        diff: "@@ -2,2 +2,2 @@\n-old first\n+new first\n-old second\n+new second\n",
        oldContent: "one\nold first\nold second\n",
        newContent: "one\nnew first\nnew second\n",
        changedLineRanges: changedLineRanges(
          "@@ -2,2 +2,2 @@\n-old first\n+new first\n-old second\n+new second\n",
        ),
        changeTrackingId,
        iterationId,
      }],
    },
  );
  const first = insertReviewFinding(review, {
    path: "src/example.ts",
    side: "additions",
    lineStart: 2,
    lineEnd: 2,
    severity: "warning",
    title: "First finding",
    body: "First body",
  }, "pass-1");
  return insertReviewFinding(first.review, {
    path: "src/example.ts",
    side: "deletions",
    lineStart: 3,
    lineEnd: 3,
    severity: "blocking",
    title: "Second finding",
    body: "Second body",
  }, "pass-1").review;
}

function publicationRunner(
  listResponses: unknown[],
  create: (call: number) => unknown | Error = (call) => ({ id: 100 + call }),
) {
  const calls: Array<{ args: string[]; body: unknown }> = [];
  let listIndex = 0;
  let createIndex = 0;
  const runner: AzureCliRunner = {
    async json(args, body) {
      calls.push({ args, body });
      if (args.includes("show")) return { repository: { id: "repo-id" } };
      if (args.includes("pullRequestThreads") && !args.includes("--http-method")) {
        return listResponses[listIndex++] ?? { value: [] };
      }
      if (args.includes("--http-method")) {
        const result = create(createIndex++);
        if (result instanceof Error) throw result;
        return result;
      }
      throw new Error(`Unexpected Azure CLI call: ${args.join(" ")}`);
    },
    async file() {
      throw new Error("Publication does not read file content");
    },
  };
  return { calls, runner };
}

describe("publishReviewFindings", () => {
  it("publishes findings with zero-valued tracking context", async () => {
    const review = reviewWithFindings(0, 0);
    const { calls, runner } = publicationRunner([{ value: [] }]);

    const [result] = await publishReviewFindings(
      review,
      { kind: "finding_ids", findingIds: [review.threads[0]!.id] },
      runner,
    );

    expect(result?.kind).toBe("published");
    expect(calls.find((call) => call.args.includes("--http-method"))?.body).toMatchObject({
      pullRequestThreadContext: {
        changeTrackingId: 0,
        iterationContext: { secondComparingIteration: 0 },
      },
    });
  });

  it("lists remote threads before each write and skips exact duplicates", async () => {
    const review = reviewWithFindings();
    const { calls, runner } = publicationRunner([
      {
        value: [{
          id: 31,
          comments: [{ content: "**First finding**\n\nFirst body" }],
          threadContext: {
            filePath: "/src/example.ts",
            rightFileStart: { line: 2 },
            rightFileEnd: { line: 2 },
          },
        }],
      },
      { value: [] },
    ]);

    const results = await publishReviewFindings(review, { kind: "all_open" }, runner);

    expect(results).toEqual([
      { kind: "duplicate", findingId: review.threads[0]?.id, remoteThreadId: 31 },
      { kind: "published", findingId: review.threads[1]?.id, remoteThreadId: 100 },
    ]);
    expect(calls.filter((call) => call.args.includes("pullRequestThreads") && !call.args.includes("--http-method")))
      .toHaveLength(2);
    const created = calls.find((call) => call.args.includes("--http-method"));
    expect(created?.body).toMatchObject({
      threadContext: {
        filePath: "/src/example.ts",
        leftFileStart: { line: 3, offset: 1 },
        leftFileEnd: { line: 3, offset: 1 },
      },
      pullRequestThreadContext: {
        changeTrackingId: 17,
        iterationContext: { firstComparingIteration: 1, secondComparingIteration: 3 },
      },
    });
  });

  it("continues after one Azure create fails and uses right-side anchors", async () => {
    const review = reviewWithFindings();
    const { calls, runner } = publicationRunner(
      [{ value: [] }, { value: [] }],
      (call) => call === 0 ? new Error("Azure rejected the finding") : { id: 77 },
    );
    const results = await publishReviewFindings(
      review,
      { kind: "finding_ids", findingIds: review.threads.map((thread) => thread.id) },
      runner,
    );

    expect(results.map((result) => result.kind)).toEqual(["failed", "published"]);
    expect(calls.filter((call) => call.args.includes("--http-method"))).toHaveLength(2);
    expect(calls.find((call) => call.args.includes("--http-method"))?.body).toMatchObject({
      threadContext: {
        rightFileStart: { line: 2, offset: 1 },
        rightFileEnd: { line: 2, offset: 1 },
      },
    });
  });

  it("does not treat a different first comment as a duplicate", async () => {
    const review = reviewWithFindings();
    const { calls, runner } = publicationRunner([{
      value: [{
        id: 31,
        comments: [{ content: "**Different finding**\n\nFirst body" }],
        threadContext: {
          filePath: "/src/example.ts",
          rightFileStart: { line: 2 },
          rightFileEnd: { line: 2 },
        },
      }],
    }]);

    const [result] = await publishReviewFindings(
      review,
      { kind: "finding_ids", findingIds: [review.threads[0]!.id] },
      runner,
    );

    expect(result?.kind).toBe("published");
    expect(calls.filter((call) => call.args.includes("--http-method"))).toHaveLength(1);
  });

  it("does not collapse meaningful whitespace when matching legacy comments", async () => {
    const review = reviewWithFindings();
    const { calls, runner } = publicationRunner([{
      value: [{
        id: 31,
        comments: [{ content: "**First  finding**\n\nFirst body" }],
        threadContext: {
          filePath: "/src/example.ts",
          rightFileStart: { line: 2 },
          rightFileEnd: { line: 2 },
        },
      }],
    }]);

    const [result] = await publishReviewFindings(
      review,
      { kind: "finding_ids", findingIds: [review.threads[0]!.id] },
      runner,
    );

    expect(result?.kind).toBe("published");
    expect(calls.filter((call) => call.args.includes("--http-method"))).toHaveLength(1);
  });

  it("serializes concurrent publication for the same pull request", async () => {
    const review = reviewWithFindings();
    const finding = review.threads[0]!;
    const remote: unknown[] = [];
    let creates = 0;
    const runner: AzureCliRunner = {
      async json(args, body) {
        if (args.includes("show")) return { repository: { id: "repo-id" } };
        if (!args.includes("--http-method")) return { value: remote };
        creates++;
        const payload = body as {
          comments: Array<{ content: string }>;
          threadContext: unknown;
        };
        remote.push({
          id: 44,
          comments: payload.comments,
          threadContext: payload.threadContext,
        });
        return { id: 44 };
      },
      async file() {
        throw new Error("Publication does not read file content");
      },
    };

    const selection = { kind: "finding_ids" as const, findingIds: [finding.id] };
    const [first, second] = await Promise.all([
      publishReviewFindings(review, selection, runner),
      publishReviewFindings(review, selection, runner),
    ]);

    expect(creates).toBe(1);
    expect([first[0]?.kind, second[0]?.kind]).toEqual(["published", "duplicate"]);
  });
});
