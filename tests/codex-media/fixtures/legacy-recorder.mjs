import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const config = JSON.parse(process.argv[3]);

if (process.argv[2] === "start") {
  const worker = spawn(process.execPath, [fileURLToPath(import.meta.url), "_capture", process.argv[3]], {
    detached: true, stdio: "ignore",
  });

  worker.unref();

  for (let attempt = 0; attempt < 50 && !existsSync(config.state); attempt++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }

  console.log(readFileSync(config.state, "utf8"));
  process.exit(0);
}


const log = openSync(config.log, "a");

const ffmpeg = spawn("ffmpeg", ["-hide_banner", "-n", config.output], {
  stdio: ["pipe", "ignore", log],
});

let finalized = false;

let stopping = false;

function requestStop() {
  if (!stopping && ffmpeg.stdin.writable) {
    stopping = true;
    ffmpeg.stdin.write("q\n");
  }
}

const timer = setInterval(() => {
  if (existsSync(config.stop)) requestStop();
}, 200);

function finish(code, error) {
  if (finalized) return;
  finalized = true;
  clearInterval(timer);

  if (error) writeFileSync(config.log, `Could not start ffmpeg: ${error.message}\n`, { flag: "a" });
  closeSync(log);
  rmSync(config.stop, { force: true });
  rmSync(config.state, { force: true });
  process.exit(code);
}

process.on("SIGINT", requestStop);

process.on("SIGTERM", requestStop);

ffmpeg.once("spawn", () => {
  writeFileSync(config.state, JSON.stringify({
    status: "recording", output: config.output, workerPid: process.pid,
    ffmpegPid: ffmpeg.pid, startedAt: new Date().toISOString(),
    statePath: config.state, logPath: config.log,
  }));
});

ffmpeg.once("error", (error) => finish(1, error));

ffmpeg.once("close", (code) => finish(code ?? 1));
