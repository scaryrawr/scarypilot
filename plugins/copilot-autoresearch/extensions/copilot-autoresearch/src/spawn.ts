import { closeSync, openSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { startBash, type ProcessControl } from "./execution.ts";

export { killTree, ProcessTerminationError, type ProcessControl } from "./execution.ts";

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
  /** Process boundary; defaults to native subprocesses and platform signaling. */
  processControl?: ProcessControl;
}

/**
 * Run `bash -c <command>` (or `bash <script>`) and capture all output.
 * Windows owns a kernel job; Unix owns a detached process group.
 */
export function runShell(
  command: string | { script: string },
  opts: SpawnOptions = {},
): Promise<SpawnResult> {
  const args = typeof command === "string" ? ["-c", command] : [command.script];
  const t0 = Date.now();

  return new Promise((resolve, reject) => {
    const input = opts.stdinJson !== undefined ? JSON.stringify(opts.stdinJson) : undefined;
    const child = startBash(args, { ...opts, startedAt: t0 }, opts.stdinJson !== undefined ? "pipe" : "ignore");

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const captureStdout = (data: Buffer) => stdoutChunks.push(data);
    const captureStderr = (data: Buffer) => stderrChunks.push(data);
    child.stdout?.on("data", captureStdout);
    child.stderr?.on("data", captureStderr);

    let failed = false;

    const fail = (error: Error) => {
      if (failed) return;
      failed = true;
      const cleanup = child.dispose();
      child.stdout?.removeListener("data", captureStdout);
      child.stderr?.removeListener("data", captureStderr);
      stdoutChunks.length = 0;
      stderrChunks.length = 0;
      void Promise.resolve(cleanup).then(() => reject(error), (cause: Error) =>
        reject(cause === error ? error : new AggregateError([error, cause], `${error.message} Execution cleanup was not confirmed: ${cause.message}`)));
    };

    child.stdout.on("error", fail);
    child.stderr.on("error", fail);
    void child.closed.then(({ exitCode: code, killed }) => {
      if (failed) return;

      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      resolve({
        exitCode: code,
        stdout,
        stderr,
        combined: (stdout + (stdout && stderr ? "\n" : "") + stderr).trim(),
        killed,
        durationMs: Date.now() - t0,
      });
    }, fail);

    if (opts.stdinJson !== undefined && child.stdin) {
      child.stdin.end(input);
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
    const input = opts.stdinJson !== undefined ? JSON.stringify(opts.stdinJson) : undefined;
    const child = startBash(["-c", command], { ...opts, startedAt: t0 }, opts.stdinJson !== undefined ? "pipe" : "ignore");

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

    let failed = false;

    const fail = (error: Error) => {
      if (failed) return;
      failed = true;

      if (tick) clearInterval(tick);

      const cleanup = child.dispose();
      child.stdout?.removeListener("data", handleData);
      child.stderr?.removeListener("data", handleData);
      chunks.length = 0;
      const fd = fullOutputFd;
      const outputPath = fullOutputPath;
      fullOutputFd = undefined;
      fullOutputPath = undefined;
      let failure = error;

      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch (cause) {
          failure = new Error(
            `${failure.message} Failed to close unreturned output ${outputPath}.`,
            { cause: new AggregateError([failure, cause]) },
          );
        }
      }

      if (outputPath) {
        try {
          unlinkSync(outputPath);
        } catch (cause) {
          if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT") {
            failure = new Error(
              `${failure.message} Remove the unreturned output manually: ${outputPath}.`,
              { cause: new AggregateError([failure, cause]) },
            );
          }
        }
      }

      void Promise.resolve(cleanup).then(() => reject(failure), (cause: Error) =>
        reject(cause === failure ? failure : new AggregateError([failure, cause], `${failure.message} Execution cleanup was not confirmed: ${cause.message}`)));
    };

    child.stdout.on("error", fail);
    child.stderr.on("error", fail);
    void child.closed.then(({ exitCode: code, killed }) => {
      if (failed) return;

      if (tick) clearInterval(tick);

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
          killed,
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
        const fd = fullOutputFd;
        fullOutputFd = undefined;

        try {
          closeSync(fd);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));

          return;
        }
      }

      finish();
    }, fail);

    if (opts.stdinJson !== undefined && child.stdin) child.stdin.end(input);
  });
}
