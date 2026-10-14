import { spawn, type ChildProcess } from "node:child_process";
import { getEventListeners } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { killTree, ProcessTerminationError, runShell, runShellStreaming, type ProcessControl } from "../src/spawn.ts";

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

async function cleanKnownPid(pid: number) {
  try {
    if (process.platform === "win32") process.kill(pid);
    else await killTree(pid);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
  }
}

function fixture() {
  const directory = path.resolve(`.spawn-test-${crypto.randomUUID()}`);
  mkdirSync(directory);
  directories.push(directory);

  return directory;
}

// This seam tests Unix signaling failure/capture teardown, not Windows ownership.
function failedSignaling(): ProcessControl {
  return {
    platform: "linux",
    kill: vi.fn<typeof process.kill>(() => { throw Object.assign(new Error("Access denied"), { code: "EPERM" }); }),
    spawn,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();

  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe.each(runners)("$name cancellation", ({ run }) => {
  it.each(["timeout", "abort"] as const)("terminates real descendants before the late marker on %s", async (reason) => {
    const directory = fixture();
    const ready = path.join(directory, "ready");
    const parent = path.join(directory, "parent");
    const marker = path.join(directory, "survived");
    const worker = "const fs=require('node:fs'); fs.writeFileSync('ready.writing',String(process.pid)); fs.renameSync('ready.writing','ready'); setTimeout(() => fs.writeFileSync('survived','alive'),2500)";
    writeFileSync(path.join(directory, "marker.cjs"),
      `const fs=require('node:fs'); fs.writeFileSync('parent.writing',String(process.pid)); fs.renameSync('parent.writing','parent'); require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(worker)}], { stdio: 'inherit' });`);
    const controller = new AbortController();
    let root: number | undefined;

    const control: ProcessControl = {
      platform: process.platform, kill: process.kill.bind(process),
      onWindowsStarted: (pid) => { root = pid; },
      spawn: (...args) => {
        const child = spawn(...args);

        if (args[0] === "bash") root = child.pid;

        return child;
      },
    };

    const pending = run(`${quote(process.execPath.replaceAll("\\", "/"))} marker.cjs`, {
      cwd: directory, timeoutMs: reason === "timeout" ? 1800 : 10_000,
      signal: controller.signal, processControl: control,
    });

    const observed = pending.catch((error: Error) => { throw error; });
    void observed.catch(() => {});

    try {
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 1500 });
      expect(root).toBeGreaterThan(0);

      if (reason === "abort") controller.abort();
      expect((await observed).killed).toBe(true);

      for (const file of [parent, ready]) {
        const pid = Number(readFileSync(file, "utf8"));
        await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 1500 });
      }

      await delay(2600);
      expect(existsSync(marker)).toBe(false);
    } finally {
      controller.abort();
      await pending;
    }
  }, 15_000);

  it("explains the Bash prerequisite on startup ENOENT", async () => {
    const control: ProcessControl = {
      platform: "linux", kill: process.kill.bind(process),
      spawn: (_command, args, options) => spawn("nonexistent-autoresearch-bash", args, options),
    };

    await expect(run("echo unreachable", { processControl: control })).rejects.toThrow("Bash is required");
  });

  it.runIf(process.platform === "win32")("explains the real native Bash prerequisite before any child exists", async () => {
    vi.stubEnv("PATH", "");
    await expect(run("echo unreachable", {})).rejects.toThrow("Bash is required");
  });

  it.each(["timeout", "abort"] as const)("reports signaling failure rather than success on %s", async (reason) => {
    const control = failedSignaling();
    let child: ChildProcess | undefined;
    control.spawn = (command, args, options) => {
      child = spawn(command, args, { ...options, detached: process.platform !== "win32" });

      return child;
    };

    const controller = new AbortController();

    const pending = run("sleep 0.3", {
      timeoutMs: reason === "timeout" ? 30 : undefined,
      signal: controller.signal, processControl: control,
    });

    if (reason === "abort") controller.abort();

    try {
      await expect(pending).rejects.toThrow("Access denied");
    } finally {
      child?.kill();
    }
  });
});

describe.each(["runShell", "runShellStreaming"] as const)("%s failure teardown", (runner) => {
  it("releases capture and owned logs even when a real child never closes", async () => {
    const directory = fixture();

    for (const name of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(name, directory);
    const pidFile = path.join(directory, "worker.pid");
    const control = failedSignaling();
    let child: ChildProcess | undefined;
    let workerPid: number | undefined;
    control.spawn = (command, args, options) => {
      child = spawn(command, args, { ...options, detached: process.platform !== "win32" });

      return child;
    };

    const controller = new AbortController();
    const onTick = vi.fn();
    const program = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => { process.stdout.write('output\\n'.repeat(100)); process.stderr.write('stderr\\n') }, 20)`;
    const command = `${quote(process.execPath.replaceAll("\\", "/"))} -e ${quote(program)} & wait`;
    const opts = { signal: controller.signal, processControl: control, onTick, maxBytes: 16, maxLines: 2 };
    const pending = runner === "runShell" ? runShell(command, opts) : runShellStreaming(command, opts);
    const failure = pending.catch((error: Error) => error);

    try {
      await vi.waitFor(() => {
        expect(existsSync(pidFile)).toBe(true);
        expect(child?.stdout?.listenerCount("data")).toBeGreaterThan(0);

        if (runner === "runShellStreaming") expect(readdirSync(directory).some((file) => file.endsWith(".log"))).toBe(true);
      });
      workerPid = Number(readFileSync(pidFile, "utf8"));
      unlinkSync(pidFile);
      controller.abort();
      expect(await failure).toBeInstanceOf(ProcessTerminationError);
      expect(child?.exitCode).toBeNull();
      expect(child?.stdout?.listenerCount("data")).toBe(0);
      expect(child?.stderr?.listenerCount("data")).toBe(0);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      expect(readdirSync(directory)).toEqual([]);
      const ticks = onTick.mock.calls.length;
      child?.emit("error", new Error("late error"));
      child?.stdout?.emit("data", Buffer.from("late output\n".repeat(100)));
      child?.stderr?.emit("data", Buffer.from("late stderr\n"));
      await delay(1100);
      expect(onTick.mock.calls.length).toBe(ticks);
      expect(readdirSync(directory)).toEqual([]);
    } finally {
      controller.abort();

      if (workerPid) await cleanKnownPid(workerPid);

      child?.kill();
      await failure;
    }
  }, 10_000);
});

describe("direct Bash contract and Unix signaling", () => {
  it.each(runners)("runs BASH_ENV exactly once through $name", async ({ run }) => {
    const directory = fixture();
    const startup = path.join(directory, "startup ' with spaces.sh").replaceAll("\\", "/");
    writeFileSync(startup, "printf startup\nexport STARTUP_VALUE=loaded\n");
    vi.stubEnv("BASH_ENV", startup);
    vi.stubEnv("STARTUP_VALUE", undefined);
    vi.stubEnv("AUTORESEARCH_ENV_SENTINEL", "preserved");
    const result = await run('printf \'command|%s|%s|%s|%s\' "${BASH_ENV+x}" "${BASH_ENV-}" "$STARTUP_VALUE" "$AUTORESEARCH_ENV_SENTINEL"', {});
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`startupcommand|x|${startup}|loaded|preserved`);
  });

  it.each(runners)("preserves BASH_ENV presence and exported SHELLOPTS through $name", async ({ run }) => {
    for (const startup of [undefined, ""]) {
      vi.stubEnv("BASH_ENV", startup);
      vi.stubEnv("SHELLOPTS", "braceexpand:hashall:interactive-comments:nounset");
      const result = await run('printf \'%s|%s|%s\' "${BASH_ENV+x}" "${BASH_ENV-}" "$SHELLOPTS"; if [[ -o posix ]]; then printf posix; fi', {});
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("posix");
      expect(result.stdout).toContain("nounset");
      expect(result.stdout.startsWith(startup === undefined ? "||" : "x||")).toBe(true);
    }
  });

  it.each(runners)("preserves explicit exec status through $name", async ({ run }) => {
    const result = await run(`exec ${quote(process.execPath.replaceAll("\\", "/"))} -e 'process.exit(23)'`, {});
    expect(result.exitCode).toBe(23);
  });

  it("preserves script paths, JSON stdin, startup and status", async () => {
    const directory = fixture();
    const script = path.join(directory, "checks with spaces.sh");
    writeFileSync(script, "cat\nexit 23\n");
    const startup = path.join(directory, "startup.sh").replaceAll("\\", "/");
    writeFileSync(startup, "printf startup\n");
    vi.stubEnv("BASH_ENV", startup);
    const input = { message: "input with spaces" };
    const result = await runShell({ script }, { stdinJson: input });
    expect(result.exitCode).toBe(23);
    expect(result.stdout).toBe(`startup${JSON.stringify(input)}`);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid PID %s", async (pid) => {
    await expect(killTree(pid)).rejects.toThrow("Invalid process ID");
  });

  it("rejects Windows ancestry termination without launching a fallback", async () => {
    const control = { ...failedSignaling(), platform: "win32" as const, spawn: vi.fn(spawn) };
    await expect(killTree(12345, control)).rejects.toThrow("owned execution resource");
    expect(control.spawn).not.toHaveBeenCalled();
  });

  it("preserves Unix groups and only ignores ESRCH", async () => {
    const control = failedSignaling();
    const kill = vi.fn<typeof process.kill>().mockReturnValue(true);
    control.kill = kill;
    await killTree(12345, control);
    expect(kill).toHaveBeenCalledWith(-12345, "SIGTERM");
    kill.mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    await expect(killTree(12345, control)).resolves.toBeUndefined();
    expect(kill).toHaveBeenCalledWith(12345, "SIGTERM");
    kill.mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
    await expect(killTree(12345, control)).rejects.toThrow("denied");
  });
});
