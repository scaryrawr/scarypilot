import * as fs from "node:fs";
import {
  autoresearchHookPath,
  autoresearchJsonlPath,
} from "./paths.ts";
import { hasAutoresearchConfigHeader } from "./jsonl.ts";
import type { Direction } from "./jsonl.ts";
import { runShell } from "./spawn.ts";

const HOOK_TIMEOUT_MS = 30_000;
const STDOUT_MAX_BYTES = 8 * 1024;
const TRUNCATION_MARKER = "\n…[truncated: hook stdout exceeded 8KB]";

const NEWLINE = 0x0a;
const UTF8_CONT_MASK = 0xc0;
const UTF8_CONT = 0x80; // continuation byte: 10xxxxxx
const UTF8_LEAD = 0xc0; // multi-byte leader: 11xxxxxx

export type HookStage = "before" | "after";

export interface SessionSnapshot {
  metric_name: string;
  metric_unit: string;
  direction: Direction;
  baseline_metric: number | null;
  best_metric: number | null;
  run_count: number;
  goal: string;
}

export interface BeforeHookPayload {
  event: "before";
  cwd: string;
  next_run: number;
  last_run: Record<string, unknown> | null;
  session: SessionSnapshot;
}

export interface AfterHookPayload {
  event: "after";
  cwd: string;
  run_entry: Record<string, unknown>;
  session: SessionSnapshot;
}

export type HookPayload = BeforeHookPayload | AfterHookPayload;

export interface HookResult {
  fired: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

const NOT_FIRED: HookResult = {
  fired: false,
  stdout: "",
  stderr: "",
  exitCode: null,
  timedOut: false,
  durationMs: 0,
};

function isExecutableFile(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

// Trim at the last newline within the kept window, falling back to the last
// complete UTF-8 character. Matches pi-autoresearch's behavior so multi-line
// hook output stays line-intact when truncated.
function truncateAtBoundary(buf: Buffer): Buffer {
  const newlineEnd = buf.lastIndexOf(NEWLINE);
  if (newlineEnd >= 0) return buf.subarray(0, newlineEnd + 1);
  let end = buf.length;
  while (end > 0 && (buf[end - 1] & UTF8_CONT_MASK) === UTF8_CONT) end--;
  if (end > 0 && (buf[end - 1] & UTF8_CONT_MASK) === UTF8_LEAD) end--;
  return buf.subarray(0, end);
}

export function truncateHookStdout(text: string, maxBytes: number = STDOUT_MAX_BYTES): string {
  const buf = Buffer.from(text, "utf-8");
  if (buf.length <= maxBytes) return text;
  const kept = truncateAtBoundary(buf.subarray(0, maxBytes));
  return kept.toString("utf-8") + TRUNCATION_MARKER;
}

export async function runHook(payload: HookPayload): Promise<HookResult> {
  const script = autoresearchHookPath(payload.cwd, payload.event);
  if (!isExecutableFile(script)) return NOT_FIRED;

  try {
    const result = await runShell(
      { script },
      {
        cwd: payload.cwd,
        timeoutMs: HOOK_TIMEOUT_MS,
        stdinJson: payload,
      },
    );
    return {
      fired: true,
      stdout: truncateHookStdout(result.stdout),
      stderr: result.stderr,
      exitCode: result.exitCode,
      timedOut: result.killed,
      durationMs: result.durationMs,
    };
  } catch (e) {
    return {
      fired: true,
      stdout: "",
      stderr: e instanceof Error ? e.message : String(e),
      exitCode: null,
      timedOut: false,
      durationMs: 0,
    };
  }
}

export function steerMessageFor(stage: HookStage, result: HookResult): string | null {
  if (!result.fired) return null;
  if (result.timedOut) return `[${stage} hook timed out after ${HOOK_TIMEOUT_MS / 1000}s]`;
  if (result.exitCode !== 0) {
    const parts = [`[${stage} hook exited ${result.exitCode}]`];
    const err = result.stderr.trim();
    const out = result.stdout.trim();
    if (err) parts.push(err);
    if (out) parts.push(out);
    return parts.join("\n");
  }
  return result.stdout.trim() || null;
}

export function hookLogEntry(stage: HookStage, result: HookResult): Record<string, unknown> {
  return {
    type: "hook",
    stage,
    exit_code: result.exitCode,
    duration_ms: result.durationMs,
    stdout_bytes: Buffer.byteLength(result.stdout, "utf-8"),
    timed_out: result.timedOut,
  };
}

function hasConfigHeader(jsonlPath: string): boolean {
  if (!fs.existsSync(jsonlPath)) return false;
  try {
    return hasAutoresearchConfigHeader(fs.readFileSync(jsonlPath, "utf-8"));
  } catch {
    return false;
  }
}

export function appendHookLogEntryIfConfigured(
  workDir: string,
  stage: HookStage,
  result: HookResult,
): boolean {
  if (!result.fired) return false;
  const jsonlPath = autoresearchJsonlPath(workDir);
  if (!hasConfigHeader(jsonlPath)) return false;
  try {
    fs.appendFileSync(jsonlPath, JSON.stringify(hookLogEntry(stage, result)) + "\n");
    return true;
  } catch {
    return false;
  }
}
