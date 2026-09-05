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
  useRef,
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
  const [startingReview, setStartingReview] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const reviewRequestId = useRef<string | null>(null);

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
    () => review?.threads.filter((thread) => thread.anchor.path === activeFile?.path) ?? [],
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

  async function startReview() {
    if (!review?.loaded || startingReview) return;
    const requestId = review.reviewPass.kind === "completed" || review.reviewPass.kind === "failed"
      ? crypto.randomUUID()
      : reviewRequestId.current ?? crypto.randomUUID();
    reviewRequestId.current = requestId;
    setStartingReview(true);
    setReviewError(null);
    try {
      const response = await fetch(api("/api/review-passes"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId }),
      });
      if (!response.ok) {
        const body: unknown = await response.json();
        const message = typeof body === "object" && body !== null &&
          "error" in body && typeof body.error === "string" && body.error.trim()
          ? body.error
          : "Could not start Copilot review";
        throw new Error(message);
      }
      await load();
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : "Could not start Copilot review");
    } finally {
      setStartingReview(false);
    }
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
        <div className="review-actions">
          {reviewError ? <span className="review-error" role="alert">{reviewError}</span> : null}
          {review?.loaded ? (
            <button
              className="primary-button"
              disabled={startingReview || isActiveReview(review.reviewPass)}
              onClick={() => void startReview()}
              type="button"
            >
              {review.reviewPass.kind === "idle"
                ? "Start Copilot review"
                : reviewPassLabel(review.reviewPass)}
            </button>
          ) : null}
          <span className="local-badge">Local only</span>
        </div>
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
      side: thread.anchor.side,
      lineNumber: thread.anchor.lineEnd,
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
  const [fixing, setFixing] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const busy = thread.pending || thread.fixing;
  const canDiscuss = thread.kind === "remote" || !thread.resolved;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const body = reply.trim();
    if (!body || busy) return;
    setSending(true);
    setActionError(null);
    try {
      const response = await fetch(api(`/api/threads/${encodeURIComponent(thread.id)}/messages`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (!response.ok) throw new Error("Could not reply to review thread");
      setReply("");
      onUpdated();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not ask Copilot about this thread");
    } finally {
      setSending(false);
    }
  }

  async function updateThread(input: { collapsed?: boolean; resolved?: boolean }) {
    setUpdating(true);
    setActionError(null);
    try {
      const response = await fetch(api(`/api/threads/${encodeURIComponent(thread.id)}`), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!response.ok) throw new Error("Could not update review thread");
      onUpdated();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not update review thread");
    } finally {
      setUpdating(false);
    }
  }

  async function startFix() {
    if (busy) return;
    setFixing(true);
    setActionError(null);
    try {
      const response = await fetch(api(`/api/threads/${encodeURIComponent(thread.id)}/fix`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!response.ok) throw new Error("Could not start Copilot fix");
      onUpdated();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not start Copilot fix");
    } finally {
      setFixing(false);
    }
  }

  return (
    <article className={`inline-thread${thread.collapsed ? " collapsed" : ""}${thread.resolved ? " resolved" : ""}`}>
      <div className="thread-title">
        <span>
          {thread.kind === "finding" ? `${thread.finding.severity} · ${thread.finding.title} · ` : ""}
          {thread.kind === "remote" ? `Azure DevOps · #${thread.remoteThreadId} · ` : ""}
          Lines {thread.anchor.lineStart === thread.anchor.lineEnd
            ? thread.anchor.lineStart
            : `${thread.anchor.lineStart}–${thread.anchor.lineEnd}`}
          {thread.resolved ? " · Resolved" : busy ? " · Copilot is working…" : ""}
        </span>
        <span className="thread-controls">
          <button
            disabled={updating || busy}
            onClick={() => void updateThread({ collapsed: !thread.collapsed })}
            type="button"
          >
            {thread.collapsed ? "Expand" : "Collapse"}
          </button>
          {thread.kind !== "remote" ? (
            <button
              disabled={updating || busy}
              onClick={() => void updateThread({
                collapsed: !thread.resolved,
                resolved: !thread.resolved,
              })}
              type="button"
            >
              {thread.resolved ? "Reopen" : "Resolve"}
            </button>
          ) : null}
        </span>
      </div>
      {!thread.collapsed ? (
        <>
          <div className="thread-messages">
            {thread.messages.map((message) => (
              <div className={`thread-message ${message.role}`} key={message.id}>
                <strong>
                  {message.role === "user"
                    ? "You"
                    : message.role === "assistant"
                      ? "Copilot"
                      : message.author || "Azure DevOps reviewer"}
                </strong>
                <p>{message.body}</p>
              </div>
            ))}
            {thread.pending ? <div className="thread-pending">Copilot is thinking…</div> : null}
            {thread.fixing ? <div className="thread-pending">Copilot is applying feedback in the workspace…</div> : null}
            {thread.kind === "finding" ? (
              <div className="finding-publication">
                {thread.finding.publication.kind === "local"
                  ? "Local finding"
                  : thread.finding.publication.disposition === "published"
                    ? "Published to Azure DevOps"
                    : "Already published to Azure DevOps"}
              </div>
            ) : null}
            {thread.kind === "remote" ? (
              <div className="finding-publication">Imported from Azure DevOps · private Copilot follow-ups stay local</div>
            ) : null}
          </div>
          {canDiscuss ? (
            <form className="thread-reply" onSubmit={submit}>
              <textarea
                disabled={busy}
                maxLength={8000}
                onChange={(event) => setReply(event.target.value)}
                placeholder={thread.kind === "remote"
                  ? "Ask Copilot privately about this feedback…"
                  : "Ask Copilot a follow-up…"}
                value={reply}
              />
              <div className="thread-actions">
                <button
                  className="secondary-button"
                  disabled={fixing || busy}
                  onClick={() => void startFix()}
                  type="button"
                >
                  {thread.fixing ? "Fixing…" : "Fix with Copilot"}
                </button>
                <button className="primary-button" disabled={sending || busy || !reply.trim()} type="submit">
                  {sending ? "Asking…" : "Ask Copilot"}
                </button>
              </div>
            </form>
          ) : null}
          {actionError ? <p className="thread-error" role="alert">{actionError}</p> : null}
        </>
      ) : null}
    </article>
  );
}

function isActiveReview(reviewPass: ReviewState["reviewPass"]): boolean {
  return reviewPass.kind === "queued" || reviewPass.kind === "running";
}

function reviewPassLabel(reviewPass: ReviewState["reviewPass"]): string {
  switch (reviewPass.kind) {
    case "queued":
      return "Copilot review queued";
    case "running":
      return `Copilot reviewing · ${reviewPass.findingCount} findings`;
    case "completed":
      return `Review complete · ${reviewPass.findingCount} findings`;
    case "failed":
      return "Review failed · Try again";
    case "idle":
      return "Start Copilot review";
  }
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
