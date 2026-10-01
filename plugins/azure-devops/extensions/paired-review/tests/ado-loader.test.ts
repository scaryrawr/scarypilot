import { describe, expect, it } from "vitest";
import {
  createAzureBridgeRunner,
  loadAzurePullRequest,
  publishReviewFindings,
  type AzureCliRunner,
  type JsonValue,
} from "../src/ado-loader.ts";
import type { BridgeRequest } from "../src/ado-bridge.ts";
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
      async json(args): Promise<JsonValue> {
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

        if (args.includes("pullRequestThreads")) {
          return {
            value: [{
              id: 7,
              status: 1,
              threadContext: {
                filePath: "/src/greeting.ts",
                rightFileStart: { line: 1 },
                rightFileEnd: { line: 1 },
              },
              comments: [{
                id: 11,
                content: "Please keep this export stable.",
                author: { displayName: "Ada Lovelace" },
                publishedDate: "2026-01-01T00:00:00.000Z",
              }, {
                id: 12,
                content: "**Finding**\n\nInvestigate this.\n\n- Generated with AI 🤖\n\n<!-- paired-review-finding:fixture -->",
                author: { displayName: "Copilot" },
                publishedDate: "2026-01-01T00:01:00.000Z",
              }],
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
      status: "Loaded 1 changed file; loaded 1 inline Azure DevOps thread",
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
    expect(loaded.threads).toEqual([{
      kind: "remote",
      id: "remote-7",
      remoteThreadId: 7,
      anchor: {
        path: "src/greeting.ts",
        side: "additions",
        lineStart: 1,
        lineEnd: 1,
      },
      pending: false,
      fixing: false,
      collapsed: false,
      resolved: false,
      messages: [{
        id: "remote-7-11",
        role: "reviewer",
        author: "Ada Lovelace",
        body: "Please keep this export stable.",
        createdAt: "2026-01-01T00:00:00.000Z",
      }, {
        id: "remote-7-12",
        role: "reviewer",
        author: "Copilot",
        body: "**Finding**\n\nInvestigate this.\n\n- Generated with AI 🤖",
        createdAt: "2026-01-01T00:01:00.000Z",
      }],
    }]);
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
  }, { kind: "review_pass", passId: "pass-1" });

  return insertReviewFinding(first.review, {
    path: "src/example.ts",
    side: "deletions",
    lineStart: 3,
    lineEnd: 3,
    severity: "blocking",
    title: "Second finding",
    body: "Second body",
  }, { kind: "review_pass", passId: "pass-1" }).review;
}

function publicationRunner(
  listResponses: JsonValue[],
  create: (call: number) => JsonValue | Error = (call) => ({ id: 100 + call }),
  iterationId = 3,
) {
  const calls: Array<{ args: string[]; body: Parameters<AzureCliRunner["json"]>[1] }> = [];
  let listIndex = 0;
  let createIndex = 0;

  const runner: AzureCliRunner = {
    async json(args, body): Promise<JsonValue> {
      calls.push({ args, body });

      if (args.includes("show")) return { repository: { id: "repo-id" } };

      if (args.includes("pullRequestIterations")) return { value: [{ id: iterationId }] };

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
    const { calls, runner } = publicationRunner([{ value: [] }], undefined, 0);

    const [result] = await publishReviewFindings(
      review,
      { kind: "finding_ids", findingIds: [review.threads[0]!.id] },
      runner,
    );

    expect(result?.kind).toBe("published");
    expect(calls.find((call) => call.args.includes("--http-method"))?.body).toMatchObject({
      comments: [{
        content: expect.stringMatching(
          /^\*\*First finding\*\*\n\nFirst body\n\n- Generated with AI 🤖\n\n<!-- paired-review-finding:[a-z0-9-]+ -->$/,
        ),
      }],
      pullRequestThreadContext: {
        changeTrackingId: 0,
        iterationContext: { secondComparingIteration: 0 },
      },
    });
  });

  it("does not duplicate the attribution when a finding body already includes it", async () => {
    const review = reviewWithFindings();
    const finding = review.threads[0]!;

    if (finding.kind !== "finding") throw new Error("Expected a finding");

    finding.finding.body = "First body\n\n- Generated with AI 🤖";
    const { calls, runner } = publicationRunner([{ value: [] }]);

    await publishReviewFindings(review, { kind: "finding_ids", findingIds: [finding.id] }, runner);

    const created = calls.find((call) => call.args.includes("--http-method"));
    expect(created?.body).toMatchObject({
      comments: [{
        content: expect.stringMatching(
          /^\*\*First finding\*\*\n\nFirst body\n\n- Generated with AI 🤖\n\n<!-- paired-review-finding:[a-z0-9-]+ -->$/,
        ),
      }],
    });
  });

  it.each([
    ["suffix-only", "- Generated with AI 🤖", "**First finding**\n\n- Generated with AI 🤖"],
    ["CRLF", "First body\r\n\r\n- Generated with AI 🤖", "**First finding**\n\nFirst body\n\n- Generated with AI 🤖"],
  ])("attributes %s finding bodies once", async (_case, body, expected) => {
    const review = reviewWithFindings();
    const finding = review.threads[0]!;

    if (finding.kind !== "finding") throw new Error("Expected a finding");

    finding.finding.body = body;
    const { calls, runner } = publicationRunner([{ value: [] }]);

    await publishReviewFindings(review, { kind: "finding_ids", findingIds: [finding.id] }, runner);

    expect(calls.find((call) => call.args.includes("--http-method"))?.body).toMatchObject({
      comments: [{ content: `${expected}\n\n<!-- paired-review-finding:${finding.finding.id} -->` }],
    });
  });

  it("matches previously published findings with the legacy attribution", async () => {
    const review = reviewWithFindings();

    const { calls, runner } = publicationRunner([{
      value: [{
        id: 31,
        comments: [{ content: "**First finding**\n\nFirst body\n\n🤖 Generated with AI" }],
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

    expect(result).toMatchObject({ kind: "duplicate", remoteThreadId: 31 });
    expect(calls.filter((call) => call.args.includes("--http-method"))).toHaveLength(0);
  });

  it("lists remote threads once per pass and skips exact duplicates", async () => {
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
      .toHaveLength(1);
    expect(calls).toHaveLength(4);
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
    const remote: JsonValue[] = [];
    let creates = 0;

    const runner: AzureCliRunner = {
      async json(args, body): Promise<JsonValue> {
        if (args.includes("show")) return { repository: { id: "repo-id" } };

        if (args.includes("pullRequestIterations")) return { value: [{ id: 3 }] };

        if (!args.includes("--http-method")) return { value: remote };
        creates++;

        if (!body) throw new Error("Expected a thread creation payload.");

        remote.push({
          id: 44,
          comments: body.comments,
          threadContext: body.threadContext,
        });

        return { id: 44 };
      },
      async file() {
        throw new Error("Publication does not read file content");
      },
    };

    const selection = { kind: "finding_ids" as const, findingIds: [finding.id] };
    const aliasReview = { ...review, prUrl: "https://EXAMPLE.visualstudio.com/project/_git/repository-alias/pullrequest/42/?view=files" };

    const [first, second] = await Promise.all([
      publishReviewFindings(aliasReview, selection, runner),
      publishReviewFindings(review, selection, runner),
    ]);

    expect(creates).toBe(1);
    expect([first[0]?.kind, second[0]?.kind]).toEqual(["published", "duplicate"]);
  });

  it("rejects findings from a stale iteration before reading threads or writing", async () => {
    const review = reviewWithFindings(17, 2);
    const { calls, runner } = publicationRunner([{ value: [] }]);
    const results = await publishReviewFindings(review, { kind: "all_open" }, runner);
    expect(results).toEqual(review.threads.map((thread) => ({
      kind: "failed", findingId: thread.id,
      error: "The pull request iteration changed or could not be verified. Reload the review before publishing.",
    })));
    expect(calls).toHaveLength(2);
    expect(calls.some((call) => call.args.includes("pullRequestThreads"))).toBe(false);
  });

  it("updates the duplicate index after a confirmed create", async () => {
    const review = reviewWithFindings();
    const first = review.threads[0]!;

    if (first.kind !== "finding") throw new Error("Expected finding");
    const second = { ...first, id: "alias-finding", finding: { ...first.finding, id: "alias-finding" } };
    const duplicateReview = { ...review, threads: [first, second] };
    const { calls, runner } = publicationRunner([{ value: [] }]);
    const results = await publishReviewFindings(duplicateReview, { kind: "all_open" }, runner);
    expect(results.map((result) => result.kind)).toEqual(["published", "duplicate"]);
    expect(calls.filter((call) => call.args.includes("--http-method"))).toHaveLength(1);
  });

  it("uses one complete thread read for many findings", async () => {
    let review = reviewWithFindings();

    for (let index = 0; index < 25; index++) {
      review = insertReviewFinding(review, {
        path: "src/example.ts", side: "additions", lineStart: 2, lineEnd: 2,
        severity: "warning", title: `Finding ${index}`, body: `Body ${index}`,
      }, { kind: "chat" }).review;
    }

    const last = review.threads.at(-1)!;

    const { calls, runner } = publicationRunner([{ value: [
      { id: 2, comments: [{ content: "unrelated early-page thread" }] },
      { id: 99, comments: [{ content: `<!-- paired-review-finding:${last.id} -->` }] },
    ] }]);

    const results = await publishReviewFindings(review, { kind: "all_open" }, runner);
    expect(results).toHaveLength(27);
    expect(results.at(-1)).toEqual({ kind: "duplicate", findingId: last.id, remoteThreadId: 99 });
    expect(calls.filter((call) => call.args.includes("pullRequestThreads") && !call.args.includes("--http-method"))).toHaveLength(1);
    expect(calls.filter((call) => call.args.includes("--http-method"))).toHaveLength(26);
    expect(calls).toHaveLength(29);
  });

  it("does not replay an uncertain matching POST during the same pass", async () => {
    const review = reviewWithFindings();
    const first = review.threads[0]!;

    if (first.kind !== "finding") throw new Error("Expected finding");
    const second = { ...first, id: "alias-finding", finding: { ...first.finding, id: "alias-finding" } };
    const duplicateReview = { ...review, threads: [first, second] };
    const { calls, runner } = publicationRunner([{ value: [] }], () => ({}));
    const results = await publishReviewFindings(duplicateReview, { kind: "all_open" }, runner);
    expect(results.map((result) => result.kind)).toEqual(["failed", "failed"]);
    expect(results[1]).toMatchObject({ error: expect.stringContaining("uncertain outcome") });
    expect(calls.filter((call) => call.args.includes("--http-method"))).toHaveLength(1);
  });

  it("uses one coordinated production batch and preserves partial failures", async () => {
    const requests: BridgeRequest[] = [];
    const review = reviewWithFindings();

    const runner = createAzureBridgeRunner(async (request): Promise<JsonValue> => {
      requests.push(request);

      if (request.operation === "publish") {
        return { results: [
          { kind: "published", findingId: request.findings[0]!.findingId, remoteThreadId: 77 },
          { kind: "failed", findingId: request.findings[1]!.findingId, error: "uncertain write; check remote" },
        ] };
      }

      if (request.operation === "read" && request.resource === "pullRequest") return { repository: { id: "repo-id" } };

      if (request.operation === "read" && request.resource === "iterations") return { value: [{ id: 3 }] };
      throw new Error("Unexpected bridge operation");
    });

    const results = await publishReviewFindings(review, { kind: "all_open" }, runner);
    expect(results.map((result) => result.kind)).toEqual(["published", "failed"]);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual({
      operation: "publish", org: "https://dev.azure.com/example", project: "project",
      repositoryId: "repo-id", pullRequestId: 42,
      findings: [
        {
          findingId: review.threads[0]!.id,
          payload: {
            comments: [{
              parentCommentId: 0, commentType: 1,
              content: `**First finding**\n\nFirst body\n\n- Generated with AI 🤖\n\n<!-- paired-review-finding:${review.threads[0]!.id} -->`,
            }],
            status: 1,
            threadContext: { filePath: "/src/example.ts", rightFileStart: { line: 2, offset: 1 }, rightFileEnd: { line: 2, offset: 1 } },
            pullRequestThreadContext: { changeTrackingId: 17, iterationContext: { firstComparingIteration: 1, secondComparingIteration: 3 } },
          },
        },
        {
          findingId: review.threads[1]!.id,
          payload: {
            comments: [{
              parentCommentId: 0, commentType: 1,
              content: `**Second finding**\n\nSecond body\n\n- Generated with AI 🤖\n\n<!-- paired-review-finding:${review.threads[1]!.id} -->`,
            }],
            status: 1,
            threadContext: { filePath: "/src/example.ts", leftFileStart: { line: 3, offset: 1 }, leftFileEnd: { line: 3, offset: 1 } },
            pullRequestThreadContext: { changeTrackingId: 17, iterationContext: { firstComparingIteration: 1, secondComparingIteration: 3 } },
          },
        },
      ],
    });
  });

  it("fails closed when a bridge omits a publication result", async () => {
    const review = reviewWithFindings();

    const runner = createAzureBridgeRunner(async (request): Promise<JsonValue> => {
      if (request.operation === "publish") return { results: [] };

      if (request.operation === "read" && request.resource === "iterations") return { value: [{ id: 3 }] };

      return { repository: { id: "repo-id" } };
    });

    const results = await publishReviewFindings(review, { kind: "all_open" }, runner);
    expect(results.map((result) => result.kind)).toEqual(["failed", "failed"]);
    expect(results[0]).toMatchObject({ error: "Azure DevOps bridge returned incomplete publication results." });
  });

  it("delegates production iteration fencing to the coordinated batch without a redundant GET", async () => {
    const review = reviewWithFindings(17, 2);
    const requests: BridgeRequest[] = [];

    const runner = createAzureBridgeRunner(async (request): Promise<JsonValue> => {
      requests.push(request);

      if (request.operation === "publish") {
        return { results: request.findings.map((finding) => ({
          kind: "failed", findingId: finding.findingId, error: "stale pull request iteration",
        })) };
      }

      if (request.operation === "read" && request.resource === "pullRequest") return { repository: { id: "repo-id" } };
      throw new Error("Unexpected redundant production read");
    });

    const results = await publishReviewFindings(review, { kind: "all_open" }, runner);

    expect(results).toEqual(review.threads.map((finding) => ({
      kind: "failed", findingId: finding.id, error: "stale pull request iteration",
    })));
    expect(requests).toHaveLength(2);
  });

  it("preserves meaningful whitespace in production publication payloads", async () => {
    const review = reviewWithFindings();
    const first = review.threads[0]!;

    if (first.kind !== "finding") throw new Error("Expected finding");
    first.finding.body = "const  value = 1;\n\n\nKeep  these spaces.";
    let publishedBody: string | undefined;

    const runner = createAzureBridgeRunner(async (request): Promise<JsonValue> => {
      if (request.operation === "publish") {
        const payload = request.findings[0]!.payload;

        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error("Expected payload");
        const comments = payload.comments;

        if (!Array.isArray(comments)) throw new Error("Expected comments");
        const comment = comments[0];

        if (typeof comment !== "object" || comment === null || Array.isArray(comment) || typeof comment.content !== "string") throw new Error("Expected comment");
        publishedBody = comment.content;

        return { results: [{ kind: "published", findingId: first.id, remoteThreadId: 77 }] };
      }

      if (request.operation === "read" && request.resource === "iterations") return { value: [{ id: 3 }] };

      return { repository: { id: "repo-id" } };
    });

    await publishReviewFindings(review, { kind: "finding_ids", findingIds: [first.id] }, runner);
    expect(publishedBody).toBe(`**First finding**\n\nconst  value = 1;\n\n\nKeep  these spaces.\n\n- Generated with AI 🤖\n\n<!-- paired-review-finding:${first.id} -->`);
  });
});

describe("bridge-backed review loads", () => {
  const prUrl = "https://dev.azure.com/example/project/_git/repo/pullrequest/42";
  const iteration = { id: 3, commonRefCommit: { commitId: "base" }, sourceRefCommit: { commitId: "head" } };

  it("delegates immutable caching across repeated loads without caching mutable reads", async () => {
    const requests: BridgeRequest[] = [];
    const cache = new Map<string, JsonValue>();
    let immutableMisses = 0;

    const runner = createAzureBridgeRunner(async (request): Promise<JsonValue> => {
      requests.push(request);

      if (request.operation !== "read") throw new Error("Expected read");

      switch (request.resource) {
        case "pullRequest": return { repository: { id: "repo-id" } };
        case "iterations": return { value: [iteration] };
        case "changes": return { changeEntries: [{ changeType: "edit", changeTrackingId: 17, item: { path: "/example.ts" } }] };
        case "threads": return { value: [] };
        case "item": {
          const key = `${request.org}/${request.repositoryId}/${request.commit}/${request.path}`;
          let result = cache.get(key);

          if (result === undefined) {
            immutableMisses++;
            result = { content: request.commit === "base" ? "old\n" : "new\n" };
            cache.set(key, result);
          }

          return result;
        }
      }
    });

    const first = await loadAzurePullRequest(prUrl, runner);
    const second = await loadAzurePullRequest(prUrl, runner);
    expect(second.files).toEqual(first.files);
    expect(second.files[0]).toMatchObject({ oldContent: "old\n", newContent: "new\n" });
    expect(immutableMisses).toBe(2);
    expect(requests).toHaveLength(12);
    expect(requests.filter((request) => request.operation === "read" && request.resource === "pullRequest")).toHaveLength(2);
    expect(requests.filter((request) => request.operation === "read" && request.resource === "item")).toHaveLength(4);
  });

  it("reports display omissions after consuming the owner's complete late-page changes", async () => {
    const requests: BridgeRequest[] = [];

    const runner = createAzureBridgeRunner(async (request): Promise<JsonValue> => {
      requests.push(request);

      if (request.operation !== "read") throw new Error("Expected read");

      switch (request.resource) {
        case "pullRequest": return { repository: { id: "repo-id" } };
        case "iterations": return { value: [iteration] };
        case "changes": return { changeEntries: Array.from({ length: 2003 }, (_, index) => ({
          changeType: "add", item: { path: `/file-${index}.ts` }, changeTrackingId: index,
        })) };
        case "item": return { content: "new\n" };
        case "threads": return { value: [{
          id: 90, status: 1, comments: [{ id: 1, content: "Late-page thread" }],
          threadContext: { filePath: "/file-1999.ts", rightFileStart: { line: 1 }, rightFileEnd: { line: 1 } },
        }] };
      }
    });

    const loaded = await loadAzurePullRequest(prUrl, runner);
    expect(loaded.files).toHaveLength(2000);
    expect(loaded.files[1999]?.path).toBe("file-1999.ts");
    expect(loaded.threads[0]?.messages[0]?.body).toBe("Late-page thread");
    expect(loaded.status).toBe("Loaded 2000 changed files; omitted 3 changed files from display (2000 file display limit); loaded 1 inline Azure DevOps thread");
    expect(requests).toHaveLength(2004);
    expect(requests.find((request) => request.operation === "read" && request.resource === "changes")).toEqual({
      operation: "read", resource: "changes", org: "https://dev.azure.com/example",
      project: "project", repositoryId: "repo-id", pullRequestId: 42, iterationId: 3,
    });
  });

  it.each([
    '{"error": "item content exceeds 2 MiB limit"}',
    '{"error": "item content exceeds 2097152 bytes", "code": "content_too_large"}',
  ])("reports oversized content rather than interpreting it as binary for %s", async (errorPayload) => {
    const runner = createAzureBridgeRunner(async (request): Promise<JsonValue> => {
      if (request.operation !== "read") throw new Error("Expected read");

      switch (request.resource) {
        case "pullRequest": return { repository: { id: "repo-id" } };
        case "iterations": return { value: [iteration] };
        case "changes": return { changeEntries: [{ changeType: "add", item: { path: "/large.ts" } }] };
        case "item": throw new Error(`Azure DevOps bridge request failed: ${errorPayload}`);
        case "threads": return { value: [] };
      }
    });

    const loaded = await loadAzurePullRequest(prUrl, runner);
    expect(loaded.files[0]).toEqual({ path: "large.ts", status: "add, content omitted", diff: "Diff content omitted: file exceeds 2 MiB.\n" });
    expect(loaded.status).toContain("omitted content for 1 files");
  });

  it("reports the total content cap and keeps at most four immutable reads in flight", async () => {
    let activeItems = 0;
    let maxActiveItems = 0;
    const content = "a".repeat(2 * 1024 * 1024);

    const runner = createAzureBridgeRunner(async (request): Promise<JsonValue> => {
      if (request.operation !== "read") throw new Error("Expected read");

      switch (request.resource) {
        case "pullRequest": return { repository: { id: "repo-id" } };
        case "iterations": return { value: [iteration] };
        case "changes": return { changeEntries: Array.from({ length: 10 }, (_, index) => ({
          changeType: "edit", item: { path: `/large-${index}.ts` },
        })) };
        case "item":
          activeItems++;
          maxActiveItems = Math.max(maxActiveItems, activeItems);
          await new Promise<void>((resolve) => setImmediate(resolve));
          activeItems--;

          return { content };
        case "threads": return { value: [] };
      }
    });

    const loaded = await loadAzurePullRequest(prUrl, runner);
    expect(maxActiveItems).toBe(4);
    expect(loaded.files.filter((file) => file.oldContent !== undefined)).toHaveLength(8);
    expect(loaded.files.filter((file) => file.diff === "Diff content omitted: total content limit reached.\n")).toHaveLength(2);
    expect(loaded.status).toBe("Loaded 8 changed files; omitted content for 2 files; loaded 0 inline Azure DevOps threads");
  });
});
