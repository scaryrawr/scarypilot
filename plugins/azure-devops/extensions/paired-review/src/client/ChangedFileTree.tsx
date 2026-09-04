import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import type { ReviewFile, ReviewThread } from "../review-schema.ts";
import { handleFileTreeKey } from "./file-tree-interaction.ts";
import {
  ancestorIds,
  buildFileTree,
  projectFileTree,
  type FileTreeNode,
  type FileTreeNodeId,
} from "./file-tree-model.ts";

interface ChangedFileTreeProps {
  activePath: string | null;
  files: readonly ReviewFile[];
  threads: readonly ReviewThread[];
  onActivate: (file: ReviewFile) => void;
}

const DEFAULT_SIDEBAR_RATIO = 0.24;
const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 720;
const SIDEBAR_WIDTH_STORAGE_KEY = "azure-devops-paired-review:file-tree-width";

export function ChangedFileTree({
  activePath,
  files,
  threads,
  onActivate,
}: ChangedFileTreeProps) {
  const model = useMemo(() => buildFileTree(files, threads), [files, threads]);
  const [query, setQuery] = useState("");
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<FileTreeNodeId>>(
    () => initialExpandedIds(model, activePath),
  );
  const [focusedId, setFocusedId] = useState<FileTreeNodeId | null>(
    () => activePath ? model.fileIdByPath.get(activePath) ?? null : model.rootIds[0] ?? null,
  );
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const resizeStart = useRef({ pointerX: 0, width: 0 });
  const lastActivePath = useRef(activePath);
  const treeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setExpandedIds((current) => {
      const next = new Set([...current].filter((id) => model.folderIds.has(id)));
      if (activePath !== lastActivePath.current) {
        const activeId = model.fileIdByPath.get(activePath ?? "");
        if (activeId) {
          for (const id of ancestorIds(model, activeId)) next.add(id);
        }
      }
      return next;
    });
    lastActivePath.current = activePath;
  }, [activePath, model]);

  const rows = useMemo(
    () => projectFileTree(model, expandedIds, query, activePath),
    [activePath, expandedIds, model, query],
  );

  useEffect(() => {
    if (rows.some((row) => row.id === focusedId)) return;
    const activeId = activePath ? model.fileIdByPath.get(activePath) : undefined;
    setFocusedId(
      rows.find((row) => row.id === activeId)?.id ??
      rows.find((row) => row.containsSelectedFile)?.id ??
      rows[0]?.id ??
      null,
    );
  }, [activePath, focusedId, model.fileIdByPath, rows]);

  useEffect(() => {
    if (!focusedId) return;
    document.getElementById(rowDomId(focusedId))?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }, [focusedId]);

  useEffect(() => {
    const clampWidth = () => setSidebarWidth((width) => constrainSidebarWidth(width));
    window.addEventListener("resize", clampWidth);
    return () => window.removeEventListener("resize", clampWidth);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  const matchedFiles = query.trim()
    ? rows.filter((row) => row.node.kind === "file" && row.matchesFilter).length
    : files.length;

  function toggleFolder(id: FileTreeNodeId) {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function activateNode(node: FileTreeNode) {
    setFocusedId(node.id);
    if (node.kind === "folder") {
      toggleFolder(node.id);
      return;
    }
    onActivate(node.file);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const action = handleFileTreeKey(event.key, focusedId, rows, model);
    if (action.focusedId === focusedId &&
        !action.toggleFolderId &&
        !action.activatePath &&
        !isTreeNavigationKey(event.key)) {
      return;
    }
    event.preventDefault();
    setFocusedId(action.focusedId);
    if (action.toggleFolderId) toggleFolder(action.toggleFolderId);
    if (action.activatePath) {
      const fileId = model.fileIdByPath.get(action.activatePath);
      const node = fileId ? model.nodesById.get(fileId) : undefined;
      if (node?.kind === "file") onActivate(node.file);
    }
  }

  function handleResizeStart(event: PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeStart.current = { pointerX: event.clientX, width: sidebarWidth };
    setResizing(true);
  }

  function handleResizeMove(event: PointerEvent<HTMLDivElement>) {
    if (!resizing) return;
    const distanceLeft = resizeStart.current.pointerX - event.clientX;
    setSidebarWidth(constrainSidebarWidth(resizeStart.current.width + distanceLeft));
  }

  function handleResizeEnd(event: PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setResizing(false);
  }

  function handleResizeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    let nextWidth: number | undefined;
    if (event.key === "ArrowLeft") nextWidth = sidebarWidth + 16;
    if (event.key === "ArrowRight") nextWidth = sidebarWidth - 16;
    if (event.key === "Home") nextWidth = MIN_SIDEBAR_WIDTH;
    if (event.key === "End") nextWidth = maxSidebarWidth();
    if (nextWidth === undefined) return;
    event.preventDefault();
    setSidebarWidth(constrainSidebarWidth(nextWidth));
  }

  return (
    <aside
      className={`file-tree-sidebar${resizing ? " resizing" : ""}`}
      style={{ width: sidebarWidth }}
    >
      <div
        aria-label="Resize changed files panel"
        aria-orientation="vertical"
        aria-valuemax={maxSidebarWidth()}
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuenow={sidebarWidth}
        className="file-tree-resizer"
        onDoubleClick={() => setSidebarWidth(defaultSidebarWidth())}
        onKeyDown={handleResizeKeyDown}
        onPointerCancel={handleResizeEnd}
        onPointerDown={handleResizeStart}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
        role="separator"
        tabIndex={0}
        title="Drag to resize; double-click to reset"
      />
      <div className="sidebar-heading">
        <h2>Files</h2>
        <span>{files.length}</span>
      </div>
      <div className="file-tree-filter">
        <label className="sr-only" htmlFor="file-tree-filter">Filter changed files</label>
        <span aria-hidden="true" className="search-icon" />
        <input
          id="file-tree-filter"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) {
              event.preventDefault();
              setQuery("");
            } else if (event.key === "ArrowDown" && rows[0]) {
              event.preventDefault();
              setFocusedId(rows[0].id);
              treeRef.current?.focus();
            }
          }}
          placeholder="Filter files..."
          type="search"
          value={query}
        />
      </div>
      <span className="sr-only" role="status">
        {query.trim() ? `${matchedFiles} matching files` : `${files.length} changed files`}
      </span>
      {rows.length ? (
        <div
          aria-activedescendant={focusedId ? rowDomId(focusedId) : undefined}
          aria-label="Changed files"
          className="file-tree"
          onKeyDown={handleKeyDown}
          ref={treeRef}
          role="tree"
          tabIndex={0}
        >
          {rows.map((row) => (
            <div
              aria-expanded={row.expanded}
              aria-label={`${row.node.fullPath}; ${accessibleSummary(row.node)}`}
              aria-level={row.depth}
              aria-posinset={row.positionInSet}
              aria-selected={row.node.kind === "file" ? row.selected : undefined}
              aria-setsize={row.setSize}
              className={[
                "file-tree-row",
                row.selected ? "active" : "",
                row.id === focusedId ? "focused" : "",
                row.containsSelectedFile ? "contains-active" : "",
              ].filter(Boolean).join(" ")}
              id={rowDomId(row.id)}
              key={row.id}
              onClick={() => activateNode(row.node)}
              role="treeitem"
              style={{ "--tree-depth": row.depth - 1 } as CSSProperties}
              title={row.node.fullPath}
            >
              {row.node.kind === "folder" ? (
                <span
                  aria-hidden="true"
                  className={`tree-chevron${row.expanded ? " expanded" : ""}`}
                />
              ) : <span aria-hidden="true" className="tree-chevron-spacer" />}
              <span aria-hidden="true" className={`tree-icon ${row.node.kind}`} />
              <span className="tree-label">{row.node.name}</span>
              <span className="tree-summary">{compactSummary(row.node)}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="file-tree-empty">No changed files match your filter.</p>
      )}
    </aside>
  );
}

function initialExpandedIds(
  model: ReturnType<typeof buildFileTree>,
  activePath: string | null,
): ReadonlySet<FileTreeNodeId> {
  const expanded = new Set(
    model.rootIds.filter((id) => model.nodesById.get(id)?.kind === "folder"),
  );
  const activeId = activePath ? model.fileIdByPath.get(activePath) : undefined;
  if (activeId) {
    for (const id of ancestorIds(model, activeId)) expanded.add(id);
  }
  return expanded;
}

function compactSummary(node: FileTreeNode): string {
  if (node.kind === "folder") {
    return node.summary.openThreads
      ? `${node.summary.fileCount} · ${node.summary.openThreads} open`
      : `${node.summary.fileCount}`;
  }
  if (node.summary.openThreads) return `${node.summary.openThreads} open`;
  if (node.summary.resolvedThreads) return `${node.summary.resolvedThreads} resolved`;
  return `+${node.summary.additions} −${node.summary.deletions}`;
}

function accessibleSummary(node: FileTreeNode): string {
  const summary = node.summary;
  const fileCount = node.kind === "folder" ? `${summary.fileCount} files; ` : "";
  return `${fileCount}${summary.additions} additions; ${summary.deletions} deletions; ` +
    `${summary.openThreads} open threads; ${summary.resolvedThreads} resolved threads`;
}

function rowDomId(id: FileTreeNodeId): string {
  return `file-tree-${encodeURIComponent(id)}`;
}

function isTreeNavigationKey(key: string): boolean {
  return [
    "ArrowDown",
    "ArrowUp",
    "ArrowLeft",
    "ArrowRight",
    "Home",
    "End",
    "Enter",
    " ",
  ].includes(key);
}

function initialSidebarWidth(): number {
  const storedWidth = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
  return constrainSidebarWidth(
    Number.isFinite(storedWidth) && storedWidth > 0 ? storedWidth : defaultSidebarWidth(),
  );
}

function defaultSidebarWidth(): number {
  return constrainSidebarWidth(Math.round(window.innerWidth * DEFAULT_SIDEBAR_RATIO));
}

function constrainSidebarWidth(width: number): number {
  return Math.min(Math.max(Math.round(width), MIN_SIDEBAR_WIDTH), maxSidebarWidth());
}

function maxSidebarWidth(): number {
  return Math.max(
    MIN_SIDEBAR_WIDTH,
    Math.min(MAX_SIDEBAR_WIDTH, Math.round(window.innerWidth * 0.6)),
  );
}
