import { spawn, type ChildProcess, type SpawnOptions as NodeSpawnOptions } from "node:child_process";
import { Readable, type Writable } from "node:stream";
import { finished as streamFinished } from "node:stream/promises";
import { bashError, startWindowsBash } from "./windows-execution.ts";

export interface ProcessControl {
  platform: NodeJS.Platform;
  kill: typeof process.kill;
  spawn: (command: string, args: readonly string[], options: NodeSpawnOptions) => ChildProcess;
  /** Observation only: injected spawn/kill functions never substitute for Windows job ownership. */
  onWindowsStarted?: (pid: number) => void;
}

export interface ExecutionOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  processControl?: ProcessControl;
  startedAt: number;
}

export interface Execution {
  stdin: Writable | null;
  stdout: Readable;
  stderr: Readable;
  closed: Promise<{ exitCode: number | null; killed: boolean }>;
  dispose(): void | Promise<void>;
}

export const nativeProcessControl: ProcessControl = {
  platform: process.platform, kill: process.kill.bind(process), spawn,
};

export async function killTree(pid: number, control: ProcessControl = nativeProcessControl): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid process ID: ${pid}`);

  if (control.platform === "win32") throw new Error("Windows termination requires the owned execution resource, not a PID ancestry operation");

  try {
    control.kill(-pid, "SIGTERM");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;

    try { control.kill(pid, "SIGTERM"); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
    }
  }
}

export class ProcessTerminationError extends Error {
  readonly pid: number;
  constructor(pid: number, cause: Error) {
    super(`Process tree rooted at PID ${pid} may still be running; the caller must terminate it manually. ${cause.message}`, { cause });
    this.name = "ProcessTerminationError";
    this.pid = pid;
  }
}

export function startBash(args: string[], opts: ExecutionOptions, input: "pipe" | "ignore"): Execution {
  if (opts.signal?.aborted) {
    return {
      stdin: null, stdout: Readable.from([]), stderr: Readable.from([]),
      closed: Promise.resolve({ exitCode: null, killed: true }), dispose() {},
    };
  }

  const control = opts.processControl ?? nativeProcessControl;

  if (control.platform === "win32") {
    if (process.platform !== "win32") throw new Error("Injected subprocesses cannot provide Windows kernel job ownership");
    const execution = startWindowsBash(args, opts, input);

    return { ...execution, closed: execution.closed.catch((error: NodeJS.ErrnoException) => { throw bashError(error); }) };
  }

  const child = control.spawn("bash", args, { cwd: opts.cwd, detached: true, stdio: [input, "pipe", "pipe"] });
  let killed = false;
  let finished = false;
  let stopping = Promise.resolve();

  const stop = () => {
    if (killed || child.pid === undefined) return;
    killed = true;
    const pid = child.pid;
    stopping = killTree(pid, control).catch((error: Error) => { throw new ProcessTerminationError(pid, error); });
    void stopping.catch(rejectClosed);
  };

  const timer = opts.timeoutMs && opts.timeoutMs > 0 ? setTimeout(stop, opts.timeoutMs) : undefined;

  const cleanup = () => {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", stop);
  };

  let rejectClosed: (error: Error) => void = () => {};

  const closed = new Promise<{ exitCode: number | null; killed: boolean }>((resolve, reject) => {
    rejectClosed = reject;
    child.on("error", (error) => reject(bashError(error)));
    child.on("close", (exitCode) => {
      finished = true;
      void Promise.all([stopping, inputClosed]).then(() => resolve({ exitCode, killed }), reject);
    });
  }).finally(cleanup);

  const inputClosed = child.stdin ? streamFinished(child.stdin, { cleanup: true }).catch((error: Error) => {
    if (!killed) throw error;
  }) : Promise.resolve();

  void inputClosed.catch(rejectClosed);

  opts.signal?.addEventListener("abort", stop, { once: true });

  if (opts.signal?.aborted) stop();

  return {
    stdin: child.stdin, stdout: child.stdout ?? Readable.from([]), stderr: child.stderr ?? Readable.from([]), closed,
    dispose() {
      cleanup();

      if (!finished) stop();

      return stopping;
    },
  };
}
