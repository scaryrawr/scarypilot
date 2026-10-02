import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

const spawn = childProcess.spawn;

const spawnSync = childProcess.spawnSync;

const mediaFixture = fileURLToPath(new URL("./ffmpeg.mjs", import.meta.url));

childProcess.spawn = (command, args = [], options) => {
  if (!["ffmpeg", "ffprobe"].includes(command)) return spawn(command, args, options);

  return spawn(process.execPath, [mediaFixture, ...args], options);
};

childProcess.spawnSync = (command, args = [], options) => {
  if (!["ffmpeg", "ffprobe"].includes(command)) return spawnSync(command, args, options);

  return spawnSync(process.execPath, [mediaFixture, ...args], options);
};

syncBuiltinESMExports();
