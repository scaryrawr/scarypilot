import { spawn, type ChildProcess, type SpawnOptions as NodeSpawnOptions } from "node:child_process";
import { closeSync, openSync, unlinkSync, writeSync } from "node:fs";
import { platform, tmpdir } from "node:os";
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
  /** Process boundary; defaults to native subprocesses and platform signaling. */
  processControl?: ProcessControl;
}

export interface ProcessControl {
  platform: NodeJS.Platform;
  kill: typeof process.kill;
  spawn: (command: string, args: readonly string[], options: NodeSpawnOptions) => ChildProcess;
}

const nativeProcessControl: ProcessControl = {
  platform: platform(),
  kill: process.kill.bind(process),
  spawn,
};

function alreadyExited(error: NodeJS.ErrnoException): boolean {
  return error.code === "ESRCH";
}

/** Terminate Bash and its descendants, reporting failures to the caller. */
export async function killTree(
  pid: number,
  control: ProcessControl = nativeProcessControl,
): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Invalid process ID: ${pid}`);
  }

  if (control.platform === "win32") {
    await new Promise<void>((resolve, reject) => {
      const killer = control.spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        timeout: 5_000,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let output = "";

      const capture = (data: Buffer) => {
        output = (output + data.toString("utf-8")).slice(-8_192);
      };

      killer.stdout?.on("data", capture);
      killer.stderr?.on("data", capture);
      killer.on("error", reject);
      killer.on("close", (code, signal) => {
        if (code === 0) {
          resolve();

          return;
        }

        // taskkill can race with a process that has already finished.
        if (code === 128 && !signal) {
          try {
            control.kill(pid, 0);
          } catch (error) {
            if (error instanceof Error && alreadyExited(error)) {
              resolve();

              return;
            }
          }
        }

        reject(new Error(
          `Failed to terminate process tree ${pid}: taskkill.exe ${signal ? `received ${signal}` : `exited ${code}`}${output.trim() ? `: ${output.trim()}` : ""}`,
        ));
      });
    });

    return;
  }

  try {
    control.kill(-pid, "SIGTERM");
  } catch (error) {
    if (!(error instanceof Error) || !alreadyExited(error)) throw error;

    try {
      control.kill(pid, "SIGTERM");
    } catch (error) {
      if (!(error instanceof Error) || !alreadyExited(error)) throw error;
    }
  }
}

function bashError(error: NodeJS.ErrnoException): Error {
  return error.code === "ENOENT"
    ? new Error("Bash is required to run experiments. Install Bash and add it to PATH (Git for Windows Bash on Windows).", { cause: error })
    : error;
}

export class ProcessTerminationError extends Error {
  readonly pid: number;

  constructor(pid: number, cause: Error) {
    super(
      `Process tree rooted at PID ${pid} may still be running; the caller must terminate it manually. ${cause.message}`,
      { cause },
    );
    this.name = "ProcessTerminationError";
    this.pid = pid;
  }
}

function watchCancellation(
  child: ChildProcess,
  opts: SpawnOptions,
  onError: (error: Error) => void,
) {
  let killed = false;
  let termination = Promise.resolve();

  const stop = () => {
    if (killed || child.pid === undefined) return;
    const pid = child.pid;
    killed = true;
    termination = killTree(pid, opts.processControl);
    void termination.catch((error: Error) => {
      cleanup();
      onError(new ProcessTerminationError(pid, error));
    });
  };

  const timer = opts.timeoutMs && opts.timeoutMs > 0
    ? setTimeout(stop, opts.timeoutMs)
    : undefined;

  const cleanup = () => {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", stop);
  };

  if (opts.signal?.aborted) stop();
  else opts.signal?.addEventListener("abort", stop, { once: true });

  return { cleanup, finished: () => termination, killed: () => killed };
}

function spawnBash(
  args: string[],
  opts: SpawnOptions,
  stdin: "pipe" | "ignore",
): ChildProcess {
  const control = opts.processControl ?? nativeProcessControl;

  // MSYS exec can replace a Windows PID. Keep an outer Bash waiting for its child.
  const shellArgs = control.platform === "win32"
    ? [
        "-c",
        'if [ "$1" = set ]; then export BASH_ENV="$2"; else unset BASH_ENV; fi; shift 2; command bash "$@" <&0 & wait "$!"',
        "copilot-autoresearch",
        process.env.BASH_ENV === undefined ? "unset" : "set",
        process.env.BASH_ENV ?? "",
        ...args,
      ]
    : args;

  // Only the experiment shell should load BASH_ENV, not its waiting supervisor.
  const env = control.platform === "win32"
    ? Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "BASH_ENV"))
    : undefined;

  return control.spawn("bash", shellArgs, {
    cwd: opts.cwd,
    env,
    detached: true,
    stdio: [stdin, "pipe", "pipe"],
  });
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
    const child = spawnBash(args, opts, opts.stdinJson !== undefined ? "pipe" : "ignore");

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
      cancellation.cleanup();
      child.stdout?.removeListener("data", captureStdout);
      child.stderr?.removeListener("data", captureStderr);
      stdoutChunks.length = 0;
      stderrChunks.length = 0;
      reject(error);
    };

    const cancellation = watchCancellation(child, opts, fail);

    child.on("error", (err) => {
      fail(bashError(err));
    });

    child.on("close", async (code) => {
      if (failed) return;
      cancellation.cleanup();

      try {
        await cancellation.finished();
      } catch (error) {
        reject(error);

        return;
      }

      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      resolve({
        exitCode: code,
        stdout,
        stderr,
        combined: (stdout + (stdout && stderr ? "\n" : "") + stderr).trim(),
        killed: cancellation.killed(),
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
    const child = spawnBash(["-c", command], opts, "ignore");

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

      cancellation.cleanup();
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

      reject(failure);
    };

    const cancellation = watchCancellation(child, opts, fail);

    child.on("error", (err) => {
      fail(bashError(err));
    });

    child.on("close", async (code) => {
      if (failed) return;

      if (tick) clearInterval(tick);

      cancellation.cleanup();

      try {
        await cancellation.finished();
      } catch (error) {
        reject(error);

        return;
      }

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
          killed: cancellation.killed(),
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
    });
  });
}
