import { spawn } from "node:child_process";
import { closeSync, openSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

export interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Concatenated stdout + stderr in arrival order is hard to guarantee; use combined for convenience. */
  combined: string;
  killed: boolean;
  durationMs: number;
}

export interface SpawnOptions {
  cwd?: string;
  /** Hard kill after this many ms. 0 / undefined = no timeout. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Whether to capture stdin. Default true (no input). */
  stdinJson?: unknown;
}

/** Best-effort kill of a process group, falling back to the lone pid. */
export function killTree(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already dead
    }
  }
}

/**
 * Run `bash -c <command>` (or `bash <script>`) and capture all output.
 * Detached so we can kill the entire process group on timeout/abort.
 */
export function runShell(
  command: string | { script: string },
  opts: SpawnOptions = {},
): Promise<SpawnResult> {
  const args = typeof command === "string" ? ["-c", command] : [command.script];
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const child = spawn("bash", args, {
      cwd: opts.cwd,
      detached: true,
      stdio: [opts.stdinJson !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on("data", (d: Buffer) => stdoutChunks.push(d));
    child.stderr?.on("data", (d: Buffer) => stderrChunks.push(d));

    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            if (child.pid) killTree(child.pid);
          }, opts.timeoutMs)
        : null;

    const onAbort = () => {
      if (child.pid) killTree(child.pid);
      else child.kill();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      resolve({
        exitCode: code,
        stdout,
        stderr,
        combined: (stdout + (stdout && stderr ? "\n" : "") + stderr).trim(),
        killed: timedOut,
        durationMs: Date.now() - t0,
      });
    });

    if (opts.stdinJson !== undefined && child.stdin) {
      child.stdin.write(JSON.stringify(opts.stdinJson));
      child.stdin.end();
    }
  });
}

/**
 * Run a command with streaming output, tail-truncating to the last `maxBytes`
 * after a line boundary. Used by run_experiment.
 */
export interface StreamingRunOptions extends SpawnOptions {
  maxBytes: number;
  maxLines: number;
  /** Maximum overflow retained on disk. Default: 100 MiB. */
  maxOutputFileBytes?: number;
  onTick?: (elapsedMs: number, tail: string) => void;
}

export interface StreamingRunResult extends SpawnResult {
  tail: string;
  truncated: boolean;
  totalBytes: number;
  totalLines: number;
  fullOutputPath?: string;
  fullOutputTruncated: boolean;
}

export function runShellStreaming(
  command: string,
  opts: StreamingRunOptions,
): Promise<StreamingRunResult> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const child = spawn("bash", ["-c", command], {
      cwd: opts.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let lineBreaks = 0;
    let lastByteWasNewline = false;
    let fullOutputPath: string | undefined;
    let fullOutputFd: number | undefined;
    let retainedOutputBytes = 0;
    let fullOutputTruncated = false;
    const maxOutputFileBytes = opts.maxOutputFileBytes ?? 100 * 1024 * 1024;
    const maxKept = Math.max(opts.maxBytes * 2, 16 * 1024);

    const writeRetainedOutput = (data: Buffer) => {
      if (fullOutputFd === undefined) return;
      const remaining = maxOutputFileBytes - retainedOutputBytes;
      if (remaining <= 0) {
        fullOutputTruncated = true;
        return;
      }
      const output = data.length > remaining ? data.subarray(0, remaining) : data;
      try {
        writeSync(fullOutputFd, output);
        retainedOutputBytes += output.length;
        if (output.length < data.length) fullOutputTruncated = true;
      } catch {
        try {
          closeSync(fullOutputFd);
          if (fullOutputPath) unlinkSync(fullOutputPath);
        } catch {
          // The original write error is reflected by omitting the output path.
        }
        fullOutputFd = undefined;
        fullOutputPath = undefined;
      }
    };

    const handleData = (data: Buffer) => {
      totalBytes += data.length;
      for (const byte of data) {
        if (byte === 0x0a) lineBreaks++;
      }
      if (data.length > 0) lastByteWasNewline = data[data.length - 1] === 0x0a;
      if (totalBytes > opts.maxBytes && fullOutputFd === undefined && !fullOutputPath) {
        fullOutputPath = path.join(
          tmpdir(),
          `copilot-autoresearch-${crypto.randomBytes(8).toString("hex")}.log`,
        );
        try {
          fullOutputFd = openSync(fullOutputPath, "wx");
          for (const chunk of chunks) writeRetainedOutput(chunk);
        } catch {
          fullOutputFd = undefined;
          fullOutputPath = undefined;
        }
      }
      writeRetainedOutput(data);
      chunks.push(data);

      let bytes = chunks.reduce((acc, c) => acc + c.length, 0);
      while (bytes > maxKept && chunks.length > 1) {
        const removed = chunks.shift()!;
        bytes -= removed.length;
      }
      if (chunks.length > 0 && bytes > maxKept) {
        const buf = chunks[0];
        const nl = buf.indexOf(0x0a);
        if (nl !== -1 && nl < buf.length - 1) {
          chunks[0] = buf.subarray(nl + 1);
        }
      }
    };

    child.stdout?.on("data", handleData);
    child.stderr?.on("data", handleData);

    const tick = opts.onTick
      ? setInterval(() => {
          opts.onTick?.(Date.now() - t0, Buffer.concat(chunks).toString("utf-8"));
        }, 1000)
      : null;

    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            if (child.pid) killTree(child.pid);
          }, opts.timeoutMs)
        : null;

    const onAbort = () => {
      if (child.pid) killTree(child.pid);
      else child.kill();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (err) => {
      if (tick) clearInterval(tick);
      if (timer) clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      if (fullOutputFd !== undefined) {
        try {
          closeSync(fullOutputFd);
        } catch {
          // Preserve the spawn error as the failure reported to the caller.
        }
      }
      reject(err);
    });

    child.on("close", (code) => {
      if (tick) clearInterval(tick);
      if (timer) clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);

      const fullText = Buffer.concat(chunks).toString("utf-8");
      const allLines = fullText.split("\n");
      const totalLines =
        totalBytes === 0 ? 0 : lineBreaks + (lastByteWasNewline ? 0 : 1);
      const lastLines = allLines.slice(-opts.maxLines);
      let tail = lastLines.join("\n");
      if (tail.length > opts.maxBytes) {
        tail = tail.slice(tail.length - opts.maxBytes);
        const nlIdx = tail.indexOf("\n");
        if (nlIdx !== -1) tail = tail.slice(nlIdx + 1);
      }

      const finish = () => {
        resolve({
          exitCode: code,
          stdout: fullText,
          stderr: "",
          combined: fullText.trim(),
          killed: timedOut,
          durationMs: Date.now() - t0,
          tail,
          truncated: totalLines > opts.maxLines || totalBytes > opts.maxBytes,
          totalBytes,
          totalLines,
          fullOutputPath,
          fullOutputTruncated,
        });
      };
      if (fullOutputFd !== undefined) {
        try {
          closeSync(fullOutputFd);
        } catch {
          fullOutputPath = undefined;
        }
      }
      finish();
    });
  });
}
