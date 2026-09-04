import {
  parsePatchFiles,
  type DiffLineAnnotation,
  type SelectedLineRange,
} from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { Value } from "@sinclair/typebox/value";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { createRoot } from "react-dom/client";
import {
  ReviewStateSchema,
  type ReviewFile,
  type ReviewState,
  type ReviewThread,
} from "../review-schema.ts";
import { ChangedFileTree } from "./ChangedFileTree.tsx";
import "./styles.css";

type HostTheme = "light" | "dark";
type ThreadAnnotation =
  | { kind: "thread"; thread: ReviewThread }
  | { kind: "composer"; range: SelectedLineRange };

const params = new URLSearchParams(window.location.search);
const instanceId = params.get("instance") ?? "";
const token = params.get("token") ?? "";

function api(path: string): string {
  const query = new URLSearchParams({ instance: instanceId, token });
  return `${path}?${query}`;
}

function App() {
  const theme = useHostTheme();
  const [review, setReview] = useState<ReviewState | null>(null);
  const [activePath, setActivePath] = useState("");
  const [selection, setSelection] = useState<SelectedLineRange | null>(null);

  const load = useCallback(async () => {
    const response = await fetch(api("/api/state"), { cache: "no-store" });
    if (!response.ok) return;
    const next = Value.Parse(ReviewStateSchema, await response.json());
    setReview(next);
    setActivePath((current) => current || next.activePath || next.files[0]?.path || "");
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 1000);
    return () => window.clearInterval(timer);
  }, [load]);

  const activeFile = useMemo(
    () => review?.files.find((file) => file.path === activePath) ?? review?.files[0],
    [activePath, review],
  );
  const activeThreads = useMemo(
    () => review?.threads.filter((thread) => thread.path === activeFile?.path) ?? [],
    [activeFile?.path, review?.threads],
  );

  async function focusFile(file: ReviewFile) {
    setActivePath(file.path);
    setSelection(null);
    await fetch(api("/api/focus"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ activePath: file.path }),
    });
  }

  return (
    <div className="review-shell">
      <header className="review-header">
        <div className="review-heading">
          <h1>{review?.title ?? "Azure DevOps paired review"}</h1>
          <p>
            {[review?.status, review?.sourceBranch && review?.targetBranch
              ? `${review.sourceBranch} → ${review.targetBranch}`
              : ""].filter(Boolean).join(" · ")}
          </p>
        </div>
        <span className="local-badge">Local only</span>
      </header>
      <main>
        <section className="diff-panel">
          {activeFile ? (
            <>
              <div className="file-header">
                <span>{activeFile.path}</span>
                <span className="change-counts">
                  <span className="additions">+{activeFile.additions ?? 0}</span>
                  <span className="deletions">−{activeFile.deletions ?? 0}</span>
                </span>
              </div>
              <PierreDiff
                file={activeFile}
                onSelectionChange={setSelection}
                onThreadCreated={() => {
                  setSelection(null);
                  void load();
                }}
                selection={selection}
                theme={theme}
                threads={activeThreads}
              />
            </>
          ) : (
            <div className="empty">Loading pull request changes…</div>
          )}
        </section>
        <ChangedFileTree
          activePath={activeFile?.path ?? null}
          files={review?.files ?? []}
          onActivate={(file) => void focusFile(file)}
          threads={review?.threads ?? []}
        />
      </main>
    </div>
  );
}

interface PierreDiffProps {
  file: ReviewFile;
  onSelectionChange: (selection: SelectedLineRange | null) => void;
  onThreadCreated: () => void;
  selection: SelectedLineRange | null;
  theme: HostTheme;
  threads: ReviewThread[];
}

function PierreDiff({
  file,
  onSelectionChange,
  onThreadCreated,
  selection,
  theme,
  threads,
}: PierreDiffProps) {
  const parsed = useMemo(() => {
    try {
      return parsePatchFiles(file.diff, file.path, true)[0]?.files[0];
    } catch {
      return undefined;
    }
  }, [file.diff, file.path]);

  const annotations = useMemo<DiffLineAnnotation<ThreadAnnotation>[]>(() => {
    const existing = threads.map((thread) => ({
      side: thread.side,
      lineNumber: thread.lineEnd,
      metadata: { kind: "thread" as const, thread },
    }));
    if (!selection) return existing;
    return [
      ...existing,
      {
        side: selection.endSide ?? selection.side ?? "additions",
        lineNumber: selection.end,
        metadata: { kind: "composer" as const, range: selection },
      },
    ];
  }, [selection, threads]);

  if (!parsed) {
    return <pre className="fallback-diff">{file.diff || "No textual diff available."}</pre>;
  }

  return (
    <FileDiff<ThreadAnnotation>
      fileDiff={parsed}
      key={`${file.path}:${theme}`}
      lineAnnotations={annotations}
      options={{
        controlledSelection: true,
        diffStyle: "unified",
        disableBackground: true,
        disableFileHeader: true,
        enableLineSelection: true,
        expansionLineCount: 20,
        hunkSeparators: "line-info",
        lineHoverHighlight: "line",
        loadDiffFiles: file.oldContent !== undefined && file.newContent !== undefined
          ? async () => ({
              oldFile: {
                name: file.previousPath ?? file.path,
                contents: file.oldContent!,
              },
              newFile: {
                name: file.path,
                contents: file.newContent!,
              },
            })
          : undefined,
        onLineSelectionEnd: onSelectionChange,
        overflow: "scroll",
        theme: theme === "dark" ? "github-dark" : "github-light",
        themeType: theme,
      }}
      renderAnnotation={(annotation) => {
        const metadata = annotation.metadata;
        if (metadata.kind === "composer") {
          return (
            <NewThreadComposer
              file={file}
              onCancel={() => onSelectionChange(null)}
              onCreated={onThreadCreated}
              range={metadata.range}
            />
          );
        }
        return <ReviewThreadCard onUpdated={onThreadCreated} thread={metadata.thread} />;
      }}
      selectedLines={selection}
    />
  );
}

function NewThreadComposer({
  file,
  onCancel,
  onCreated,
  range,
}: {
  file: ReviewFile;
  onCancel: () => void;
  onCreated: () => void;
  range: SelectedLineRange;
}) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const message = body.trim();
    if (!message) return;
    setSending(true);
    try {
      const response = await fetch(api("/api/threads"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: file.path,
          side: range.endSide ?? range.side ?? "additions",
          lineStart: Math.min(range.start, range.end),
          lineEnd: Math.max(range.start, range.end),
          body: message,
        }),
      });
      if (!response.ok) throw new Error("Could not create review thread");
      onCreated();
    } finally {
      setSending(false);
    }
  }

  return (
    <form className="inline-thread composer" onSubmit={submit}>
      <div className="thread-title">Ask about lines {range.start === range.end ? range.start : `${range.start}–${range.end}`}</div>
      <textarea
        autoFocus
        maxLength={8000}
        onChange={(event) => setBody(event.target.value)}
        placeholder="Ask a question or draft a review observation…"
        value={body}
      />
      <div className="thread-actions">
        <button className="secondary-button" onClick={onCancel} type="button">Cancel</button>
        <button className="primary-button" disabled={sending || !body.trim()} type="submit">
          {sending ? "Asking…" : "Ask agent"}
        </button>
      </div>
    </form>
  );
}

function ReviewThreadCard({
  onUpdated,
  thread,
}: {
  onUpdated: () => void;
  thread: ReviewThread;
}) {
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [updating, setUpdating] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const body = reply.trim();
    if (!body || thread.pending) return;
    setSending(true);
    try {
      const response = await fetch(api(`/api/threads/${encodeURIComponent(thread.id)}/messages`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (!response.ok) throw new Error("Could not reply to review thread");
      setReply("");
      onUpdated();
    } finally {
      setSending(false);
    }
  }

  async function updateThread(input: { collapsed?: boolean; resolved?: boolean }) {
    setUpdating(true);
    try {
      const response = await fetch(api(`/api/threads/${encodeURIComponent(thread.id)}`), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!response.ok) throw new Error("Could not update review thread");
      onUpdated();
    } finally {
      setUpdating(false);
    }
  }

  return (
    <article className={`inline-thread${thread.collapsed ? " collapsed" : ""}${thread.resolved ? " resolved" : ""}`}>
      <div className="thread-title">
        <span>
          Lines {thread.lineStart === thread.lineEnd ? thread.lineStart : `${thread.lineStart}–${thread.lineEnd}`}
          {thread.resolved ? " · Resolved" : thread.pending ? " · Copilot is thinking…" : ""}
        </span>
        <span className="thread-controls">
          <button
            disabled={updating}
            onClick={() => void updateThread({ collapsed: !thread.collapsed })}
            type="button"
          >
            {thread.collapsed ? "Expand" : "Collapse"}
          </button>
          <button
            disabled={updating}
            onClick={() => void updateThread({
              collapsed: !thread.resolved,
              resolved: !thread.resolved,
            })}
            type="button"
          >
            {thread.resolved ? "Reopen" : "Resolve"}
          </button>
        </span>
      </div>
      {!thread.collapsed ? (
        <>
          <div className="thread-messages">
            {thread.messages.map((message) => (
              <div className={`thread-message ${message.role}`} key={message.id}>
                <strong>{message.role === "user" ? "You" : "Copilot"}</strong>
                <p>{message.body}</p>
              </div>
            ))}
            {thread.pending ? <div className="thread-pending">Copilot is thinking…</div> : null}
          </div>
          {!thread.resolved ? (
            <form className="thread-reply" onSubmit={submit}>
              <textarea
                disabled={thread.pending}
                maxLength={8000}
                onChange={(event) => setReply(event.target.value)}
                placeholder="Reply in this thread…"
                value={reply}
              />
              <button className="primary-button" disabled={sending || thread.pending || !reply.trim()} type="submit">
                Reply
              </button>
            </form>
          ) : null}
        </>
      ) : null}
    </article>
  );
}

function useHostTheme(): HostTheme {
  const detect = useCallback((): HostTheme => {
    const mode =
      document.documentElement.dataset.colorMode ??
      document.body.dataset.colorMode;
    if (mode === "light" || mode === "dark") return mode;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }, []);
  const [theme, setTheme] = useState<HostTheme>(detect);

  useEffect(() => {
    const update = () => {
      const next = detect();
      document.documentElement.dataset.pairedReviewTheme = next;
      setTheme(next);
    };
    const observer = new MutationObserver(update);
    const options = { attributes: true, attributeFilter: ["data-color-mode"] };
    observer.observe(document.documentElement, options);
    observer.observe(document.body, options);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", update);
    update();
    return () => {
      observer.disconnect();
      media.removeEventListener("change", update);
    };
  }, [detect]);

  return theme;
}

createRoot(document.getElementById("root")!).render(<App />);
