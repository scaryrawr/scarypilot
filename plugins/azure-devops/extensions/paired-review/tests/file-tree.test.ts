import { describe, expect, it } from "vitest";
import type { ReviewFile, ReviewThread } from "../src/review-schema.ts";
import { handleFileTreeKey } from "../src/client/file-tree-interaction.ts";
import {
  buildFileTree,
  projectFileTree,
  type FileTreeNodeId,
} from "../src/client/file-tree-model.ts";

const files: ReviewFile[] = [
  { path: "README.md", diff: "", additions: 1, deletions: 0 },
  { path: "src/client/main.tsx", diff: "", additions: 4, deletions: 2 },
  { path: "src/server.ts", diff: "", additions: 2, deletions: 1 },
];

const threads: ReviewThread[] = [
  {
    id: "thread-1",
    path: "src/client/main.tsx",
    side: "additions",
    lineStart: 1,
    lineEnd: 1,
    pending: false,
    collapsed: false,
    resolved: false,
    messages: [],
  },
  {
    id: "thread-2",
    path: "src/server.ts",
    side: "additions",
    lineStart: 1,
    lineEnd: 1,
    pending: false,
    collapsed: false,
    resolved: true,
    messages: [],
  },
];

describe("file tree model", () => {
  it("builds folders first and aggregates descendant summaries", () => {
    const model = buildFileTree(files, threads);
    expect(model.rootIds).toEqual(["folder:src", "file:README.md"]);
    expect(model.nodesById.get("folder:src")).toMatchObject({
      kind: "folder",
      summary: {
        additions: 6,
        deletions: 3,
        fileCount: 2,
        openThreads: 1,
        resolvedThreads: 1,
      },
    });
  });

  it("filters by full path and retains expanded ancestors", () => {
    const model = buildFileTree(files, threads);
    const rows = projectFileTree(model, new Set(), "client/main", null);
    expect(rows.map((row) => row.id)).toEqual([
      "folder:src",
      "folder:src/client",
      "file:src/client/main.tsx",
    ]);
    expect(rows[0].expanded).toBe(true);
    expect(rows[2].matchesFilter).toBe(true);
  });

  it("marks a collapsed ancestor that contains the active file", () => {
    const model = buildFileTree(files, threads);
    const rows = projectFileTree(model, new Set(), "", "src/client/main.tsx");
    expect(rows[0]).toMatchObject({
      id: "folder:src",
      expanded: false,
      containsSelectedFile: true,
    });
  });
});

describe("file tree keyboard interaction", () => {
  it("opens folders, moves to children, and activates only files", () => {
    const model = buildFileTree(files, threads);
    const srcId = "folder:src" as FileTreeNodeId;
    const closedRows = projectFileTree(model, new Set(), "", null);
    expect(handleFileTreeKey("Enter", srcId, closedRows, model)).toEqual({
      focusedId: srcId,
      toggleFolderId: srcId,
    });

    const openRows = projectFileTree(model, new Set([srcId]), "", null);
    expect(handleFileTreeKey("ArrowRight", srcId, openRows, model).focusedId)
      .toBe("folder:src/client");

    const readmeId = "file:README.md" as FileTreeNodeId;
    expect(handleFileTreeKey("Enter", readmeId, openRows, model)).toEqual({
      focusedId: readmeId,
      activatePath: "README.md",
    });
  });
});
