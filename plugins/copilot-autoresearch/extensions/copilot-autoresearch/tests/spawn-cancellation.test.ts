import { spawn, type ChildProcess } from "node:child_process";
import { getEventListeners } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  killTree,
  ProcessTerminationError,
  runShell,
  runShellStreaming,
  type ProcessControl,
} from "../src/spawn.ts";

const runners = [
  { name: "runShell", run: runShell },
  {
    name: "runShellStreaming",
    run: (command: string, opts: Parameters<typeof runShell>[1]) =>
      runShellStreaming(command, { ...opts, maxBytes: 4096, maxLines: 20 }),
  },
];

const directories: string[] = [];

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const quote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;

function windowsControl(program: string): ProcessControl {
  return {
    platform: "win32",
    kill: process.kill.bind(process),
    spawn: vi.fn((command, args, options) =>
      command === "taskkill.exe"
        ? spawn(process.execPath, ["-e", program], options)
        : spawn(command, args, options),
    ),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();

  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.each(runners)("$name cancellation", ({ run }) => {
  it.each(["timeout", "abort"] as const)(
    "terminates a real descendant before it can write a marker on %s",
    async (reason) => {
      const directory = path.resolve(`.spawn-test-${crypto.randomUUID()}`);
      mkdirSync(directory);
      directories.push(directory);

      const ready = path.join(directory, "ready");
      const parent = path.join(directory, "parent");
      const marker = path.join(directory, "survived");
      const program = `require('node:fs').writeFileSync(${JSON.stringify(parent)}, String(process.ppid)); require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 2500)`;
      // Keep Bash alive while a separate Node descendant owns the delayed write.
      const command = `${quote(process.execPath.replaceAll("\\", "/"))} -e ${quote(program)} & wait`;
      const controller = new AbortController();

      const resultPromise = run(command, {
        timeoutMs: reason === "timeout" ? 1800 : 10_000,
        signal: controller.signal,
      });

      try {
        await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 1500 });

        if (reason === "abort") controller.abort();

        const result = await resultPromise;
        expect(result.killed).toBe(true);
        await delay(2600);
        expect(existsSync(marker)).toBe(false);
      } finally {
        controller.abort();

        try {
          await resultPromise;
        } finally {
          for (const file of [parent, ready]) {
            if (existsSync(file)) await killTree(Number(readFileSync(file, "utf-8")));
          }
        }
      }
    },
    15_000,
  );

  it("explains the Bash prerequisite on startup ENOENT", async () => {
    const control = windowsControl("");
    control.spawn = (command, args, options) =>
      spawn(command === "bash" ? "nonexistent-autoresearch-bash" : command, args, options);
    await expect(run("echo unreachable", { processControl: control })).rejects.toThrow(
      "Bash is required",
    );
  });

  it.each(["timeout", "abort"] as const)(
    "reports Windows taskkill failures on %s rather than returning success",
    async (reason) => {
      const control = windowsControl("console.error('Access denied'); process.exitCode = 1");
      const pids: number[] = [];
      const invoke = control.spawn;
      control.spawn = (...args) => {
        if (args[0] === "taskkill.exe") pids.push(Number(args[1][1]));

        return invoke(...args);
      };

      const controller = new AbortController();

      // This Bash exits naturally, but retain the exact PID for failure cleanup.
      const result = run("sleep 0.3", {
        timeoutMs: reason === "timeout" ? 30 : undefined,
        signal: controller.signal,
        processControl: control,
      });

      if (reason === "abort") controller.abort();

      try {
        await expect(result).rejects.toThrow(/taskkill.exe exited 1.*Access denied/s);
      } finally {
        await Promise.all(pids.map((pid) => killTree(pid)));
      }
    },
  );
});

describe.each(["runShell", "runShellStreaming"] as const)("%s failure teardown", (runner) => {
  it("stops capturing output without waiting for a still-running child to close", async () => {
    const directory = path.resolve(`.spawn-test-${crypto.randomUUID()}`);
    mkdirSync(directory);
    directories.push(directory);
    vi.stubEnv("TMPDIR", directory);
    vi.stubEnv("TMP", directory);
    vi.stubEnv("TEMP", directory);

    const control = windowsControl("console.error('Access denied'); process.exitCode = 1");
    const invoke = control.spawn;
    let child: ChildProcess | undefined;
    control.spawn = (...args) => {
      const spawned = invoke(...args);

      if (args[0] === "bash") child = spawned;

      return spawned;
    };

    const controller = new AbortController();
    const onTick = vi.fn();
    const program = "setInterval(() => { process.stdout.write('output\\n'.repeat(100)); process.stderr.write('stderr\\n') }, 20)";
    const command = `${quote(process.execPath.replaceAll("\\", "/"))} -e ${quote(program)} & wait`;
    const opts = { signal: controller.signal, processControl: control, onTick, maxBytes: 16, maxLines: 2 };
    const result = runner === "runShell" ? runShell(command, opts) : runShellStreaming(command, opts);
    const failure = result.catch((error: Error) => error);

    try {
      await vi.waitFor(() => {
        expect(child?.stdout?.listenerCount("data")).toBeGreaterThan(0);

        if (runner === "runShellStreaming") {
          expect(readdirSync(directory).some((file) => file.endsWith(".log"))).toBe(true);
        }
      });

      controller.abort();
      const error = await failure;
      expect(error).toBeInstanceOf(ProcessTerminationError);
      expect(error).toMatchObject({
        pid: child?.pid,
        message: expect.stringContaining("the caller must terminate it manually"),
        cause: expect.any(Error),
      });
      expect(child?.exitCode).toBeNull();
      expect(child?.signalCode).toBeNull();
      expect(child?.stdout?.listenerCount("data")).toBe(0);
      expect(child?.stderr?.listenerCount("data")).toBe(0);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      expect(readdirSync(directory)).toEqual([]);
      const ticks = onTick.mock.calls.length;
      child?.emit("error", new Error("late process error"));
      child?.stdout?.emit("data", Buffer.from("late output\n".repeat(100)));
      child?.stderr?.emit("data", Buffer.from("late stderr\n"));
      await delay(1100);
      expect(onTick.mock.calls.length).toBe(ticks);
      expect(readdirSync(directory)).toEqual([]);
      expect(child?.exitCode).toBeNull();
      expect(child?.signalCode).toBeNull();
    } finally {
      controller.abort();

      if (child?.pid) await killTree(child.pid);

      await failure;
    }
  }, 10_000);
});

describe("killTree", () => {
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid process ID %s before invoking a command",
    async (pid) => {
      await expect(killTree(pid)).rejects.toThrow("Invalid process ID");
    },
  );

  it("uses bounded, shell-free taskkill with a numeric PID on Windows", async () => {
    const control = windowsControl("process.exitCode = 0");
    await killTree(12345, control);
    expect(control.spawn).toHaveBeenCalledWith(
      "taskkill.exe",
      ["/PID", "12345", "/T", "/F"],
      expect.objectContaining({ shell: false, windowsHide: true, timeout: 5000 }),
    );
  });

  it("does not hide missing taskkill", async () => {
    const control = windowsControl("");
    control.spawn = (_command, args, options) =>
      spawn("nonexistent-autoresearch-taskkill.exe", args, options);
    await expect(killTree(12345, control)).rejects.toThrow();
  });

  it.each(runners)("waits for taskkill even after $name Bash closes", async ({ run }) => {
    const control = windowsControl("setTimeout(() => { process.exitCode = 1 }, 200)");
    await expect(run("sleep 0.1", { timeoutMs: 20, processControl: control })).rejects.toThrow(
      "taskkill.exe exited 1",
    );
  });

  it("reports a hung taskkill instead of hanging indefinitely", async () => {
    const control = windowsControl("setInterval(() => {}, 1000)");
    await expect(killTree(12345, control)).rejects.toThrow("Failed to terminate process tree");
  }, 8000);

  it("accepts taskkill's not-found result only if the PID has exited", async () => {
    const control = windowsControl("process.exitCode = 128");

    const kill = vi.fn<typeof process.kill>(() => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });

    control.kill = kill;
    await expect(killTree(12345, control)).resolves.toBeUndefined();
    expect(kill).toHaveBeenCalledWith(12345, 0);
    kill.mockReturnValue(true);
    await expect(killTree(12345, control)).rejects.toThrow("taskkill.exe exited 128");
  });

  it("preserves Unix process-group signaling and only ignores exited processes", async () => {
    const control = windowsControl("");
    control.platform = "linux";
    const kill = vi.fn<typeof process.kill>().mockReturnValue(true);
    control.kill = kill;
    await killTree(12345, control);
    expect(kill).toHaveBeenCalledWith(-12345, "SIGTERM");
    kill.mockImplementation(() => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    await expect(killTree(12345, control)).resolves.toBeUndefined();
    expect(kill).toHaveBeenCalledWith(12345, "SIGTERM");
    kill.mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    await expect(killTree(12345, control)).rejects.toThrow("denied");
  });
});
