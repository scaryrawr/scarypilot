import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

const spawn = childProcess.spawn;

const spawnSync = childProcess.spawnSync;

const mediaFixture = fileURLToPath(new URL("./ffmpeg.mjs", import.meta.url));

const lstat = fs.lstatSync;

const writeFile = fs.writeFileSync;

const rename = fs.renameSync;

const open = fs.openSync;

const close = fs.closeSync;

let controllerLog;

fs.openSync = (path, ...args) => {
  const fd = open(path, ...args);

  if (process.argv.includes("_capture") && String(path).endsWith(".log")) {
    controllerLog = { fd, path: String(path) };
  }

  return fd;
};

fs.closeSync = (fd) => {
  if (fd === controllerLog?.fd && process.env.RECORDER_FIXTURE_MODE === "log-close-delay") {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }

  if (fd === controllerLog?.fd && process.env.RECORDER_FIXTURE_MODE === "log-close-failure") {
    const lock = controllerLog.path.replace(/\.log$/, ".lock");

    writeFile(process.env.RECORDER_FIXTURE_CLOSE_MARKER, fs.existsSync(lock) ? "owned" : "released");
    throw new Error("fixture controller log close failed");
  }

  return close(fd);
};

let persistenceFailed = false;

function failPersistence(path, operation) {
  if (!process.argv.includes("_capture") || !process.env.RECORDER_FIXTURE_PERSISTENCE_MARKER ||
    !fs.existsSync(process.env.RECORDER_FIXTURE_PERSISTENCE_MARKER) ||
    !/\.json\..+\.tmp$/.test(String(path))) return;

  const mode = process.env.RECORDER_FIXTURE_MODE;

  if ((mode === "heartbeat-write-failure" && operation === "write" && !persistenceFailed) ||
    (mode === "heartbeat-rename-failure" && operation === "rename")) {
    persistenceFailed = true;

    const error = new Error(`fixture heartbeat ${operation} failure`);

    error.code = operation === "write" ? "ENOSPC" : "EACCES";
    throw error;
  }
}

fs.writeFileSync = (path, ...args) => {
  failPersistence(path, "write");

  return writeFile(path, ...args);
};

fs.renameSync = (source, destination) => {
  failPersistence(source, "rename");

  return rename(source, destination);
};

fs.lstatSync = (path, options) => {
  const result = lstat(path, options);

  if (process.env.RECORDER_FIXTURE_FOREIGN_LEGACY === "1" &&
    String(path).endsWith("scarypilot-screen-record") && result) {
    result.uid += 1;

    if (!process.getuid) result.isDirectory = () => false;
  }

  return result;
};

childProcess.spawn = (command, args = [], options) => {
  if (!["ffmpeg", "ffprobe"].includes(command)) return spawn(command, args, options);

  return spawn(process.execPath, [mediaFixture, ...args], options);
};

childProcess.spawnSync = (command, args = [], options) => {
  const powershell = fixturePowerShell(command, args, options);

  if (powershell) return powershell;

  if (command === "ffmpeg" && args.includes("hwnd=not-a-window")) {
    const stderr = "Invalid window handle 'not-a-window', must be a valid integer.\n";

    return { pid: process.pid, output: [null, "", stderr], stdout: "", stderr, status: 1, signal: null };
  }

  if (!["ffmpeg", "ffprobe"].includes(command)) return spawnSync(command, args, options);

  return spawnSync(process.execPath, [mediaFixture, ...args], options);
};

function fixturePowerShell(command, args, options) {
  if (process.env.RECORDER_FIXTURE_WINDOWS_JSON === undefined ||
    !["pwsh.exe", "powershell.exe"].includes(command.split(/[\\/]/).at(-1).toLowerCase())) {
    return undefined;
  }

  if (args.includes("-Command")) {
    if (command === "pwsh.exe" && process.env.RECORDER_FIXTURE_MODE?.startsWith("powershell-probe-")) {
      const program = process.env.RECORDER_FIXTURE_MODE === "powershell-probe-timeout"
        ? "setTimeout(() => {}, 5000)" : "process.stdout.write('x'.repeat(1000000))";

      return spawnSync(process.execPath, ["-e", program], options);
    }

    return { pid: process.pid, output: [null, "", ""], stdout: "", stderr: "", status: 0, signal: null };
  }

  if (!args.includes("-File")) return undefined;

  const windows = process.env.RECORDER_FIXTURE_MODE === "window-disappears-worker" &&
      process.argv.includes("_capture")
    ? JSON.stringify({ windows: [], uninspectableCount: 0 })
    : process.env.RECORDER_FIXTURE_WINDOWS_JSON;

  return { pid: process.pid, output: [null, windows, ""], stdout: windows, stderr: "", status: 0, signal: null };
}

syncBuiltinESMExports();
