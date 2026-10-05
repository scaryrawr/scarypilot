import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";

const originalSpawn = childProcess.spawn;

childProcess.spawn = (command, args, options) => {
  if (args[1] !== "_capture") return originalSpawn(command, args, options);

  const config = JSON.parse(Buffer.from(args[3], "base64url").toString("utf8"));
  const worker = new EventEmitter();

  worker.unref = () => worker;
  writeFileSync(`${config.output}.spawn-attempt`, "no worker created");

  if (process.env.RECORDER_FIXTURE_REPLACE_LOCK === "1") {
    writeFileSync(config.lock, "replacement-owner");
  }

  process.nextTick(() => worker.emit("error", Object.assign(
    new Error("fixture worker spawn failed with EAGAIN"),
    { code: "EAGAIN" },
  )));

  return worker;
};

syncBuiltinESMExports();

await import(pathToFileURL(process.env.RECORDER_FIXTURE_SCRIPT));
