import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";

const open = fs.openSync;

const write = fs.writeFileSync;

const close = fs.closeSync;

const spawn = childProcess.spawn;

let lockFd;

let lockPath;

let injected = false;

fs.openSync = (path, flags, ...rest) => {
  const fd = open(path, flags, ...rest);

  if (flags === "wx" && String(path).endsWith(".lock")) {
    lockFd = fd;
    lockPath = path;
  }

  return fd;
};

fs.writeFileSync = (file, data, ...rest) => {
  if (file === lockFd && !injected && process.env.RECORDER_FIXTURE_LOCK_FAILURE !== "close") {
    injected = true;

    if (process.env.RECORDER_FIXTURE_REPLACE_LOCK === "1") {
      fs.unlinkSync(lockPath);
      write(lockPath, "replacement-owner");
    } else {
      write(file, String(data).slice(0, 8));
    }

    throw Object.assign(new Error("fixture lock write failed with ENOSPC"), { code: "ENOSPC" });
  }

  return write(file, data, ...rest);
};

fs.closeSync = (fd) => {
  if (fd === lockFd) {
    if (!injected && process.env.RECORDER_FIXTURE_LOCK_FAILURE === "close") {
      injected = true;
      throw Object.assign(new Error("fixture lock close failed with EIO"), { code: "EIO" });
    }

    write(process.env.RECORDER_FIXTURE_CLOSED_MARKER, "owned descriptor closed");
  }

  return close(fd);
};

childProcess.spawn = (...args) => {
  write(process.env.RECORDER_FIXTURE_SPAWN_MARKER, "unexpected worker spawn");

  return spawn(...args);
};

syncBuiltinESMExports();

await import(pathToFileURL(process.env.RECORDER_FIXTURE_SCRIPT));
