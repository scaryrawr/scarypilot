import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

const spawn = childProcess.spawn;

const fixture = fileURLToPath(new URL("./media-process.mjs", import.meta.url));

childProcess.spawn = (command, args, options) => {
  if (command !== "ffmpeg" && command !== "ffprobe") throw new Error(`Unexpected media executable: ${command}`);

  if (process.env.MEDIA_FIXTURE_MODE === `missing-${command}`) {
    return spawn(process.execPath + ".missing-fixture", args, options);
  }

  return spawn(process.execPath, [fixture, command, ...args], options);
};

syncBuiltinESMExports();
