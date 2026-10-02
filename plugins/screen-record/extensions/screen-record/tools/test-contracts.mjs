import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const tests = fileURLToPath(new URL("../tests/recording.test.ts", import.meta.url));

const result = spawnSync(process.execPath, [
  "--test", "--experimental-strip-types", "--test-reporter=tap", tests,
], {
  encoding: "utf8",
  timeout: 120000,
  maxBuffer: 1048576,
  windowsHide: true,
});

process.stdout.write(result.stdout ?? "");

process.stderr.write(result.stderr ?? "");

if (result.error) throw result.error;

if (result.status !== 0) process.exit(result.status ?? 1);

if (!/^# skipped 0\r?$/m.test(result.stdout) || !/^# cancelled 0\r?$/m.test(result.stdout)) {
  throw new Error("Capture-free lifecycle contracts must run on every host without skipped or cancelled tests.");
}
