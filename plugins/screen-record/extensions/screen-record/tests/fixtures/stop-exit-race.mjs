import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const originalKill = process.kill;

const workerPid = Number(process.env.RECORDER_FIXTURE_WORKER_PID);

let workerChecks = 0;

process.kill = (pid, signal) => {
  if (pid !== workerPid || signal !== 0 || ++workerChecks !== 2) {
    return originalKill(pid, signal);
  }

  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    try {
      originalKill(pid, 0);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;

      writeFileSync(process.env.RECORDER_FIXTURE_RACE_MARKER, "worker exited after cached state was read");
      throw error;
    }

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }

  throw new Error("Fixture worker did not exit within the race probe deadline");
};

await import(pathToFileURL(process.env.RECORDER_FIXTURE_SCRIPT));
