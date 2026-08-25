import * as fs from "node:fs";
import * as http from "node:http";
import { spawn } from "node:child_process";
import { autoresearchHtmlPath, autoresearchJsonlPath } from "./paths.ts";
import { ensureParentDir } from "./paths.ts";
import {
  reconstructJsonlState,
  type ReconstructedJsonlState,
  type ReconstructedRun,
} from "./jsonl.ts";
import {
  computeConfidence,
  currentResults,
  findBaselineMetric,
  findBestMetric,
} from "./confidence.ts";
import { formatDelta, formatNum } from "./format.ts";

export function buildDashboardHtml(
  jsonlContent: string,
  options: { liveUpdates?: boolean } = {},
): string {
  const state = reconstructJsonlState(jsonlContent);
  const baseline = findBaselineMetric(state.results, state.currentSegment);
  const best = findBestMetric(state.results, state.currentSegment, state.bestDirection);
  const confidence = computeConfidence(
    state.results,
    state.currentSegment,
    state.bestDirection,
  );

  const cur = currentResults(state.results, state.currentSegment);
  const counts = {
    keep: cur.filter((r) => r.status === "keep").length,
    discard: cur.filter((r) => r.status === "discard").length,
    crash: cur.filter((r) => r.status === "crash").length,
    checks_failed: cur.filter((r) => r.status === "checks_failed").length,
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(state.name ?? "Autoresearch")}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 24px; max-width: 1080px; }
  h1 { margin-top: 0; }
  .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { padding: 12px 16px; border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 8px; }
  .card .label { font-size: 12px; opacity: 0.7; text-transform: uppercase; letter-spacing: 0.05em; }
  .card .value { font-size: 22px; font-weight: 600; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent); vertical-align: top; }
  th { font-weight: 600; opacity: 0.8; }
  .status-keep { color: #1f883d; font-weight: 600; }
  .status-discard { color: #b08800; font-weight: 600; }
  .status-crash, .status-checks_failed { color: #cf222e; font-weight: 600; }
  .delta-good { color: #1f883d; }
  .delta-bad { color: #cf222e; }
  .chart { width: 100%; height: 220px; margin: 8px 0 24px; overflow: visible; }
  .chart .axis { stroke: color-mix(in srgb, currentColor 18%, transparent); }
  .chart .series { fill: none; stroke: #2f81f7; stroke-width: 2.5; }
  .chart .keep { fill: #1f883d; }
  .chart .discard { fill: #b08800; }
  .chart .crash, .chart .checks_failed { fill: #cf222e; }
  .footer { margin-top: 24px; opacity: 0.6; font-size: 12px; }
  details { margin-top: 8px; }
  pre { white-space: pre-wrap; word-break: break-word; background: color-mix(in srgb, currentColor 6%, transparent); padding: 8px 10px; border-radius: 6px; }
</style>
</head>
<body>
<h1>${escapeHtml(state.name ?? "Autoresearch")}</h1>
<div class="summary">
  <div class="card"><div class="label">Metric</div><div class="value">${escapeHtml(state.metricName)}</div><div>${escapeHtml(state.bestDirection)} is better</div></div>
  <div class="card"><div class="label">Baseline</div><div class="value">${escapeHtml(formatNum(baseline, state.metricUnit))}</div></div>
  <div class="card"><div class="label">Best (kept)</div><div class="value">${escapeHtml(formatNum(best, state.metricUnit))}</div><div>${escapeHtml(formatDelta(best ?? 0, baseline))}</div></div>
  <div class="card"><div class="label">Runs (segment)</div><div class="value">${cur.length}</div><div>${counts.keep} keep · ${counts.discard} discard · ${counts.crash} crash · ${counts.checks_failed} checks_failed</div></div>
  <div class="card"><div class="label">Confidence</div><div class="value">${confidence === null ? "—" : confidence.toFixed(2) + "×"}</div><div>${confidenceDescription(confidence)}</div></div>
</div>
${renderChart(state)}
${renderRunsTable(state)}
<p class="footer">${options.liveUpdates
    ? `Live dashboard · updates after each experiment`
    : `Static export of the autoresearch session log.`}</p>
${options.liveUpdates ? `<script>
  const events = new EventSource("/events");
  events.addEventListener("jsonl-updated", () => location.reload());
</script>` : ""}
</body>
</html>
`;
}

function renderChart(state: ReconstructedJsonlState): string {
  const runs = currentResults(state.results, state.currentSegment);
  if (runs.length < 2) return "";

  const width = 900;
  const height = 220;
  const padding = 24;
  const values = runs.map((run) => run.metric);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (index: number) =>
    padding + (index / Math.max(1, runs.length - 1)) * (width - padding * 2);
  const y = (value: number) =>
    padding + ((max - value) / span) * (height - padding * 2);
  const points = runs.map((run, index) => `${x(index)},${y(run.metric)}`).join(" ");
  const dots = runs
    .map(
      (run, index) =>
        `<circle class="${run.status}" cx="${x(index)}" cy="${y(run.metric)}" r="4"><title>#${run.run} ${escapeHtml(formatNum(run.metric, state.metricUnit))} · ${escapeHtml(run.description)}</title></circle>`,
    )
    .join("");

  return `<h2>Metric trend</h2>
<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(state.metricName)} trend">
  <line class="axis" x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" />
  <polyline class="series" points="${points}" />
  ${dots}
</svg>`;
}

function renderRunsTable(state: ReconstructedJsonlState): string {
  if (state.results.length === 0) {
    return "<p>No experiments yet.</p>";
  }
  const baseline = findBaselineMetric(state.results, state.currentSegment);
  const rows = [...state.results].reverse().map((r) => renderRunRow(r, baseline, state));
  const secondary = state.secondaryMetrics.map((m) => `<th>${escapeHtml(m.name)}</th>`).join("");
  return `
<h2>Runs</h2>
<table>
  <thead>
    <tr>
      <th>#</th><th>Status</th><th>${escapeHtml(state.metricName)}</th><th>Δ</th>${secondary}<th>Description</th><th>Commit</th>
    </tr>
  </thead>
  <tbody>
    ${rows.join("\n")}
  </tbody>
</table>
`;
}

function renderRunRow(
  run: ReconstructedRun,
  baseline: number | null,
  state: ReconstructedJsonlState,
): string {
  const delta = formatDelta(run.metric, baseline);
  const deltaClass = run.metric === (baseline ?? run.metric)
    ? ""
    : isImprovement(run.metric, baseline, state.bestDirection)
      ? "delta-good"
      : "delta-bad";
  const secondaryCells = state.secondaryMetrics
    .map((m) => {
      const v = run.metrics[m.name];
      return `<td>${v === undefined ? "—" : escapeHtml(formatNum(v, m.unit))}</td>`;
    })
    .join("");
  const asi = run.asi
    ? `<details><summary>ASI</summary><pre>${escapeHtml(JSON.stringify(run.asi, null, 2))}</pre></details>`
    : "";
  return `<tr>
    <td>${run.run}</td>
    <td class="status-${escapeHtml(run.status)}">${escapeHtml(run.status)}</td>
    <td>${escapeHtml(formatNum(run.metric, state.metricUnit))}</td>
    <td class="${deltaClass}">${escapeHtml(delta.trim())}</td>
    ${secondaryCells}
    <td>${escapeHtml(run.description)}${asi}</td>
    <td><code>${escapeHtml(run.commit)}</code></td>
  </tr>`;
}

function isImprovement(value: number, baseline: number | null, direction: "lower" | "higher"): boolean {
  if (baseline === null) return false;
  return direction === "lower" ? value < baseline : value > baseline;
}

function confidenceDescription(c: number | null): string {
  if (c === null) return "needs ≥3 runs";
  if (c >= 2.0) return "likely real";
  if (c >= 1.0) return "above noise but marginal";
  return "within noise";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function exportDashboard(workDir: string): { path: string; ok: boolean; error: string | null } {
  const jsonlPath = autoresearchJsonlPath(workDir);
  if (!fs.existsSync(jsonlPath)) {
    return {
      path: autoresearchHtmlPath(workDir),
      ok: false,
      error: "No autoresearch session log found — run some experiments first.",
    };
  }

  try {
    const content = fs.readFileSync(jsonlPath, "utf-8");
    const html = buildDashboardHtml(content);
    const out = autoresearchHtmlPath(workDir);
    ensureParentDir(out);
    fs.writeFileSync(out, html);
    return { path: out, ok: true, error: null };
  } catch (e) {
    return {
      path: autoresearchHtmlPath(workDir),
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

let dashboardServer: http.Server | null = null;
let dashboardPort: number | null = null;
let dashboardWorkDir: string | null = null;
const dashboardClients = new Set<http.ServerResponse>();

export async function openLiveDashboard(
  workDir: string,
): Promise<{ url: string | null; error: string | null }> {
  const jsonlPath = autoresearchJsonlPath(workDir);
  if (!fs.existsSync(jsonlPath)) {
    return { url: null, error: "No autoresearch session log found — run some experiments first." };
  }

  try {
    const port = await startDashboardServer(workDir);
    const url = `http://127.0.0.1:${port}`;
    openInBrowser(url);
    return { url, error: null };
  } catch (error) {
    return {
      url: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function stopLiveDashboard(): Promise<void> {
  for (const client of dashboardClients) client.end();
  dashboardClients.clear();
  if (!dashboardServer) return;
  const server = dashboardServer;
  dashboardServer = null;
  dashboardPort = null;
  dashboardWorkDir = null;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function startDashboardServer(workDir: string): Promise<number> {
  if (dashboardServer && dashboardPort && dashboardWorkDir === workDir) {
    return dashboardPort;
  }
  await stopLiveDashboard();

  const server = http.createServer((_request, response) => {
    const requestUrl = new URL(_request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname === "/events") {
      response.writeHead(200, {
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream",
      });
      response.write("retry: 1000\n\n");
      dashboardClients.add(response);
      response.on("close", () => dashboardClients.delete(response));
      return;
    }
    if (requestUrl.pathname !== "/") {
      response.writeHead(404).end();
      return;
    }
    try {
      const content = fs.readFileSync(autoresearchJsonlPath(workDir), "utf-8");
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
        "Content-Type": "text/html; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(buildDashboardHtml(content, { liveUpdates: true }));
    } catch {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Autoresearch session log is unavailable.");
    }

  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to bind dashboard server");
  }
  dashboardServer = server;
  dashboardPort = address.port;
  dashboardWorkDir = workDir;
  return address.port;
}

export function broadcastDashboardUpdate(workDir: string): void {
  if (!dashboardServer || dashboardWorkDir !== workDir) return;
  for (const client of dashboardClients) {
    try {
      client.write(`event: jsonl-updated\ndata: ${Date.now()}\n\n`);
    } catch {
      dashboardClients.delete(client);
    }
  }
}

function openInBrowser(url: string): void {
  const child =
    process.platform === "win32"
      ? spawn("cmd", ["/c", "start", "", url], {
          detached: true,
          shell: true,
          stdio: "ignore",
        })
      : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], {
          detached: true,
          stdio: "ignore",
        });
  child.on("error", () => {});
  child.unref();
}
