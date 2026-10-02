import fs from "node:fs";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";

const open = fs.openSync;

const read = fs.readFileSync;

const remove = fs.rmSync;

const close = fs.closeSync;

const spawn = childProcess.spawn;

const write = fs.writeFileSync;

const writeDescriptor = fs.writeSync;

let failed = false;

let logFd;

function injectFailure(path, operation) {
  failed = true;
  const lock = String(path).replace(/\.log$/, ".lock");
  const owner = read(lock, "utf8");

  if (process.env.RECORDER_FIXTURE_STARTUP_REPLACEMENT === "identity") {
    fs.renameSync(lock, `${lock}.original`);
    write(lock, owner);
  } else if (process.env.RECORDER_FIXTURE_STARTUP_REPLACEMENT === "owner") {
    write(lock, "replacement-owner");
  }

  if (process.env.RECORDER_FIXTURE_STARTUP_REPLACEMENT) {
    write(String(path), "replacement log");
    write(String(path).replace(/\.log$/, ".json"), "replacement state");
  }

  return Object.assign(new Error(`fixture worker ${operation} failed with EACCES`), { code: "EACCES" });
}

if (process.argv.includes("_capture")) {
  const config = JSON.parse(Buffer.from(process.argv.at(-1), "base64url").toString("utf8"));

  fs.openSync = (path, ...args) => {
    if (String(path) === config.log && process.env.RECORDER_FIXTURE_STARTUP_FAILURE === "log") {
      throw injectFailure(path, "log open");
    }

    const fd = open(path, ...args);

    if (String(path) === config.log) logFd = fd;

    return fd;
  };

  childProcess.spawn = (command, ...args) => {
    if (command !== "ffmpeg") return spawn(command, ...args);
    write(process.env.RECORDER_FIXTURE_SPAWN_MARKER, "FFmpeg spawn attempted");
    const error = injectFailure(config.log, "spawn");

    if (process.env.RECORDER_FIXTURE_STARTUP_FAILURE === "spawn-sync") throw error;

    const child = new EventEmitter();
    child.stdin = new EventEmitter();

    process.nextTick(() => child.emit("error", error));

    return child;
  };

  fs.closeSync = (fd) => {
    const result = close(fd);

    if (fd === logFd) {
      logFd = undefined;
      write(process.env.RECORDER_FIXTURE_CLOSED_MARKER, "log descriptor closed");

      if (process.env.RECORDER_FIXTURE_STARTUP_CLEANUP === "close") throw new Error("fixture startup log close failed");
    }

    return result;
  };

  fs.readFileSync = (path, ...args) => {
    if (failed && String(path) === config.lock && process.env.RECORDER_FIXTURE_STARTUP_CLEANUP === "read") {
      throw new Error("fixture startup ownership read failed");
    }

    return read(path, ...args);
  };

  fs.rmSync = (path, ...args) => {
    if (failed && String(path) === config.lock && process.env.RECORDER_FIXTURE_STARTUP_CLEANUP === "remove") {
      throw new Error("fixture startup lock removal failed");
    }

    return remove(path, ...args);
  };

  fs.writeFileSync = (path, ...args) => {
    if (failed && String(path) === config.log && process.env.RECORDER_FIXTURE_STARTUP_CLEANUP === "log") {
      throw new Error("fixture startup log write failed");
    }

    if (failed && /\.json\..+\.tmp$/.test(String(path)) &&
      process.env.RECORDER_FIXTURE_STARTUP_CLEANUP === "state") {
      throw new Error("fixture startup state persistence failed");
    }

    return write(path, ...args);
  };

  fs.writeSync = (fd, ...args) => {
    if (failed && fd === logFd && process.env.RECORDER_FIXTURE_STARTUP_CLEANUP === "log") {
      throw new Error("fixture startup log write failed");
    }

    return writeDescriptor(fd, ...args);
  };
}

syncBuiltinESMExports();
