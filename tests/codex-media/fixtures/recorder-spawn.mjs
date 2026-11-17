import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

const spawn = childProcess.spawn;

const spawnSync = childProcess.spawnSync;

const mediaFixture = fileURLToPath(new URL("./recorder-ffmpeg.mjs", import.meta.url));

if (process.env.RECORDER_FIXTURE_MODE === "missing-root") fs.existsSync = () => false;

if (process.env.RECORDER_FIXTURE_DISCOVERY_PLATFORM) {
  Object.defineProperty(process, "platform", { value: process.env.RECORDER_FIXTURE_DISCOVERY_PLATFORM });
}

if (process.env.RECORDER_FIXTURE_UNKNOWN_OWNER === "1") process.getuid = undefined;

const lstat = fs.lstatSync;

const writeFile = fs.writeFileSync;

const rename = fs.renameSync;

const open = fs.openSync;

const close = fs.closeSync;

const readFile = fs.readFileSync;

const stat = fs.statSync;

const remove = fs.rmSync;

const kill = process.kill;

let stateReads = 0;

let stateStats = 0;

function stateReadRace(path, operation, count) {
  if (!process.argv.includes("stop") || !String(path).endsWith(".json") || count !== 2 ||
    !process.env.RECORDER_FIXTURE_MODE?.startsWith(`legacy-state-${operation}-`)) return;

  const missing = process.env.RECORDER_FIXTURE_MODE.endsWith("-ENOENT");

  if (missing) remove(path, { force: true });

  const error = new Error(`fixture state ${operation} failed`);

  error.code = missing ? "ENOENT" : "EACCES";
  throw error;
}

fs.statSync = (path, ...args) => {
  stateReadRace(path, "stat", String(path).endsWith(".json") ? ++stateStats : 0);

  return stat(path, ...args);
};

fs.readFileSync = (path, ...args) => {
  const count = /[/\\][0-9a-f]{16}\.json$/.test(String(path)) ? ++stateReads : 0;
  stateReadRace(path, "read", count);

  if (process.argv.includes("stop") &&
    process.env.RECORDER_FIXTURE_MODE === "stop-replacement" && count === 2) {
    const selected = JSON.parse(readFile(path, "utf8"));

    const previous = selected.kind === "recording-reference"
      ? JSON.parse(readFile(`${path}.${selected.recordingId}.json`, "utf8")) : selected;

    const replacement = { ...previous, recordingId: "replacement-during-stop" };
    writeFile(String(path).replace(/\.json$/, ".lock"), replacement.recordingId);
    writeFile(path, JSON.stringify(replacement));
  }

  if (process.argv.includes("stop") && String(path).endsWith(".lock") &&
    process.env.RECORDER_FIXTURE_MODE?.startsWith("stop-lock-read-")) {
    const missing = process.env.RECORDER_FIXTURE_MODE === "stop-lock-read-ENOENT";

    if (missing) remove(path, { force: true });

    const error = new Error("fixture ownership read failed");

    error.code = missing ? "ENOENT" : "EACCES";
    throw error;
  }

  return readFile(path, ...args);
};

let exitChecks = 0;

process.kill = (pid, signal) => {
  if (process.argv.includes("stop") && signal === 0 &&
    pid === Number(process.env.RECORDER_FIXTURE_EXITED_PID) && ++exitChecks > 1) {
    const error = new Error("fixture controller already exited");

    error.code = "ESRCH";
    throw error;
  }

  return kill(pid, signal);
};

let controllerLog;

fs.openSync = (path, ...args) => {
  const fd = open(path, ...args);

  if (process.argv.includes("_capture") && String(path).endsWith(".log")) {
    controllerLog = { fd, path: String(path) };
  }

  return fd;
};

fs.closeSync = (fd) => {
  if (fd === controllerLog?.fd && (process.env.RECORDER_FIXTURE_MODE === "log-close-delay" ||
    process.env.RECORDER_FIXTURE_DELAY_CONTROLLER_EXIT === "1")) {
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

  const marker = process.env.RECORDER_FIXTURE_PUBLICATION_MARKER;

  if (process.argv.includes("_capture") && marker && fs.existsSync(marker) &&
    String(destination).endsWith(".json")) {
    const replacement = JSON.parse(readFile(marker, "utf8"));
    const next = JSON.parse(readFile(source, "utf8"));

    if (next.status === replacement.publicationStatus) {
      remove(marker);
      remove(replacement.lockPath, { force: true });
      writeFile(replacement.lockPath, replacement.recordingId);
      writeFile(replacement.discoveryPath, replacement.discoveryBytes);
      const result = rename(source, destination);
      writeFile(`${marker}.triggered`, String(destination));

      return result;
    }
  }

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
  if ((process.env.RECORDER_FIXTURE_WINDOWS_JSON === undefined &&
    process.env.RECORDER_FIXTURE_WINDOWS_FILE === undefined) ||
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

  if (process.env.RECORDER_FIXTURE_MODE === "powershell-restricted" &&
    (args[args.indexOf("-ExecutionPolicy") + 1] !== "Bypass")) {
    const stderr = "Script execution is disabled by the fixture's Restricted execution policy.";

    return { pid: process.pid, output: [null, "", stderr], stdout: "", stderr, status: 1, signal: null };
  }

  if (process.env.RECORDER_FIXTURE_MODE === "window-slow-worker" && process.argv.includes("_capture")) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5500);
  }

  const windows = process.env.RECORDER_FIXTURE_MODE === "window-disappears-worker" &&
      process.argv.includes("_capture")
    ? JSON.stringify({ windows: [], uninspectableCount: 0 })
    : process.env.RECORDER_FIXTURE_WINDOWS_FILE
      ? readFile(process.env.RECORDER_FIXTURE_WINDOWS_FILE, "utf8")
      : process.env.RECORDER_FIXTURE_WINDOWS_JSON;

  return { pid: process.pid, output: [null, windows, ""], stdout: windows, stderr: "", status: 0, signal: null };
}

syncBuiltinESMExports();
