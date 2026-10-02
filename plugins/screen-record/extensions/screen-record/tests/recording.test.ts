import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { createRecordingTools, runRecorder, type RecorderRuntime } from "../src/tools.ts";
import { RecordingStateSchema, type RecordingState } from "../src/domain.ts";

const script = fileURLToPath(new URL("../../../skills/screen-record/scripts/screen-record.mjs", import.meta.url));

const fixture = fileURLToPath(new URL("./fixtures/ffmpeg.mjs", import.meta.url));

const invocation = { sessionId: "fixture", toolCallId: "fixture", toolName: "fixture" };

async function setup(mode = "") {
  const root = await mkdtemp(join(tmpdir(), "screen-record-test-"));
  const cwd = join(root, "workspace");
  const bin = join(root, "bin");
  const temporary = join(root, "temporary");
  await Promise.all([mkdir(cwd), mkdir(bin), mkdir(temporary)]);

  for (const name of ["ffmpeg", "ffprobe"]) {
    await copyFile(fixture, join(bin, name));
    await chmod(join(bin, name), 0o755);
  }

  const runtime: RecorderRuntime = {
    script, cwd: await realpath(cwd),
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: temporary, TMP: temporary, TEMP: temporary, DISPLAY: ":fixture", RECORDER_FIXTURE_MODE: mode },
  };

  return { root, runtime, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const Envelope = Type.Object({
  resultType: Type.Union([Type.Literal("success"), Type.Literal("failure")]),
  textResultForLlm: Type.String(),
});

type FixtureToolInput = Record<string, string | number | boolean | undefined | { x: number; y: number; width: number; height: number }>;

async function call(runtime: RecorderRuntime, name: string, input: FixtureToolInput, signal?: AbortSignal) {
  const tool = createRecordingTools(runtime).find((entry) => entry.name === name);
  assert.ok(tool);
  assert.ok(tool.handler);
  const result: unknown = await tool.handler(input, { ...invocation, arguments: input, signal });
  assert.ok(Value.Check(Envelope, result));

  return result;
}

function state(text: string): RecordingState {
  const value: unknown = JSON.parse(text);
  assert.ok(Value.Check(RecordingStateSchema, value));

  return value;
}

async function start(runtime: RecorderRuntime, output = "raw.mp4") {
  const result = await call(runtime, "screen_record_start", { output, captureApproved: true, videoInput: "0" });
  assert.equal(result.resultType, "success", result.textResultForLlm);
  const value = state(result.textResultForLlm);
  assert.equal(value.status, "recording");
  assert.ok("recordingId" in value && value.recordingId);

  return value;
}

async function stop(runtime: RecorderRuntime, value: RecordingState, timeoutSeconds = 3) {
  assert.ok("recordingId" in value);

  return call(runtime, "screen_record_stop", { output: value.output, recordingId: value.recordingId, timeoutSeconds });
}

test("diagnostics and device discovery return bounded typed results without capture or narration", { skip: process.platform === "win32" }, async () => {
  const fixture = await setup();

  try {
    for (const name of ["screen_record_doctor", "screen_record_devices"]) {
      const result = await call(fixture.runtime, name, {});
      assert.equal(result.resultType, "success", result.textResultForLlm);
      assert.equal(JSON.parse(result.textResultForLlm).permissionsVerified, false);
    }

    const idle = await call(fixture.runtime, "screen_record_status", { output: "raw.mp4" });
    assert.equal(state(idle.textResultForLlm).status, "not-recording");
  } finally { await fixture.cleanup(); }
});

test("recording survives command return and a new tool instance; stop is graceful and idempotent", { skip: process.platform === "win32" }, async () => {
  const fixture = await setup();
  let recording: RecordingState | undefined;

  try {
    recording = await start(fixture.runtime);
    assert.ok("statePath" in recording && "recordingId" in recording);
    const lockPath = recording.statePath.replace(/\.json$/, ".lock");

    assert.equal(await readFile(lockPath, "utf8"), recording.recordingId);
    const current = await call({ ...fixture.runtime }, "screen_record_status", { output: "raw.mp4" });
    assert.equal(state(current.textResultForLlm).status, "recording");
    const wrong = await call(fixture.runtime, "screen_record_stop", { output: "raw.mp4", recordingId: "wrong" });
    assert.equal(wrong.resultType, "failure");
    assert.match(wrong.textResultForLlm, /identity does not match/);
    const stopped = await stop(fixture.runtime, recording);
    assert.equal(stopped.resultType, "success", stopped.textResultForLlm);
    assert.equal(state(stopped.textResultForLlm).status, "stopped");
    await assert.rejects(readFile(lockPath, "utf8"), { code: "ENOENT" });
    assert.equal(await readFile(recording.output, "utf8"), "fixture raw recording");
    const repeated = await stop(fixture.runtime, recording);
    assert.equal(repeated.textResultForLlm, stopped.textResultForLlm);
    const final = await call(fixture.runtime, "screen_record_status", { output: "raw.mp4" });
    assert.equal(state(final.textResultForLlm).status, "stopped");
  } finally {
    if (recording) await stop(fixture.runtime, recording);
    await fixture.cleanup();
  }
});

test("intent, paths, options, and existing sources are guarded before capture", { skip: process.platform === "win32" }, async () => {
  const fixture = await setup();

  try {
    await writeFile(join(fixture.runtime.cwd, "source.mp4"), "original source");
    await symlink(fixture.root, join(fixture.runtime.cwd, "escape"));

    for (const input of [
      { output: "raw.mp4", videoInput: "0" },
      { output: "raw.mp4", captureApproved: true, audioDevice: "0", videoInput: "0" },
      { output: "../outside.mp4", captureApproved: true, videoInput: "0" },
      { output: "escape/outside.mp4", captureApproved: true, videoInput: "0" },
      { output: "source.mp4", captureApproved: true, videoInput: "0" },
      { output: "raw.mp4", captureApproved: true, fps: 121 },
      { output: "raw.mp4", captureApproved: true, videoInput: "--help" },
      { output: "raw.mp4", captureApproved: true, region: { x: 0, y: 0, width: 3, height: 2 } },
    ]) {
      const result = await call(fixture.runtime, "screen_record_start", input);
      assert.equal(result.resultType, "failure", JSON.stringify(input));
    }

    assert.equal(await readFile(join(fixture.runtime.cwd, "source.mp4"), "utf8"), "original source");
  } finally { await fixture.cleanup(); }
});

test("approved capture options map to the existing platform recorder without extra commands", { skip: process.platform === "win32" }, async () => {
  const fixture = await setup("argument-contract");
  let recording: RecordingState | undefined;

  try {
    const result = await call(fixture.runtime, "screen_record_start", {
      output: "options.mp4", captureApproved: true, audioApproved: true,
      videoInput: "0", audioDevice: "1", fps: 60,
      region: { x: 100, y: 80, width: 1280, height: 720 },
    });

    assert.equal(result.resultType, "success", result.textResultForLlm);
    recording = state(result.textResultForLlm);

    const value: unknown = JSON.parse(await readFile(`${recording.output}.args.json`, "utf8"));

    assert.ok(Value.Check(Type.Array(Type.String()), value));
    assert.equal(value[value.indexOf("-framerate") + 1], "60");
    assert.equal(value[value.indexOf("-c:a") + 1], "aac");
    assert.ok(value.includes("-n"));
    assert.ok(!value.includes("-y"));

    if (process.platform === "darwin") {
      assert.equal(value[value.indexOf("-i") + 1], "0:1");
      assert.equal(value[value.indexOf("-vf") + 1], "crop=1280:720:100:80");
    } else {
      assert.equal(value[value.indexOf("-i") + 1], "0+100,80");
      assert.equal(value[value.indexOf("-video_size") + 1], "1280x720");
      assert.ok(value.includes("pulse"));
    }
  } finally {
    if (recording) await stop(fixture.runtime, recording);
    await fixture.cleanup();
  }
});

test("dangling and existing output leaf symlinks are rejected before recorder invocation", { skip: process.platform === "win32" }, async () => {
  const fixture = await setup();

  try {
    const outside = join(fixture.root, "outside");
    const invoked = join(fixture.root, "recorder-invoked");
    const markerScript = join(fixture.root, "marker.mjs");

    await mkdir(outside);
    await writeFile(markerScript, `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(invoked)}, "invoked");
`);
    await symlink(join(outside, "missing.mp4"), join(fixture.runtime.cwd, "dangling.mp4"));
    await writeFile(join(outside, "existing.mp4"), "outside source");
    await symlink(join(outside, "existing.mp4"), join(fixture.runtime.cwd, "existing-link.mp4"));

    for (const output of ["dangling.mp4", "existing-link.mp4"]) {
      const result = await call({ ...fixture.runtime, script: markerScript }, "screen_record_start", {
        output, captureApproved: true, videoInput: "0",
      });

      assert.equal(result.resultType, "failure");
      assert.match(result.textResultForLlm, /output.*symlink/i);
    }

    await assert.rejects(readFile(invoked), { code: "ENOENT" });
    await assert.rejects(readFile(join(outside, "missing.mp4")), { code: "ENOENT" });
    assert.equal(await readFile(join(outside, "existing.mp4"), "utf8"), "outside source");
  } finally { await fixture.cleanup(); }
});

test("validated canonical parents give aliases one recording identity", { skip: process.platform === "win32" }, async () => {
  const fixture = await setup();
  let recording: RecordingState | undefined;

  try {
    const directory = join(fixture.runtime.cwd, "real");

    await mkdir(directory);
    await symlink(directory, join(fixture.runtime.cwd, "alias"));
    recording = await start(fixture.runtime, "alias/raw.mp4");
    assert.equal(recording.output, join(directory, "raw.mp4"));

    const current = await call(fixture.runtime, "screen_record_status", { output: "real/raw.mp4" });

    assert.equal(current.resultType, "success", current.textResultForLlm);
    assert.deepEqual(state(current.textResultForLlm).status, "recording");

    const value = state(current.textResultForLlm);

    assert.ok("recordingId" in value && "recordingId" in recording);
    assert.equal(value.recordingId, recording.recordingId);
  } finally {
    if (recording) await stop(fixture.runtime, recording);
    await fixture.cleanup();
  }
});

test("confirmed worker spawn failure preserves its error, removes its owned lock, and permits retry", { skip: process.platform === "win32" }, async () => {
  const fixture = await setup();
  let recording: RecordingState | undefined;

  try {
    const output = resolve(fixture.runtime.cwd, "spawn-failure.mp4");
    const id = createHash("sha256").update(output).digest("hex").slice(0, 16);
    const lock = join(fixture.runtime.env.TMPDIR!, "scarypilot-screen-record", `${id}.lock`);

    const failing: RecorderRuntime = {
      ...fixture.runtime,
      script: fileURLToPath(new URL("./fixtures/spawn-failure.mjs", import.meta.url)),
      env: { ...fixture.runtime.env, RECORDER_FIXTURE_SCRIPT: script },
    };

    const result = await call(failing, "screen_record_start", { output, captureApproved: true, videoInput: "0" });

    assert.equal(result.resultType, "failure");
    assert.match(result.textResultForLlm, /could not start detached recording worker: fixture worker spawn failed with EAGAIN/);
    assert.equal(await readFile(`${output}.spawn-attempt`, "utf8"), "no worker created");
    await assert.rejects(readFile(output), { code: "ENOENT" });
    await assert.rejects(readFile(lock), { code: "ENOENT" });

    const current = await call(fixture.runtime, "screen_record_status", { output });

    assert.equal(state(current.textResultForLlm).status, "not-recording");
    recording = await start(fixture.runtime, output);
  } finally {
    if (recording) await stop(fixture.runtime, recording);
    await fixture.cleanup();
  }
});

test("spawn failure never removes a lock whose owner changed", { skip: process.platform === "win32" }, async () => {
  const fixture = await setup();

  try {
    const output = resolve(fixture.runtime.cwd, "replaced-lock.mp4");
    const id = createHash("sha256").update(output).digest("hex").slice(0, 16);
    const lock = join(fixture.runtime.env.TMPDIR!, "scarypilot-screen-record", `${id}.lock`);

    const failing: RecorderRuntime = {
      ...fixture.runtime,
      script: fileURLToPath(new URL("./fixtures/spawn-failure.mjs", import.meta.url)),
      env: { ...fixture.runtime.env, RECORDER_FIXTURE_SCRIPT: script, RECORDER_FIXTURE_REPLACE_LOCK: "1" },
    };

    const result = await call(failing, "screen_record_start", { output, captureApproved: true, videoInput: "0" });

    assert.equal(result.resultType, "failure");
    assert.match(result.textResultForLlm, /fixture worker spawn failed with EAGAIN/);
    assert.equal(await readFile(lock, "utf8"), "replacement-owner");
    await assert.rejects(readFile(output), { code: "ENOENT" });
  } finally { await fixture.cleanup(); }
});

test("an interrupted startup lock is actionable and never silently replaced", { skip: process.platform === "win32" }, async () => {
  const fixture = await setup();

  try {
    const output = resolve(fixture.runtime.cwd, "pending.mp4");
    const id = createHash("sha256").update(output).digest("hex").slice(0, 16);
    const directory = join(fixture.runtime.env.TMPDIR!, "scarypilot-screen-record");
    const lock = join(directory, `${id}.lock`);

    await mkdir(directory);
    await writeFile(lock, "interrupted-start");

    const current = await call(fixture.runtime, "screen_record_status", { output });

    assert.equal(current.resultType, "failure");
    assert.match(current.textResultForLlm, /pending or interrupted/);

    const duplicate = await call(fixture.runtime, "screen_record_start", { output, captureApproved: true, videoInput: "0" });

    assert.equal(duplicate.resultType, "failure");
    assert.match(duplicate.textResultForLlm, /cannot claim recording startup/);
    assert.equal(await readFile(lock, "utf8"), "interrupted-start");
  } finally { await fixture.cleanup(); }
});

test("diagnostic timeout and device failures are failures, not empty success", { skip: process.platform === "win32" }, async () => {
  const fixture = await setup("diagnostic-timeout");

  try {
    const started = Date.now();
    const timeout = await call(fixture.runtime, "screen_record_doctor", {});
    assert.equal(timeout.resultType, "failure");
    assert.ok(Date.now() - started < 6000);
    fixture.runtime.env.RECORDER_FIXTURE_MODE = "device-failure";

    if (process.platform !== "linux") {
      const failed = await call(fixture.runtime, "screen_record_devices", {});
      assert.equal(failed.resultType, "failure");
      assert.match(failed.textResultForLlm, /enumeration failed/);
    }
  } finally { await fixture.cleanup(); }
});

test("timed-out command does not kill the detached worker; graceful stop timeout can be retried", { skip: process.platform === "win32" }, async () => {
  const fixture = await setup("slow-stop");
  let recording: RecordingState | undefined;

  try {
    const delayed = join(fixture.root, "delayed-cli.mjs");
    await writeFile(delayed, `import { spawnSync } from "node:child_process";
const result = spawnSync(process.execPath, [${JSON.stringify(script)}, ...process.argv.slice(2)], { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
setTimeout(() => process.exit(0), 5000);
`);
    await assert.rejects(runRecorder({ ...fixture.runtime, script: delayed }, ["start", "--output", resolve(fixture.runtime.cwd, "raw.mp4"), "--video-input", "0"], 1000, RecordingStateSchema), /run screen_record_status/);
    const current = await call(fixture.runtime, "screen_record_status", { output: "raw.mp4" });
    recording = state(current.textResultForLlm);
    assert.equal(recording.status, "recording");
    const timeout = await stop(fixture.runtime, recording, 0.1);
    assert.equal(timeout.resultType, "failure");
    assert.match(timeout.textResultForLlm, /No process was killed/);
    const stopping = await call(fixture.runtime, "screen_record_status", { output: "raw.mp4" });
    assert.equal(state(stopping.textResultForLlm).status, "stopping");
    const final = await stop(fixture.runtime, recording);
    assert.equal(final.resultType, "success", final.textResultForLlm);
  } finally {
    if (recording) await stop(fixture.runtime, recording);
    await fixture.cleanup();
  }
});

test("persisted stale and corrupt states are diagnosed without signalling arbitrary processes", { skip: process.platform === "win32" }, async () => {
  const fixture = await setup();

  try {
    const output = resolve(fixture.runtime.cwd, "raw.mp4");
    const id = createHash("sha256").update(output).digest("hex").slice(0, 16);
    const directory = join(fixture.runtime.env.TMPDIR!, "scarypilot-screen-record");
    await mkdir(directory);
    const statePath = join(directory, `${id}.json`);
    await writeFile(statePath, JSON.stringify({
      status: "recording", output, workerPid: process.pid, ffmpegPid: process.pid,
      recordingId: "stale-id", startedAt: "2000-01-01T00:00:00.000Z",
      updatedAt: "2000-01-01T00:00:00.000Z", statePath, logPath: join(directory, `${id}.log`),
    }));
    const stale = await call(fixture.runtime, "screen_record_status", { output });
    assert.equal(state(stale.textResultForLlm).status, "stale");
    const stopped = await call(fixture.runtime, "screen_record_stop", { output, recordingId: "stale-id" });
    assert.equal(stopped.resultType, "failure");
    assert.match(stopped.textResultForLlm, /stale/);
    await writeFile(statePath, '{"status":"recording","workerPid":-1}');
    const corrupt = await call(fixture.runtime, "screen_record_status", { output });
    assert.equal(corrupt.resultType, "failure");
    assert.match(corrupt.textResultForLlm, /invalid recording state/);
  } finally { await fixture.cleanup(); }
});

test("SDK invocation cancellation ends only the command wait, not the detached recording", { skip: process.platform === "win32" }, async () => {
  const fixture = await setup();
  let recording: RecordingState | undefined;

  try {
    const delayed = join(fixture.root, "delayed-cli.mjs");

    await writeFile(delayed, `import { spawnSync } from "node:child_process";
const result = spawnSync(process.execPath, [${JSON.stringify(script)}, ...process.argv.slice(2)], { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
setTimeout(() => process.exit(0), 5000);
`);

    const controller = new AbortController();

    const pending = call({ ...fixture.runtime, script: delayed }, "screen_record_start", {
      output: "cancelled.mp4", captureApproved: true, videoInput: "0",
    }, controller.signal);

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const current = await call(fixture.runtime, "screen_record_status", { output: "cancelled.mp4" });

      if (current.resultType === "success") {
        const value = state(current.textResultForLlm);

        if (value.status === "recording") {
          recording = value;
          break;
        }
      }

      await sleep(20);
    }

    assert.ok(recording);
    controller.abort();

    const cancelled = await pending;

    assert.equal(cancelled.resultType, "failure");
    assert.match(cancelled.textResultForLlm, /Detached recordings are not killed/);

    const current = await call(fixture.runtime, "screen_record_status", { output: "cancelled.mp4" });

    assert.equal(state(current.textResultForLlm).status, "recording");

    const final = await stop(fixture.runtime, recording);

    assert.equal(final.resultType, "success", final.textResultForLlm);
  } finally {
    if (recording) await stop(fixture.runtime, recording);
    await fixture.cleanup();
  }
});

test("concurrent CLI starts cannot replace startup ownership", { skip: process.platform === "win32" }, async () => {
  const fixture = await setup();
  let recording: RecordingState | undefined;

  try {
    const results = await Promise.all([
      call(fixture.runtime, "screen_record_start", { output: "raw.mp4", captureApproved: true, videoInput: "0" }),
      call(fixture.runtime, "screen_record_start", { output: "raw.mp4", captureApproved: true, videoInput: "0" }),
    ]);

    assert.equal(results.filter((result) => result.resultType === "success").length, 1);
    const success = results.find((result) => result.resultType === "success");
    assert.ok(success);
    recording = state(success.textResultForLlm);
    const final = await stop(fixture.runtime, recording);
    assert.equal(final.resultType, "success", final.textResultForLlm);
  } finally {
    if (recording) await stop(fixture.runtime, recording);
    await fixture.cleanup();
  }
});

test("standalone CLI remains usable and capture errors retain actionable logs", { skip: process.platform === "win32" }, async () => {
  const fixture = await setup("capture-failure");

  try {
    const result = await call(fixture.runtime, "screen_record_start", { output: "raw.mp4", captureApproved: true, videoInput: "0" });
    assert.equal(result.resultType, "failure");
    assert.match(result.textResultForLlm, /fixture capture denied by OS permission/);
    const current = await call(fixture.runtime, "screen_record_status", { output: "raw.mp4" });
    assert.equal(state(current.textResultForLlm).status, "failed");

    const help = await new Promise<string>((accept, reject) => {
      const child = spawn(process.execPath, [script, "help"], { env: fixture.runtime.env });
      let text = "";
      child.stdout.on("data", (chunk) => { text += chunk; });
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? accept(text) : reject(new Error(`help exit ${code}`)));
    });

    assert.match(help, /narrate/);
    assert.match(help, /side-by-side/);
  } finally { await fixture.cleanup(); }
});
