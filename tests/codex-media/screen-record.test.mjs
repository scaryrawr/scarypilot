import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../plugins/screen-record/skills/screen-record/scripts/screen-record.mjs", import.meta.url));

test("screen recorder exposes its portable command interface without capturing", () => {
  const help = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8", env: { ...process.env, PATH: "" } });
  assert.equal(help.status, 0, help.stderr);

  for (const command of ["doctor", "start", "stop", "trim", "subtitles", "narrate"]) assert.ok(help.stdout.includes(command));
});

test("screen recorder refuses malformed invocation before touching devices", () => {
  const invalid = spawnSync(process.execPath, [script, "unknown"], { encoding: "utf8", env: { ...process.env, PATH: "" } });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /unknown command: unknown/);
});
