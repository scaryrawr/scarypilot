import type {
  FileTreeModel,
  FileTreeNodeId,
  VisibleFileTreeRow,
} from "./file-tree-model.ts";

export interface FileTreeKeyAction {
  focusedId: FileTreeNodeId | null;
  toggleFolderId?: FileTreeNodeId;
  activatePath?: string;
}

export function handleFileTreeKey(
  key: string,
  focusedId: FileTreeNodeId | null,
  rows: readonly VisibleFileTreeRow[],
  model: FileTreeModel,
): FileTreeKeyAction {
  if (rows.length === 0) return { focusedId: null };
  const currentIndex = Math.max(0, rows.findIndex((row) => row.id === focusedId));
  const current = rows[currentIndex] ?? rows[0];

  if (key === "ArrowDown") return { focusedId: rows[Math.min(currentIndex + 1, rows.length - 1)].id };
  if (key === "ArrowUp") return { focusedId: rows[Math.max(currentIndex - 1, 0)].id };
  if (key === "Home") return { focusedId: rows[0].id };
  if (key === "End") return { focusedId: rows[rows.length - 1].id };

  if (key === "ArrowRight" && current.node.kind === "folder") {
    if (!current.expanded) return { focusedId: current.id, toggleFolderId: current.id };
    const child = rows[currentIndex + 1];
    return {
      focusedId: child?.node.parentId === current.id ? child.id : current.id,
    };
  }

  if (key === "ArrowLeft") {
    if (current.node.kind === "folder" && current.expanded) {
      return { focusedId: current.id, toggleFolderId: current.id };
    }
    return {
      focusedId: current.node.parentId && model.nodesById.has(current.node.parentId)
        ? current.node.parentId
        : current.id,
    };
  }

  if (key === "Enter" || key === " ") {
    return current.node.kind === "folder"
      ? { focusedId: current.id, toggleFolderId: current.id }
      : { focusedId: current.id, activatePath: current.node.fullPath };
  }

  return { focusedId: current.id };
}
