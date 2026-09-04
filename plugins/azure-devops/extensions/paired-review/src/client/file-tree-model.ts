import type { ReviewFile, ReviewThread } from "../review-schema.ts";

export type FileTreeNodeId = `folder:${string}` | `file:${string}`;

export interface ChangeSummary {
  additions: number;
  deletions: number;
  fileCount: number;
  openThreads: number;
  resolvedThreads: number;
}

interface BaseTreeNode {
  id: FileTreeNodeId;
  name: string;
  fullPath: string;
  parentId: FileTreeNodeId | null;
  summary: ChangeSummary;
}

export interface FolderTreeNode extends BaseTreeNode {
  kind: "folder";
  children: readonly FileTreeNodeId[];
}

export interface FileTreeFileNode extends BaseTreeNode {
  kind: "file";
  file: ReviewFile;
}

export type FileTreeNode = FolderTreeNode | FileTreeFileNode;

export interface FileTreeModel {
  rootIds: readonly FileTreeNodeId[];
  nodesById: ReadonlyMap<FileTreeNodeId, FileTreeNode>;
  fileIdByPath: ReadonlyMap<string, FileTreeNodeId>;
  folderIds: ReadonlySet<FileTreeNodeId>;
}

export interface VisibleFileTreeRow {
  id: FileTreeNodeId;
  node: FileTreeNode;
  depth: number;
  positionInSet: number;
  setSize: number;
  expanded?: boolean;
  selected: boolean;
  containsSelectedFile: boolean;
  matchesFilter: boolean;
}

interface MutableFolderTreeNode extends Omit<FolderTreeNode, "children"> {
  children: FileTreeNodeId[];
}

type MutableTreeNode = MutableFolderTreeNode | FileTreeFileNode;

const pathCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

export function buildFileTree(
  files: readonly ReviewFile[],
  threads: readonly ReviewThread[],
): FileTreeModel {
  const threadSummaries = new Map<string, Pick<ChangeSummary, "openThreads" | "resolvedThreads">>();
  for (const thread of threads) {
    const summary = threadSummaries.get(thread.anchor.path) ?? { openThreads: 0, resolvedThreads: 0 };
    if (thread.resolved) summary.resolvedThreads++;
    else summary.openThreads++;
    threadSummaries.set(thread.anchor.path, summary);
  }

  const nodesById = new Map<FileTreeNodeId, MutableTreeNode>();
  const fileIdByPath = new Map<string, FileTreeNodeId>();
  const folderIds = new Set<FileTreeNodeId>();
  const rootIds: FileTreeNodeId[] = [];

  for (const file of files) {
    if (fileIdByPath.has(file.path)) {
      throw new Error(`Duplicate review file path: ${file.path}`);
    }

    const segments = file.path.split("/").filter(Boolean);
    const fileName = segments.pop() ?? file.path;
    let parentId: FileTreeNodeId | null = null;
    let folderPath = "";

    for (const segment of segments) {
      folderPath = folderPath ? `${folderPath}/${segment}` : segment;
      const folderId = `folder:${folderPath}` as const;
      if (!nodesById.has(folderId)) {
        const folder: MutableFolderTreeNode = {
          kind: "folder",
          id: folderId,
          name: segment,
          fullPath: folderPath,
          parentId,
          children: [],
          summary: emptySummary(),
        };
        nodesById.set(folderId, folder);
        folderIds.add(folderId);
        appendChild(nodesById, rootIds, parentId, folderId);
      }
      parentId = folderId;
    }

    const fileId = `file:${file.path}` as const;
    const threadSummary = threadSummaries.get(file.path);
    const fileNode: FileTreeFileNode = {
      kind: "file",
      id: fileId,
      name: fileName,
      fullPath: file.path,
      parentId,
      file,
      summary: {
        additions: file.additions ?? 0,
        deletions: file.deletions ?? 0,
        fileCount: 1,
        openThreads: threadSummary?.openThreads ?? 0,
        resolvedThreads: threadSummary?.resolvedThreads ?? 0,
      },
    };
    nodesById.set(fileId, fileNode);
    fileIdByPath.set(file.path, fileId);
    appendChild(nodesById, rootIds, parentId, fileId);
  }

  sortSiblings(nodesById, rootIds);
  for (const rootId of rootIds) aggregateSummary(nodesById, rootId);

  return { rootIds, nodesById, fileIdByPath, folderIds };
}

export function projectFileTree(
  model: FileTreeModel,
  expandedIds: ReadonlySet<FileTreeNodeId>,
  query: string,
  activePath: string | null,
): readonly VisibleFileTreeRow[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const retainedIds = normalizedQuery ? matchingNodeIds(model, normalizedQuery) : null;
  const selectedId = activePath ? model.fileIdByPath.get(activePath) : undefined;
  const selectedAncestors = new Set(selectedId ? ancestorIds(model, selectedId) : []);
  const rows: VisibleFileTreeRow[] = [];

  const visit = (ids: readonly FileTreeNodeId[], depth: number) => {
    const visibleIds = retainedIds ? ids.filter((id) => retainedIds.has(id)) : ids;
    visibleIds.forEach((id, index) => {
      const node = model.nodesById.get(id);
      if (!node) return;
      const expanded = node.kind === "folder"
        ? Boolean(normalizedQuery) || expandedIds.has(node.id)
        : undefined;
      rows.push({
        id,
        node,
        depth,
        positionInSet: index + 1,
        setSize: visibleIds.length,
        expanded,
        selected: id === selectedId,
        containsSelectedFile: node.kind === "folder" && selectedAncestors.has(id),
        matchesFilter: node.kind === "file" &&
          Boolean(normalizedQuery) &&
          node.fullPath.toLocaleLowerCase().includes(normalizedQuery),
      });
      if (node.kind === "folder" && expanded) visit(node.children, depth + 1);
    });
  };

  visit(model.rootIds, 1);
  return rows;
}

export function ancestorIds(
  model: FileTreeModel,
  id: FileTreeNodeId,
): readonly FileTreeNodeId[] {
  const ancestors: FileTreeNodeId[] = [];
  let parentId = model.nodesById.get(id)?.parentId ?? null;
  while (parentId) {
    ancestors.unshift(parentId);
    parentId = model.nodesById.get(parentId)?.parentId ?? null;
  }
  return ancestors;
}

function appendChild(
  nodesById: Map<FileTreeNodeId, MutableTreeNode>,
  rootIds: FileTreeNodeId[],
  parentId: FileTreeNodeId | null,
  childId: FileTreeNodeId,
) {
  if (!parentId) {
    rootIds.push(childId);
    return;
  }
  const parent = nodesById.get(parentId);
  if (!parent || parent.kind !== "folder") {
    throw new Error(`Missing parent folder: ${parentId}`);
  }
  parent.children.push(childId);
}

function sortSiblings(
  nodesById: Map<FileTreeNodeId, MutableTreeNode>,
  ids: FileTreeNodeId[],
) {
  ids.sort((leftId, rightId) => {
    const left = nodesById.get(leftId)!;
    const right = nodesById.get(rightId)!;
    if (left.kind !== right.kind) return left.kind === "folder" ? -1 : 1;
    return pathCollator.compare(left.name, right.name) || left.name.localeCompare(right.name);
  });
  for (const id of ids) {
    const node = nodesById.get(id);
    if (node?.kind === "folder") sortSiblings(nodesById, node.children);
  }
}

function aggregateSummary(
  nodesById: Map<FileTreeNodeId, MutableTreeNode>,
  id: FileTreeNodeId,
): ChangeSummary {
  const node = nodesById.get(id)!;
  if (node.kind === "file") return node.summary;
  node.summary = node.children.reduce((total, childId) => {
    const child = aggregateSummary(nodesById, childId);
    total.additions += child.additions;
    total.deletions += child.deletions;
    total.fileCount += child.fileCount;
    total.openThreads += child.openThreads;
    total.resolvedThreads += child.resolvedThreads;
    return total;
  }, emptySummary());
  return node.summary;
}

function matchingNodeIds(
  model: FileTreeModel,
  normalizedQuery: string,
): ReadonlySet<FileTreeNodeId> {
  const retained = new Set<FileTreeNodeId>();
  for (const [path, fileId] of model.fileIdByPath) {
    if (!path.toLocaleLowerCase().includes(normalizedQuery)) continue;
    retained.add(fileId);
    for (const ancestorId of ancestorIds(model, fileId)) retained.add(ancestorId);
  }
  return retained;
}

function emptySummary(): ChangeSummary {
  return {
    additions: 0,
    deletions: 0,
    fileCount: 0,
    openThreads: 0,
    resolvedThreads: 0,
  };
}
