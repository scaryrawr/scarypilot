import { existsSync, writeFileSync } from "node:fs";

const [statePath, output] = process.argv.slice(2);

const stopPath = statePath.replace(/\.json$/, ".stop");

const state = {
  status: "recording", output, statePath,
  logPath: statePath.replace(/\.json$/, ".log"),
  workerPid: process.pid, ffmpegPid: process.pid,
  startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
};

writeFileSync(state.logPath, "");

writeFileSync(statePath, JSON.stringify(state));

const deadline = Date.now() + 10000;

const interval = setInterval(() => {
  if (existsSync(stopPath) || Date.now() >= deadline) {
    writeFileSync(output, "legacy fixture recording");
    state.status = "stopped";
    state.endedAt = new Date().toISOString();
    state.exitCode = 0;
    clearInterval(interval);
  }

  state.updatedAt = new Date().toISOString();
  writeFileSync(statePath, JSON.stringify(state));
}, 50);
