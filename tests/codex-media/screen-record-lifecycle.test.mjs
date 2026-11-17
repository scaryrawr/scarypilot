import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, test } from "node:test";

const script = fileURLToPath(new URL("../../plugins/screen-record/skills/screen-record/scripts/screen-record.mjs", import.meta.url));

const preload = pathToFileURL(fileURLToPath(new URL("./fixtures/recorder-spawn.mjs", import.meta.url))).href;

const fixtures = [];

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function running(pid) {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function fixture(environment = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "screen-lifecycle-")));
  const output = path.join(root, "raw.mp4");

  const environmentForRun = {
    ...process.env, NODE_OPTIONS: `--import=${preload}`,
    TMPDIR: root, TMP: root, TEMP: root, OMLX_BASE_URL: "http://127.0.0.1:1", OMLX_API_KEY: "",
    ...environment,
  };

  const recordings = [];

  const invoke = (command, options = [], extra = {}) => spawnSync("node",
    [script, command, "--output", output, ...options], {
      encoding: "utf8", timeout: 20_000, env: { ...environmentForRun, ...extra },
    });

  const start = (options = []) => {
    const result = invoke("start", ["--video-input", "0", ...options]);
    assert.equal(result.status, 0, result.stderr);
    const state = JSON.parse(result.stdout);
    recordings.push(state);

    return state;
  };

  const value = { root, output, invoke, start, recordings, environmentForRun };
  fixtures.push(value);

  return value;
}

function discoveryPath(state) {
  const suffix = `.${state.recordingId}.json`;

  return state.statePath.endsWith(suffix) ? state.statePath.slice(0, -suffix.length) : state.statePath;
}

async function legacyRecording({ root, output, recordings, environmentForRun }) {
  const legacyRoot = path.join(root, "scarypilot-screen-record");
  await mkdir(legacyRoot, { mode: 0o700 });
  const key = createHash("sha256").update(output).digest("hex").slice(0, 16);

  const config = {
    output, state: path.join(legacyRoot, `${key}.json`),
    stop: path.join(legacyRoot, `${key}.stop`), log: path.join(legacyRoot, `${key}.log`),
  };

  const legacyScript = fileURLToPath(new URL("./fixtures/legacy-recorder.mjs", import.meta.url));

  const started = spawnSync("node", [legacyScript, "start", JSON.stringify(config)], {
    env: environmentForRun, encoding: "utf8", timeout: 20_000,
  });

  assert.equal(started.status, 0, started.stderr);
  const state = JSON.parse(started.stdout);
  recordings.push(state);

  return state;
}

afterEach(async () => {
  for (const { root, invoke, recordings } of fixtures.splice(0)) {
    for (const recording of recordings) {
      invoke("stop", [
        ...(recording.recordingId ? ["--recording-id", recording.recordingId] : []),
        "--timeout", "2",
      ]);

      for (let attempt = 0; attempt < 30 && running(recording.ffmpegPid); attempt++) await delay(100);
      assert.equal(running(recording.ffmpegPid), false, "Fixture FFmpeg must exit before cleanup");
    }

    await rm(root, { recursive: true, force: true });
  }
});

test("start rejects a dangling output symlink before creating recording state", async () => {
  const { root, output, invoke } = await fixture({ RECORDER_FIXTURE_MODE: "capture-failure" });
  const target = path.join(root, "missing.mp4");
  await symlink(target, output);
  const result = invoke("start", ["--video-input", "0"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /output already exists/);
  assert.equal(result.stdout, "");
  assert.equal((await lstat(output)).isSymbolicLink(), true);
  await assert.rejects(stat(target), { code: "ENOENT" });
  assert.deepEqual(await readdir(root), ["raw.mp4"]);
});

test("actual CLI persists recording identity across callers and retains idempotent final state", async () => {
  const { output, invoke, start } = await fixture({ RECORDER_FIXTURE_MODE: "argument-contract" });
  const state = start();
  assert.ok(state.recordingId);
  assert.equal(state.status, "recording");
  assert.equal(running(state.workerPid), true);
  assert.equal(running(state.ffmpegPid), true);
  const status = invoke("status", ["--recording-id", state.recordingId]);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).recordingId, state.recordingId);
  const argumentsUsed = JSON.parse(await readFile(`${output}.args.json`, "utf8"));
  assert.ok(argumentsUsed.includes("-n"));
  assert.equal(argumentsUsed.includes("-y"), false);
  const stopped = invoke("stop", ["--recording-id", state.recordingId]);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(JSON.parse(stopped.stdout).status, "stopped");
  const persisted = JSON.parse(await readFile(state.statePath, "utf8"));
  assert.equal(persisted.status, "stopped");
  assert.equal(persisted.recordingId, state.recordingId);
  const repeated = invoke("stop", ["--recording-id", state.recordingId]);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.deepEqual(JSON.parse(repeated.stdout), persisted);
  assert.equal(await readFile(output, "utf8"), "fixture raw recording");
});

test("recording references reject invalid, missing or mismatched generation state", async () => {
  const { invoke, start } = await fixture();
  const state = start();
  const stopped = invoke("stop", ["--recording-id", state.recordingId]);
  assert.equal(stopped.status, 0, stopped.stderr);
  const sharedState = discoveryPath(state);
  const referenceBytes = await readFile(sharedState, "utf8");
  const stateBytes = await readFile(state.statePath, "utf8");

  try {
    for (const [reference, error] of [
      [{ kind: "recording-reference", recordingId: "../outside" }, /unsupported recording reference/],
      [{ kind: "recording-reference", recordingId: state.recordingId, path: "/outside" }, /unsupported recording reference/],
      [{ kind: "recording-reference", recordingId: randomUUID() }, /referenced recording state is missing/],
    ]) {
      await writeFile(sharedState, JSON.stringify(reference));
      const result = invoke("status");
      assert.equal(result.status, 1);
      assert.match(result.stderr, error);
    }

    await writeFile(sharedState, referenceBytes);
    await writeFile(state.statePath, JSON.stringify({ ...state, recordingId: randomUUID() }));
    const mismatch = invoke("status");
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /reference identity does not match/);
  } finally {
    await writeFile(sharedState, referenceBytes);
    await writeFile(state.statePath, stateBytes);
  }
});

test("ID-less legacy recordings stop after their worker removes state", { skip: process.platform === "win32" }, async () => {
  const context = await fixture();
  const { output, invoke } = context;
  const state = await legacyRecording(context);
  assert.equal(state.recordingId, undefined);
  assert.equal(JSON.parse(invoke("status").stdout).status, "recording");
  const stopped = invoke("stop");
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.deepEqual(JSON.parse(stopped.stdout), { status: "stopped", output });
  assert.equal(running(state.workerPid), false);
  assert.equal(running(state.ffmpegPid), false);
  assert.equal(JSON.parse(invoke("status").stdout).status, "not-recording");
});

for (const operation of ["stat", "read"]) {
  test(`legacy state deletion during ${operation} recovers, but permission errors remain explicit`,
    { skip: process.platform === "win32" }, async () => {
      const deniedContext = await fixture();
      await legacyRecording(deniedContext);
      const denied = deniedContext.invoke("stop", [], { RECORDER_FIXTURE_MODE: `legacy-state-${operation}-EACCES` });
      assert.equal(denied.status, 1);
      assert.match(denied.stderr, /invalid recording state.*fixture state.*failed/);
      const context = await fixture();
      const state = await legacyRecording(context);
      const stopped = context.invoke("stop", [], { RECORDER_FIXTURE_MODE: `legacy-state-${operation}-ENOENT` });
      assert.equal(stopped.status, 0, stopped.stderr);
      assert.deepEqual(JSON.parse(stopped.stdout), { status: "stopped", output: context.output });
      assert.equal(running(state.workerPid), false);
      assert.equal(running(state.ffmpegPid), false);
    });
}

test("wrong or missing identity cannot stop an active or finalized replacement recording", async () => {
  const { invoke, start } = await fixture();
  const state = start();

  for (const options of [[], ["--recording-id", "replacement"]]) {
    const result = invoke("stop", options);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /identity does not match/);
    assert.equal(running(state.ffmpegPid), true);
  }

  const mismatch = invoke("status", ["--recording-id", "replacement"]);
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /do not adopt a replacement/);
  const stopped = invoke("stop", ["--recording-id", state.recordingId]);
  assert.equal(stopped.status, 0, stopped.stderr);
  const wrongFinal = invoke("stop", ["--recording-id", "replacement"]);
  assert.equal(wrongFinal.status, 1);
});

test("graceful timeout never kills the recording and later stop finalizes with the same ID", async () => {
  const { invoke, start } = await fixture({ RECORDER_FIXTURE_MODE: "slow-stop" });
  const state = start();
  const timeout = invoke("stop", ["--recording-id", state.recordingId, "--timeout", "0.1"]);
  assert.equal(timeout.status, 1);
  assert.match(timeout.stderr, /timed out.*No process was killed/);
  assert.equal(running(state.ffmpegPid), true);
  const status = invoke("status", ["--recording-id", state.recordingId]);
  assert.equal(JSON.parse(status.stdout).status, "stopping");
  await delay(1400);
  const final = invoke("stop", ["--recording-id", state.recordingId]);
  assert.equal(final.status, 0, final.stderr);
  assert.equal(JSON.parse(final.stdout).status, "stopped");
});

test("status is read-only for stale state and startup locks cannot trigger an automatic retry", async () => {
  const { root, output, invoke } = await fixture();
  const initial = invoke("status");
  assert.equal(JSON.parse(initial.stdout).status, "not-recording");
  const directory = (await readdir(root)).find((name) => name.startsWith("scarypilot-screen-record"));
  assert.ok(directory);
  const id = createHash("sha256").update(output).digest("hex").slice(0, 16);
  const statePath = path.join(root, directory, `${id}.json`);
  const logPath = path.join(root, directory, `${id}.log`);

  const stale = {
    status: "recording", output, recordingId: "stale-identity", workerPid: process.pid, ffmpegPid: process.pid,
    startedAt: "2000-01-01T00:00:00Z", updatedAt: "2000-01-01T00:00:00Z", statePath, logPath,
  };

  const bytes = JSON.stringify(stale);
  await writeFile(statePath, bytes);
  const result = invoke("status", ["--recording-id", stale.recordingId]);
  assert.equal(JSON.parse(result.stdout).status, "stale");
  assert.equal(await readFile(statePath, "utf8"), bytes);
  assert.match(invoke("start", ["--video-input", "0"]).stderr, /stale recording state/);
  assert.match(invoke("stop", ["--recording-id", stale.recordingId]).stderr, /stale/);
  await rm(statePath);
  await writeFile(statePath.replace(/\.json$/, ".lock"), "interrupted-start");
  const pending = invoke("status");
  assert.equal(pending.status, 1);
  assert.match(pending.stderr, /startup is pending or interrupted/);
  assert.match(invoke("start", ["--video-input", "0"]).stderr, /cannot claim recording startup/);
});

test("worker startup failures retain identity and explicit error state without capture or success output", async () => {
  const { root, invoke } = await fixture({ RECORDER_FIXTURE_MODE: "capture-failure" });
  const result = invoke("start", ["--video-input", "0"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /failed to start.*fixture capture denied/s);
  assert.equal(result.stdout, "");
  const status = invoke("status");
  const state = JSON.parse(status.stdout);
  assert.equal(state.status, "failed");
  assert.ok(state.recordingId);
  assert.equal(state.exitCode, 3);
  assert.match(await readFile(state.logPath, "utf8"), /fixture capture denied/);
  const entries = await readdir(path.dirname(state.statePath));
  assert.equal(entries.some((entry) => entry.endsWith(".lock")), false);
  assert.ok((await stat(root)).isDirectory());
});

test("replacement ownership cannot be overwritten by the original worker or adopted during stop", async () => {
  const { invoke, start } = await fixture();
  const state = start();
  const replacement = { ...state, recordingId: "replacement-identity", status: "stopped", endedAt: new Date().toISOString(), exitCode: 0 };
  const sharedState = discoveryPath(state);
  await writeFile(sharedState.replace(/\.json$/, ".lock"), replacement.recordingId);
  await writeFile(sharedState, JSON.stringify(replacement));
  const stop = invoke("stop", ["--recording-id", state.recordingId]);
  assert.equal(stop.status, 1);
  assert.match(stop.stderr, /identity does not match/);
  await delay(400);
  assert.equal(JSON.parse(await readFile(sharedState, "utf8")).recordingId, replacement.recordingId);
  assert.equal(await readFile(sharedState.replace(/\.json$/, ".lock"), "utf8"), replacement.recordingId);
});

for (const publicationStatus of ["recording", "stopped"]) {
  for (const reference of [false, true]) {
    test(`a ${reference ? "referenced" : "direct"} replacement survives an old ${publicationStatus} publication rename`, async () => {
      const context = await fixture();
      const marker = path.join(context.root, "publication-race");
      context.environmentForRun.RECORDER_FIXTURE_PUBLICATION_MARKER = marker;
      const state = context.start();
      const sharedState = discoveryPath(state);
      const recordingId = randomUUID();

      const replacement = {
        ...state, recordingId, status: "stopped", endedAt: new Date().toISOString(), exitCode: 0,
        statePath: reference ? `${sharedState}.${recordingId}.json` : sharedState,
      };

      const bytes = JSON.stringify(replacement);

      const discoveryBytes = reference
        ? JSON.stringify({ kind: "recording-reference", recordingId }) : bytes;

      if (reference) await writeFile(replacement.statePath, bytes);
      await writeFile(marker, JSON.stringify({
        publicationStatus, recordingId, discoveryPath: sharedState, discoveryBytes,
        lockPath: sharedState.replace(/\.json$/, ".lock"),
      }));

      if (publicationStatus === "stopped") context.invoke("stop", ["--recording-id", state.recordingId]);

      for (let attempt = 0; attempt < 40 && running(state.workerPid); attempt++) await delay(100);
      assert.equal(running(state.workerPid), false, "Original worker must exit after replacement");
      assert.ok(await readFile(`${marker}.triggered`, "utf8"));
      assert.equal(await readFile(sharedState, "utf8"), discoveryBytes);
      assert.equal(await readFile(replacement.statePath, "utf8"), bytes);
      assert.equal(await readFile(sharedState.replace(/\.json$/, ".lock"), "utf8"), recordingId);
      const current = context.invoke("status");
      assert.equal(current.status, 0, current.stderr);
      assert.equal(JSON.parse(current.stdout).recordingId, recordingId);
    });
  }
}

test("a replacement appearing during stop is detected before polling or returning its state", async () => {
  const { invoke, start } = await fixture();
  const state = start();
  const stopped = invoke("stop", ["--recording-id", state.recordingId], { RECORDER_FIXTURE_MODE: "stop-replacement" });
  assert.equal(stopped.status, 1);
  assert.match(stopped.stderr, /identity changed during stop.*replacement state was preserved/);
  await delay(400);
  assert.equal(JSON.parse(await readFile(discoveryPath(state), "utf8")).recordingId, "replacement-during-stop");
});

test("capture-only doctor and device discovery are bounded offline probes, not permission checks", async () => {
  const { invoke } = await fixture();
  const doctor = invoke("doctor", ["--capture-only"]);
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.equal(JSON.parse(doctor.stdout).permissionsVerified, false);
  const devices = invoke("devices", ["--json"]);
  assert.equal(devices.status, 0, devices.stderr);
  assert.equal(JSON.parse(devices.stdout).permissionsVerified, false);
  const overflow = invoke("doctor", ["--capture-only"], { RECORDER_FIXTURE_MODE: "diagnostic-timeout" });
  assert.equal(overflow.status, 1);
  assert.match(overflow.stderr, /could not check ffmpeg/);
});

test("simulated Windows discovery derives selection IDs and rejects stale or conflicting window captures", async () => {
  const window = {
    hwnd: "0x1234", processId: 123, processStartTime: "100", threadId: 456, className: "Fixture",
    title: "Fixture window", processName: "Fixture", clientWidth: 321, clientHeight: 181,
    windowLeft: 1, windowTop: 2, windowWidth: 340, windowHeight: 220, foreground: false,
  };

  const snapshot = JSON.stringify({ windows: [window], uninspectableCount: 0 });

  const { output, invoke, recordings } = await fixture({
    RECORDER_FIXTURE_DISCOVERY_PLATFORM: "win32", RECORDER_FIXTURE_WINDOWS_JSON: snapshot,
    RECORDER_FIXTURE_MODE: "argument-contract",
  });

  const listed = invoke("windows", ["--json"]);
  assert.equal(listed.status, 0, listed.stderr);
  const result = JSON.parse(listed.stdout);
  assert.equal(result.permissionsVerified, false);
  const windowId = result.windows[0].windowId;
  assert.match(windowId, /^w1_[A-Za-z0-9_-]{43}$/);
  const restricted = invoke("windows", ["--json"], { RECORDER_FIXTURE_MODE: "powershell-restricted" });
  assert.equal(restricted.status, 1);
  assert.match(restricted.stderr, /Restricted execution policy/);

  for (const options of [["--window-id", "invalid"], ["--window-id", windowId, "--region", "1,2,100,100"]]) {
    assert.equal(invoke("start", options).status, 1);
  }

  const stale = invoke("start", ["--window-id", windowId], { RECORDER_FIXTURE_WINDOWS_JSON: JSON.stringify({ windows: [], uninspectableCount: 0 }) });
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /stale or unavailable/);
  const started = invoke("start", ["--window-id", windowId]);
  assert.equal(started.status, 0, started.stderr);
  const state = JSON.parse(started.stdout);
  recordings.push(state);
  const args = JSON.parse(await readFile(`${output}.args.json`, "utf8"));
  assert.ok(args.includes("hwnd=0x1234"));
  assert.ok(args.includes("pad=ceil(iw/2)*2:ceil(ih/2)*2"));
});
