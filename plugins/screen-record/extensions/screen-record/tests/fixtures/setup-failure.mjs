import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";

const remove = fs.rmSync;

const read = fs.readFileSync;

const spawn = childProcess.spawn;

let failed = false;

fs.rmSync = (path, ...args) => {
  if (!failed && String(path).endsWith(`.${process.env.RECORDER_FIXTURE_SETUP_ARTIFACT}`)) {
    failed = true;
    const lock = String(path).replace(/\.[^.]+$/, ".lock");
    const owner = read(lock, "utf8");

    if (process.env.RECORDER_FIXTURE_SETUP_REPLACEMENT === "identity") {
      fs.renameSync(lock, `${lock}.original`);
      fs.writeFileSync(lock, owner);
    } else if (process.env.RECORDER_FIXTURE_SETUP_REPLACEMENT === "owner") {
      fs.writeFileSync(lock, "replacement-owner");
    }

    throw Object.assign(new Error("fixture stale artifact removal failed with EIO"), { code: "EIO" });
  }

  if (failed && String(path).endsWith(".lock") && process.env.RECORDER_FIXTURE_ROLLBACK_ERROR === "remove") {
    throw Object.assign(new Error("fixture rollback removal failed with EACCES"), { code: "EACCES" });
  }

  return remove(path, ...args);
};

fs.readFileSync = (path, ...args) => {
  if (failed && String(path).endsWith(".lock") && process.env.RECORDER_FIXTURE_ROLLBACK_ERROR === "read") {
    throw Object.assign(new Error("fixture rollback ownership read failed with EACCES"), { code: "EACCES" });
  }

  return read(path, ...args);
};

childProcess.spawn = (...args) => {
  fs.writeFileSync(process.env.RECORDER_FIXTURE_SPAWN_MARKER, "unexpected worker spawn");

  return spawn(...args);
};

syncBuiltinESMExports();

await import(pathToFileURL(process.env.RECORDER_FIXTURE_SCRIPT));
