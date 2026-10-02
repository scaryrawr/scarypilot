import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, cp, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { basename, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { createRecordingTools, runRecorder, type RecorderRuntime } from "../src/tools.ts";
import { RecordingStateSchema, type RecordingState } from "../src/domain.ts";

const script = fileURLToPath(new URL("../../../skills/screen-record/scripts/screen-record.mjs", import.meta.url));

const mediaPreload = new URL("./fixtures/media-subprocess.mjs", import.meta.url).href;

const invocation = { sessionId: "fixture", toolCallId: "fixture", toolName: "fixture" };

function stateId(output: string) {
  return createHash("sha256").update(process.platform === "win32" ? output.toLowerCase() : output).digest("hex").slice(0, 16);
}

function stateDirectoryName(ownershipKnown = !!process.getuid) {
  const user = ownershipKnown && process.getuid ? String(process.getuid()) :
    createHash("sha256").update(`${userInfo().username}\0${userInfo().homedir}`).digest("hex").slice(0, 16);

  return `scarypilot-screen-record-${user}`;
}

async function setup(mode = "") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "screen-record-test-")));
  const cwd = join(root, "workspace");
  const temporary = join(root, "temporary");
  await Promise.all([mkdir(cwd), mkdir(temporary)]);

  const runtime: RecorderRuntime = {
    script, cwd: await realpath(cwd),
    env: {
      ...process.env,
      NODE_OPTIONS: `--import=${mediaPreload}`,
      TMPDIR: temporary, TMP: temporary, TEMP: temporary,
      DISPLAY: ":fixture", RECORDER_FIXTURE_MODE: mode,
    },
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

function fixtureWindows(count = 2) {
  return Array.from({ length: count }, (_, index) => ({
    hwnd: `0x${(index + 1).toString(16)}`,
    processId: 4321,
    processStartTime: "133999999999999999",
    threadId: 100 + index,
    className: "DemoWindow",
    title: index < 2 ? `Demo — Same title ' " --help\r\n` : `Demo window ${index + 1}`,
    processName: "Demo",
    clientWidth: 800 + index,
    clientHeight: 600,
    windowLeft: -100 + index * 20,
    windowTop: 40 + index * 20,
    windowWidth: 820 + index,
    windowHeight: 640,
    foreground: index === 0,
  }));
}

function setWindowsFixture(runtime: RecorderRuntime, windows: ReturnType<typeof fixtureWindows>) {
  runtime.env.RECORDER_FIXTURE_WINDOWS_JSON = JSON.stringify({ windows, uninspectableCount: 0 });
}

test("bundle writes preserve CRLF manifests and stale helper contents are rejected", async () => {
  const fixture = await setup();

  try {
    const copiedPlugin = join(fixture.root, "plugin");

    await cp(fileURLToPath(new URL("../../../", import.meta.url)), copiedPlugin, {
      recursive: true,
      filter: (source) => basename(source) !== "node_modules",
    });

    const extension = join(copiedPlugin, "extensions", "screen-record");

    const manifest = join(extension, "bundle-manifest.json");

    await writeFile(manifest, (await readFile(manifest, "utf8")).replace(/\r\n/g, "\n").replace(/\n/g, "\r\n"));

    const runBundleCheck = (mode: "check" | "write" = "check") => spawnSync(
      process.execPath, [join(extension, "tools", "check-bundle.mjs"), mode], {
        encoding: "utf8",
        timeout: 10000,
        windowsHide: true,
      });

    const fresh = runBundleCheck();

    assert.ifError(fresh.error);
    assert.equal(fresh.status, 0, fresh.stderr);

    const recorded = runBundleCheck("write");

    assert.ifError(recorded.error);
    assert.equal(recorded.status, 0, recorded.stderr);

    const rewrittenManifest = await readFile(manifest, "utf8");

    assert.ok(rewrittenManifest.includes("\r\n"));
    assert.equal(rewrittenManifest.replace(/\r\n/g, "").includes("\n"), false);

    await appendFile(join(copiedPlugin, "skills", "screen-record", "scripts", "screen-record.mjs"), "\n");

    const stale = runBundleCheck();

    assert.ifError(stale.error);
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /Stale bundle/);
  } finally { await fixture.cleanup(); }
});

test("diagnostics and device discovery return bounded typed results without capture or narration", async () => {
  const fixture = await setup();

  try {
    for (const name of ["screen_record_doctor", "screen_record_devices"]) {
      const result = await call(fixture.runtime, name, {});
      assert.equal(result.resultType, "success", result.textResultForLlm);
      const diagnostic = JSON.parse(result.textResultForLlm);

      assert.equal(diagnostic.permissionsVerified, false);
      assert.equal(diagnostic.platform, process.platform);
      assert.ok(process.platform === "darwin" || process.platform === "linux" || process.platform === "win32");
      assert.equal(diagnostic.captureDevice, name === "screen_record_devices" && process.platform === "win32"
        ? "dshow"
        : { darwin: "avfoundation", linux: "x11grab", win32: "gdigrab" }[process.platform]);

      if (name === "screen_record_doctor") {
        assert.equal(diagnostic.captureAvailable, true);
      } else if (process.platform === "linux") {
        assert.match(diagnostic.listing, /DISPLAY=:fixture/);
      } else {
        assert.match(diagnostic.listing, /Fixture screen|Fixture audio/);
      }
    }

    const idle = await call(fixture.runtime, "screen_record_status", { output: "raw.mp4" });
    assert.equal(state(idle.textResultForLlm).status, "not-recording");
  } finally { await fixture.cleanup(); }
});

test("recording survives command return and a new tool instance; stop is graceful and idempotent", async () => {
  const fixture = await setup("log-close-delay");
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

test("standalone stop requires the retained ID before requesting stop or returning terminal state", async () => {
  const fixture = await setup();
  let recording: RecordingState | undefined;

  try {
    const original = await start(fixture.runtime);

    recording = original;
    assert.equal((await stop(fixture.runtime, original)).resultType, "success");
    await rm(original.output);
    recording = await start(fixture.runtime);
    assert.ok("recordingId" in recording && recording.recordingId && "statePath" in recording);
    assert.notEqual(recording.recordingId, original.recordingId);

    for (const id of [undefined, original.recordingId]) {
      const result = spawnSync(process.execPath, [
        script, "stop", "--output", recording.output,
        ...(id ? ["--recording-id", id] : []),
      ], {
        cwd: fixture.runtime.cwd, env: fixture.runtime.env,
        encoding: "utf8", timeout: 5000, windowsHide: true,
      });

      assert.ifError(result.error);
      assert.notEqual(result.status, 0, "a delayed caller must not stop the replacement");
      assert.match(result.stderr, /recording identity does not match/);
      await assert.rejects(readFile(recording.statePath.replace(/\.json$/, ".stop")), { code: "ENOENT" });
      assert.equal(await readFile(recording.statePath.replace(/\.json$/, ".lock"), "utf8"), recording.recordingId);
      const current = await call(fixture.runtime, "screen_record_status", { output: recording.output });

      assert.equal(state(current.textResultForLlm).status, "recording");
    }

    const missingNative = await call(fixture.runtime, "screen_record_stop", { output: recording.output });

    assert.equal(missingNative.resultType, "failure");
    assert.match(missingNative.textResultForLlm, /recordingId/);

    const stopped = await runRecorder(fixture.runtime, [
      "stop", "--output", recording.output, "--recording-id", recording.recordingId,
    ], 5000, RecordingStateSchema);

    assert.equal(stopped.status, "stopped");

    await assert.rejects(runRecorder(fixture.runtime, [
      "stop", "--output", recording.output,
    ], 5000, RecordingStateSchema), /recording identity does not match/);

    const repeated = await runRecorder(fixture.runtime, [
      "stop", "--output", recording.output, "--recording-id", recording.recordingId,
    ], 5000, RecordingStateSchema);

    assert.deepEqual(repeated, stopped);
  } finally {
    if (recording) await stop(fixture.runtime, recording);
    await fixture.cleanup();
  }
});

test("standalone ID-less stop remains graceful only for genuinely ID-less legacy state", async () => {
  const fixture = await setup();
  const output = resolve(fixture.runtime.cwd, "legacy.mp4");
  const directory = join(fixture.runtime.env.TMPDIR!, process.getuid ? "scarypilot-screen-record" : stateDirectoryName());
  const statePath = join(directory, `${stateId(output)}.json`);
  const workerScript = fileURLToPath(new URL("./fixtures/legacy-worker.mjs", import.meta.url));
  let worker: ReturnType<typeof spawn> | undefined;
  let ended: Promise<void> | undefined;

  try {
    await mkdir(directory);
    worker = spawn(process.execPath, [workerScript, statePath, output], {
      env: fixture.runtime.env, stdio: "ignore", windowsHide: true,
    });

    ended = new Promise<void>((resolve, reject) => {
      worker!.once("error", reject);
      worker!.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Legacy fixture exited ${code}`)));
    });

    const deadline = Date.now() + 3000;

    while (true) {
      try {
        await readFile(statePath);
        break;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await sleep(50);
      }
    }

    const current = await call(fixture.runtime, "screen_record_status", { output });

    assert.equal(current.resultType, "success", current.textResultForLlm);
    assert.equal(state(current.textResultForLlm).status, "recording");
    assert.equal("recordingId" in JSON.parse(current.textResultForLlm), false);

    await assert.rejects(runRecorder(fixture.runtime, [
      "stop", "--output", output, "--recording-id", "unrelated-id",
    ], 5000, RecordingStateSchema), /recording identity does not match/);
    await assert.rejects(readFile(statePath.replace(/\.json$/, ".stop")), { code: "ENOENT" });

    const stopped = await runRecorder(fixture.runtime, ["stop", "--output", output], 5000, RecordingStateSchema);

    assert.equal(stopped.status, "stopped");
    assert.equal("recordingId" in stopped, false);
    assert.equal(await readFile(output, "utf8"), "legacy fixture recording");
    await ended;

    const repeated = await runRecorder(fixture.runtime, ["stop", "--output", output], 5000, RecordingStateSchema);

    assert.deepEqual(repeated, stopped);
  } finally {
    if (worker && worker.exitCode === null) {
      await writeFile(statePath.replace(/\.json$/, ".stop"), "fixture cleanup");
      await ended;
    }

    await fixture.cleanup();
  }
});

test("intent, paths, options, and existing sources are guarded before capture", async () => {
  const fixture = await setup();

  try {
    await writeFile(join(fixture.runtime.cwd, "source.mp4"), "original source");
    await symlink(fixture.root, join(fixture.runtime.cwd, "escape"), process.platform === "win32" ? "junction" : "dir");

    for (const input of [
      { output: "raw.mp4", videoInput: "0" },
      { output: "raw.mp4", captureApproved: true, audioDevice: "0", videoInput: "0" },
      { output: "../outside.mp4", captureApproved: true, videoInput: "0" },
      { output: "escape/outside.mp4", captureApproved: true, videoInput: "0" },
      { output: "source.mp4", captureApproved: true, videoInput: "0" },
      { output: "raw.mp4", captureApproved: true, fps: 121 },
      { output: "raw.mp4", captureApproved: true, videoInput: "--help" },
      { output: "raw.mp4", captureApproved: true, windowId: "title=Notepad" },
      { output: "raw.mp4", captureApproved: true, region: { x: 0, y: 0, width: 3, height: 2 } },
    ]) {
      const result = await call(fixture.runtime, "screen_record_start", input);
      assert.equal(result.resultType, "failure", JSON.stringify(input));
    }

    assert.equal(await readFile(join(fixture.runtime.cwd, "source.mp4"), "utf8"), "original source");
  } finally { await fixture.cleanup(); }
});

test("approved capture options map to the existing platform recorder without extra commands", async () => {
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
    } else if (process.platform === "linux") {
      assert.equal(value[value.indexOf("-i") + 1], "0+100,80");
      assert.equal(value[value.indexOf("-video_size") + 1], "1280x720");
      assert.ok(value.includes("pulse"));
    } else {
      assert.equal(value[value.indexOf("-f") + 1], "gdigrab");
      assert.equal(value[value.indexOf("-i") + 1], "desktop");
      assert.equal(value[value.indexOf("-offset_x") + 1], "100");
      assert.equal(value[value.indexOf("-offset_y") + 1], "80");
      assert.equal(value[value.indexOf("-video_size") + 1], "1280x720");
      assert.ok(value.includes("dshow"));
      assert.ok(value.includes("audio=1"));
    }
  } finally {
    if (recording) await stop(fixture.runtime, recording);
    await fixture.cleanup();
  }
});

test("missing filesystem roots fail bounded native and standalone path resolution", async () => {
  const fixture = await setup("missing-root");

  try {
    for (const args of [
      [script, "status", "--output", "missing/raw.mp4"],
      [script, "stop", "--output", "missing/raw.mp4"],
      ["--experimental-strip-types", fileURLToPath(new URL("./fixtures/missing-root-tool.mjs", import.meta.url))],
    ]) {
      const result = spawnSync(process.execPath, args, {
        cwd: fixture.runtime.cwd,
        env: { ...fixture.runtime.env, RECORDER_FIXTURE_SCRIPT: script },
        encoding: "utf8", timeout: 2000,
      });

      assert.ifError(result.error);
      assert.match(`${result.stderr}${result.stdout}`, /cannot resolve.*existing.*ancestor/i);

      if (args[0] === "--experimental-strip-types") {
        assert.equal(JSON.parse(result.stdout).resultType, "failure");
      } else {
        assert.notEqual(result.status, 0);
      }
    }
  } finally { await fixture.cleanup(); }
});

test("selected Windows window startup allows bounded slow worker revalidation", async () => {
  const fixture = await setup("window-slow-worker");
  let recording: RecordingState | undefined;

  try {
    setWindowsFixture(fixture.runtime, fixtureWindows());

    if (process.platform !== "win32") {
      const unavailable = await call(fixture.runtime, "screen_record_windows", {});

      assert.equal(unavailable.resultType, "failure");

      return;
    }

    const listed = await call(fixture.runtime, "screen_record_windows", {});

    const selected = JSON.parse(listed.textResultForLlm).windows[0].windowId;

    const started = await call(fixture.runtime, "screen_record_start", {
      output: "slow-window.mp4", captureApproved: true, windowId: selected,
    });

    assert.equal(started.resultType, "success", started.textResultForLlm);
    recording = state(started.textResultForLlm);
    assert.equal((await stop(fixture.runtime, recording)).resultType, "success");
  } finally {
    if (!recording && process.platform === "win32") {
      const current = await call(fixture.runtime, "screen_record_status", { output: "slow-window.mp4" });

      if (current.resultType === "success" && JSON.parse(current.textResultForLlm).status === "recording") {
        recording = state(current.textResultForLlm);
      }
    }

    if (recording) await stop(fixture.runtime, recording);
    await fixture.cleanup();
  }
});

test("Windows window discovery returns bounded selectable IDs without exposing handles", async () => {
  const fixture = await setup();

  try {
    setWindowsFixture(fixture.runtime, fixtureWindows(130));
    const result = await call(fixture.runtime, "screen_record_windows", {});

    if (process.platform !== "win32") {
      assert.equal(result.resultType, "failure");
      assert.match(result.textResultForLlm, /only supported on Windows/);

      return;
    }

    assert.equal(result.resultType, "success", result.textResultForLlm);
    const discovery = JSON.parse(result.textResultForLlm);
    const serialized = JSON.stringify(discovery);

    assert.equal(discovery.platform, "win32");
    assert.equal(discovery.windows.length, 128);
    assert.equal(discovery.truncated, true);
    assert.equal(discovery.uninspectableCount, 0);
    assert.equal(discovery.permissionsVerified, false);
    assert.equal(discovery.windows[0].title, discovery.windows[1].title);
    assert.notEqual(discovery.windows[0].windowId, discovery.windows[1].windowId);
    assert.match(discovery.windows[0].windowId, /^w1_[A-Za-z0-9_-]{43}$/);
    assert.ok(discovery.windows[0].title.includes("--help"));
    assert.ok(!/[\r\n]/.test(discovery.windows[0].title));
    assert.deepEqual(discovery.windows[1].bounds, { x: -80, y: 60, width: 821, height: 640 });
    assert.deepEqual(discovery.windows[1].clientArea, { width: 801, height: 600 });
    assert.equal(discovery.windows[0].foreground, true);
    assert.ok(!serialized.includes('"hwnd"'));
    assert.ok(!serialized.includes('"processStartTime"'));
    assert.ok(!serialized.includes("0x1"));
  } finally { await fixture.cleanup(); }
});

test("a selected Windows window reaches gdigrab by its opaque ID and stops normally", async () => {
  const fixture = await setup("argument-contract");
  let recording: RecordingState | undefined;

  try {
    setWindowsFixture(fixture.runtime, fixtureWindows());

    if (process.platform !== "win32") {
      const result = await call(fixture.runtime, "screen_record_start", {
        output: "window.mp4", captureApproved: true, windowId: `w1_${"a".repeat(43)}`,
      });

      assert.equal(result.resultType, "failure");
      assert.match(result.textResultForLlm, /only supported on Windows/);

      return;
    }

    const listed = await call(fixture.runtime, "screen_record_windows", {});

    assert.equal(listed.resultType, "success", listed.textResultForLlm);

    const discovery = JSON.parse(listed.textResultForLlm);
    const selected = discovery.windows[1];

    const started = await call(fixture.runtime, "screen_record_start", {
      output: "window.mp4", captureApproved: true, windowId: selected.windowId,
    });

    assert.equal(started.resultType, "success", started.textResultForLlm);
    recording = state(started.textResultForLlm);
    assert.equal(recording.status, "recording");

    const args: unknown = JSON.parse(await readFile(`${recording.output}.args.json`, "utf8"));

    assert.ok(Value.Check(Type.Array(Type.String()), args));
    assert.equal(args[args.indexOf("-i") + 1], "hwnd=0x2");
    assert.equal(args[args.indexOf("-vf") + 1], "pad=ceil(iw/2)*2:ceil(ih/2)*2");
    assert.ok(!args.join(" ").includes("--help"));
    assert.ok(!args.includes("desktop"));

    const stopped = await stop(fixture.runtime, recording);

    assert.equal(stopped.resultType, "success", stopped.textResultForLlm);
    assert.equal(state(stopped.textResultForLlm).status, "stopped");
    recording = undefined;
  } finally {
    if (recording) await stop(fixture.runtime, recording);
    await fixture.cleanup();
  }
});

test("window selections reject desktop-only options and stale IDs before taking a lock", async () => {
  const fixture = await setup("argument-contract");

  try {
    setWindowsFixture(fixture.runtime, fixtureWindows());

    if (process.platform !== "win32") return;

    const listed = await call(fixture.runtime, "screen_record_windows", {});

    assert.equal(listed.resultType, "success", listed.textResultForLlm);

    const selected = JSON.parse(listed.textResultForLlm).windows[0].windowId;

    const conflict = await call(fixture.runtime, "screen_record_start", {
      output: "conflict.mp4", captureApproved: true, windowId: selected,
      region: { x: 0, y: 0, width: 800, height: 600 },
    });

    assert.equal(conflict.resultType, "failure");
    assert.match(conflict.textResultForLlm, /cannot be combined with videoInput or region/);

    const stale = await call(fixture.runtime, "screen_record_start", {
      output: "stale.mp4", captureApproved: true, windowId: `w1_${"a".repeat(43)}`,
    });

    assert.equal(stale.resultType, "failure");
    assert.match(stale.textResultForLlm, /selected window is stale or unavailable/);
    await assert.rejects(readFile(resolve(fixture.runtime.cwd, "stale.mp4")), { code: "ENOENT" });
  } finally { await fixture.cleanup(); }
});

test("worker revalidates a selected window and releases only its startup lock if it disappears", async () => {
  const fixture = await setup("window-disappears-worker");

  try {
    setWindowsFixture(fixture.runtime, fixtureWindows());

    if (process.platform !== "win32") return;

    const listed = await call(fixture.runtime, "screen_record_windows", {});

    assert.equal(listed.resultType, "success", listed.textResultForLlm);

    const output = resolve(fixture.runtime.cwd, "disappeared.mp4");
    const selected = JSON.parse(listed.textResultForLlm).windows[0].windowId;

    const lock = join(
      fixture.runtime.env.TMPDIR!,
      stateDirectoryName(),
      `${stateId(output)}.lock`,
    );

    const logPath = join(
      fixture.runtime.env.TMPDIR!,
      stateDirectoryName(),
      `${stateId(output)}.log`,
    );

    const result = await call(fixture.runtime, "screen_record_start", {
      output: "disappeared.mp4", captureApproved: true, windowId: selected,
    });

    const log = await readFile(logPath, "utf8");

    assert.equal(result.resultType, "failure", log);
    assert.match(result.textResultForLlm, /selected window is stale or unavailable/);
    assert.match(log, /selected window is stale or unavailable/);
    await assert.rejects(readFile(lock), { code: "ENOENT" });
    await assert.rejects(readFile(output), { code: "ENOENT" });
  } finally { await fixture.cleanup(); }
});

test("dangling and existing output leaf symlinks are rejected before recorder invocation", async () => {
  const fixture = await setup();

  try {
    const outside = join(fixture.root, "outside");
    const invoked = join(fixture.root, "recorder-invoked");
    const markerScript = join(fixture.root, "marker.mjs");

    await mkdir(outside);
    await writeFile(markerScript, `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(invoked)}, "invoked");
`);
    await symlink(join(outside, "missing.mp4"), join(fixture.runtime.cwd, "dangling.mp4"), "file");
    await writeFile(join(outside, "existing.mp4"), "outside source");
    await symlink(join(outside, "existing.mp4"), join(fixture.runtime.cwd, "existing-link.mp4"), "file");

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

test("validated canonical parents give aliases one recording identity", async () => {
  const fixture = await setup();
  let recording: RecordingState | undefined;

  try {
    const directory = join(fixture.runtime.cwd, "real");

    await mkdir(directory);
    await symlink(directory, join(fixture.runtime.cwd, "alias"), process.platform === "win32" ? "junction" : "dir");
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

test("unverifiable legacy ownership is never adopted even when matching artifacts are readable", async () => {
  const fixture = await setup();
  let recording: RecordingState | undefined;

  try {
    const legacy = join(fixture.runtime.env.TMPDIR!, "scarypilot-screen-record");
    const output = resolve(fixture.runtime.cwd, "raw.mp4");
    const oldLock = join(legacy, `${stateId(output)}.lock`);

    await mkdir(legacy);
    await writeFile(oldLock, "unverified-owner");
    fixture.runtime.env.RECORDER_FIXTURE_UNKNOWN_OWNER = "1";

    const current = await call(fixture.runtime, "screen_record_status", { output });

    assert.equal(current.resultType, "success", current.textResultForLlm);
    assert.equal(state(current.textResultForLlm).status, "not-recording");

    recording = await start(fixture.runtime);
    assert.ok("statePath" in recording);
    assert.equal(basename(resolve(recording.statePath, "..")), stateDirectoryName(false));
    assert.equal((await stop(fixture.runtime, recording)).resultType, "success");
    assert.equal(await readFile(oldLock, "utf8"), "unverified-owner");
  } finally {
    if (recording) await stop(fixture.runtime, recording);
    await fixture.cleanup();
  }
});

test("foreign legacy state cannot block user-scoped recording and same-owner state stays readable", async () => {
  const fixture = await setup();
  let recording: RecordingState | undefined;

  try {
    const legacy = join(fixture.runtime.env.TMPDIR!, "scarypilot-screen-record");

    await mkdir(legacy);
    await writeFile(join(legacy, `${stateId(resolve(fixture.runtime.cwd, "raw.mp4"))}.lock`), "another-user");
    fixture.runtime.env.RECORDER_FIXTURE_FOREIGN_LEGACY = "1";
    recording = await start(fixture.runtime);
    assert.ok("statePath" in recording);
    assert.equal(basename(resolve(recording.statePath, "..")), stateDirectoryName());

    const stopped = await stop(fixture.runtime, recording);

    assert.equal(stopped.resultType, "success", stopped.textResultForLlm);
    assert.equal(await readFile(join(legacy, `${stateId(recording.output)}.lock`), "utf8"), "another-user");
    fixture.runtime.env.RECORDER_FIXTURE_FOREIGN_LEGACY = "0";

    const oldOutput = resolve(fixture.runtime.cwd, "legacy.mp4");

    await writeFile(join(legacy, `${stateId(oldOutput)}.log`), "");
    recording = await start(fixture.runtime, "legacy.mp4");
    assert.ok("statePath" in recording);
    assert.equal(basename(resolve(recording.statePath, "..")), process.getuid ? "scarypilot-screen-record" : stateDirectoryName());

    const current = await call(fixture.runtime, "screen_record_status", { output: oldOutput });

    assert.equal(current.resultType, "success", current.textResultForLlm);
    assert.equal(state(current.textResultForLlm).status, "recording");

    await assert.rejects(runRecorder(fixture.runtime, [
      "stop", "--output", oldOutput,
    ], 5000, RecordingStateSchema), /recording identity does not match/);
    await assert.rejects(readFile(recording.statePath.replace(/\.json$/, ".stop")), { code: "ENOENT" });

    const legacyStop = await stop(fixture.runtime, recording);

    assert.equal(legacyStop.resultType, "success", legacyStop.textResultForLlm);
    assert.equal(state(legacyStop.textResultForLlm).status, "stopped");
  } finally {
    if (recording) await stop(fixture.runtime, recording);
    await fixture.cleanup();
  }
});

test("stop rejects exited-controller locks and tolerates only missing ownership reads", async () => {
  const fixture = await setup();

  try {
    const output = resolve(fixture.runtime.cwd, "terminal.mp4");
    const directory = join(fixture.runtime.env.TMPDIR!, stateDirectoryName());
    const statePath = join(directory, `${stateId(output)}.json`);
    const lock = statePath.replace(/\.json$/, ".lock");
    const now = new Date().toISOString();

    const terminal = {
      status: "stopped", output, statePath, logPath: statePath.replace(/\.json$/, ".log"),
      workerPid: process.pid, ffmpegPid: process.pid, recordingId: "retained-id",
      startedAt: now, updatedAt: now, endedAt: now, exitCode: 0,
    };

    await mkdir(directory);
    await writeFile(output, "fixture finalized output");
    await writeFile(statePath, JSON.stringify(terminal));
    await writeFile(lock, terminal.recordingId);
    fixture.runtime.env.RECORDER_FIXTURE_EXITED_PID = String(process.pid);

    const abandoned = await call(fixture.runtime, "screen_record_stop", {
      output, recordingId: terminal.recordingId,
    });

    assert.equal(abandoned.resultType, "failure", "remaining lock must never be reported as successful finalization");
    assert.match(abandoned.textResultForLlm, /worker exited.*finalization.*incomplete/);
    assert.equal(await readFile(lock, "utf8"), terminal.recordingId);

    fixture.runtime.env.RECORDER_FIXTURE_MODE = "stop-lock-read-EACCES";

    const unreadable = await call(fixture.runtime, "screen_record_stop", {
      output, recordingId: terminal.recordingId,
    });

    assert.equal(unreadable.resultType, "failure");
    assert.match(unreadable.textResultForLlm, /fixture ownership read failed/);

    fixture.runtime.env.RECORDER_FIXTURE_MODE = "stop-lock-read-ENOENT";

    const released = await call(fixture.runtime, "screen_record_stop", {
      output, recordingId: terminal.recordingId,
    });

    assert.equal(released.resultType, "success", released.textResultForLlm);
    assert.equal(state(released.textResultForLlm).status, "stopped");
    await assert.rejects(readFile(lock), { code: "ENOENT" });
  } finally { await fixture.cleanup(); }
});

test("controller retains ownership through log-close failure persistence", async () => {
  const fixture = await setup("log-close-failure");

  try {
    const marker = join(fixture.root, "log-close");

    fixture.runtime.env.RECORDER_FIXTURE_CLOSE_MARKER = marker;

    const result = await call(fixture.runtime, "screen_record_start", {
      output: "raw.mp4", captureApproved: true, videoInput: "0",
    });

    assert.equal(result.resultType, "failure");
    assert.equal(await readFile(marker, "utf8"), "owned");

    const current = await call(fixture.runtime, "screen_record_status", { output: "raw.mp4" });

    assert.equal(current.resultType, "success", current.textResultForLlm);

    const terminal = state(current.textResultForLlm);

    assert.equal(terminal.status, "failed");
    assert.ok("exitCode" in terminal);
    assert.equal(terminal.exitCode, 1);
    assert.ok("statePath" in terminal);
    await assert.rejects(readFile(terminal.statePath.replace(/\.json$/, ".lock")), { code: "ENOENT" });
  } finally { await fixture.cleanup(); }
});

test("heartbeat persistence failures gracefully stop media and surface failure without orphaning capture", async () => {
  for (const mode of ["heartbeat-write-failure", "heartbeat-rename-failure"]) {
    const fixture = await setup(mode);
    let recording: RecordingState | undefined;

    try {
      const marker = join(fixture.root, "fail-heartbeat");

      fixture.runtime.env.RECORDER_FIXTURE_PERSISTENCE_MARKER = marker;
      fixture.runtime.env.RECORDER_FIXTURE_DELAY_CONTROLLER_EXIT = "1";
      recording = await start(fixture.runtime);
      assert.ok("workerPid" in recording);

      await writeFile(marker, "inject persistence failure after readiness");

      const deadline = Date.now() + 4000;

      let current = await call(fixture.runtime, "screen_record_status", { output: recording.output });

      while (Date.now() < deadline && ["recording", "stopping"].includes(JSON.parse(current.textResultForLlm).status)) {
        await sleep(100);
        current = await call(fixture.runtime, "screen_record_status", { output: recording.output });
      }

      assert.equal(current.resultType, "success", current.textResultForLlm);
      assert.equal(await readFile(`${recording.output}.stop-requested`, "utf8"), "graceful stdin stop");

      for (const pid of [recording.workerPid, recording.ffmpegPid]) {
        const exitDeadline = Date.now() + 4000;

        while (Date.now() < exitDeadline) {
          try {
            process.kill(pid, 0);
          } catch (error) {
            assert.ok(error instanceof Error && "code" in error);
            assert.equal(error.code, "ESRCH");
            break;
          }

          await sleep(25);
        }

        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      }

      assert.match(await readFile(recording.logPath, "utf8"), /fixture heartbeat .* failure/);

      const final: { status: string; exitCode?: number } = JSON.parse(current.textResultForLlm);

      assert.equal(final.status, mode === "heartbeat-write-failure" ? "failed" : "stale");

      if (final.status === "failed") assert.equal(final.exitCode, 1);
    } finally {
      if (recording) await stop(fixture.runtime, recording);
      await fixture.cleanup();
    }
  }
});

test("legacy resolve-based symlink identities remain discoverable and stoppable", async () => {
  const fixture = await setup();

  try {
    const directory = join(fixture.runtime.cwd, "real");
    const alias = join(fixture.runtime.cwd, "alias");
    const output = join(alias, "legacy.mp4");
    const legacy = join(fixture.runtime.env.TMPDIR!, "scarypilot-screen-record");
    const oldId = createHash("sha256").update(resolve(output)).digest("hex").slice(0, 16);

    await mkdir(directory);
    await symlink(directory, alias, process.platform === "win32" ? "junction" : "dir");
    await mkdir(legacy);
    await writeFile(join(legacy, `${oldId}.log`), "");

    const cli = spawnSync(process.execPath, [script, "start", "--output", output, "--video-input", "0"], {
      cwd: fixture.runtime.cwd, env: fixture.runtime.env, encoding: "utf8", timeout: 7000,
    });

    assert.equal(cli.status, 0, cli.stderr);

    const recording = state(cli.stdout);

    assert.ok("statePath" in recording);
    assert.equal(recording.statePath, process.getuid
      ? join(legacy, `${oldId}.json`)
      : join(fixture.runtime.env.TMPDIR!, stateDirectoryName(), `${stateId(await realpath(output))}.json`));

    if (!process.getuid) {
      assert.equal(await readFile(join(legacy, `${oldId}.log`), "utf8"), "");
    }

    const current = await call(fixture.runtime, "screen_record_status", { output });

    assert.equal(current.resultType, "success", current.textResultForLlm);
    assert.equal(state(current.textResultForLlm).status, "recording");

    const stopped = await stop(fixture.runtime, recording);

    assert.equal(stopped.resultType, "success", stopped.textResultForLlm);
    assert.equal(state(stopped.textResultForLlm).status, "stopped");
  } finally { await fixture.cleanup(); }
});

test("PowerShell probe timeout and output overflow are bounded and fall back explicitly", async () => {
  const fixture = await setup();

  try {
    if (process.platform !== "win32") {
      const unsupported = await call(fixture.runtime, "screen_record_windows", {});

      assert.equal(unsupported.resultType, "failure");

      return;
    }

    setWindowsFixture(fixture.runtime, fixtureWindows());

    for (const mode of ["powershell-probe-timeout", "powershell-probe-overflow"]) {
      fixture.runtime.env.RECORDER_FIXTURE_MODE = mode;

      const started = Date.now();

      const result = await call(fixture.runtime, "screen_record_windows", {});

      assert.equal(result.resultType, "success", result.textResultForLlm);
      assert.ok(Date.now() - started < 5000);

      const cli = spawnSync(process.execPath, [script, "windows", "--json"], {
        cwd: fixture.runtime.cwd, env: fixture.runtime.env, encoding: "utf8",
        timeout: 5000,
      });

      assert.equal(cli.status, 0, cli.stderr);
      assert.match(cli.stderr, /PowerShell probe pwsh.exe failed/);
    }
  } finally { await fixture.cleanup(); }
});

test("startup lock write and close failures release only this attempt's lock and allow retry", async () => {
  for (const failure of ["write", "close", "replacement"]) {
    const fixture = await setup();
    let recording: RecordingState | undefined;

    try {
      const output = resolve(fixture.runtime.cwd, "lock-failure.mp4");

      const lock = join(fixture.runtime.env.TMPDIR!, stateDirectoryName(), `${stateId(output)}.lock`);

      const closed = join(fixture.root, "closed");

      const spawned = join(fixture.root, "spawned");

      const failing: RecorderRuntime = {
        ...fixture.runtime,
        script: fileURLToPath(new URL("./fixtures/lock-failure.mjs", import.meta.url)),
        env: {
          ...fixture.runtime.env, RECORDER_FIXTURE_SCRIPT: script,
          RECORDER_FIXTURE_LOCK_FAILURE: failure,
          RECORDER_FIXTURE_CLOSED_MARKER: closed, RECORDER_FIXTURE_SPAWN_MARKER: spawned,
          RECORDER_FIXTURE_REPLACE_LOCK: failure === "replacement" ? "1" : "0",
        },
      };

      const result = await call(failing, "screen_record_start", {
        output, captureApproved: true, videoInput: "0",
      });

      assert.equal(result.resultType, "failure");
      assert.match(result.textResultForLlm, failure === "close" ? /fixture lock close failed with EIO/ : /fixture lock write failed with ENOSPC/);
      assert.equal(await readFile(closed, "utf8"), "owned descriptor closed");
      await assert.rejects(readFile(spawned), { code: "ENOENT" });
      await assert.rejects(readFile(output), { code: "ENOENT" });

      if (failure === "replacement") {
        assert.equal(await readFile(lock, "utf8"), "replacement-owner");
      } else {
        await assert.rejects(readFile(lock), { code: "ENOENT" });
        recording = await start(fixture.runtime, output);
      }
    } finally {
      if (recording) await stop(fixture.runtime, recording);
      await fixture.cleanup();
    }
  }
});

test("a corrupt stale log directory releases the startup lock before reporting failure and allows retry", async () => {
  const fixture = await setup();
  let recording: RecordingState | undefined;

  try {
    const output = resolve(fixture.runtime.cwd, "corrupt-log.mp4");
    const directory = join(fixture.runtime.env.TMPDIR!, stateDirectoryName());
    const log = join(directory, `${stateId(output)}.log`);
    const lock = log.replace(/\.log$/, ".lock");
    await mkdir(log, { recursive: true });

    const result = await call(fixture.runtime, "screen_record_start", { output, captureApproved: true, videoInput: "0" });
    assert.equal(result.resultType, "failure");
    assert.match(result.textResultForLlm, /EISDIR|ERR_FS_EISDIR|EPERM/);
    await assert.rejects(readFile(lock), { code: "ENOENT" });
    await assert.rejects(readFile(output), { code: "ENOENT" });
    await rm(log, { recursive: true });
    recording = await start(fixture.runtime, output);
  } finally {
    if (recording) await stop(fixture.runtime, recording);
    await fixture.cleanup();
  }
});

test("every post-claim setup failure rolls back only the owned file and surfaces rollback errors", async () => {
  for (const scenario of [
    { artifact: "json" }, { artifact: "stop" }, { artifact: "log" },
    { artifact: "log", replacement: "identity" }, { artifact: "log", replacement: "owner" },
    { artifact: "log", rollback: "read" }, { artifact: "log", rollback: "remove" },
  ]) {
    const fixture = await setup();
    let recording: RecordingState | undefined;

    try {
      const output = resolve(fixture.runtime.cwd, "setup-failure.mp4");
      const lock = join(fixture.runtime.env.TMPDIR!, stateDirectoryName(), `${stateId(output)}.lock`);
      const spawned = join(fixture.root, "spawned");

      const failing: RecorderRuntime = {
        ...fixture.runtime,
        script: fileURLToPath(new URL("./fixtures/setup-failure.mjs", import.meta.url)),
        env: {
          ...fixture.runtime.env, RECORDER_FIXTURE_SCRIPT: script,
          RECORDER_FIXTURE_SETUP_ARTIFACT: scenario.artifact,
          RECORDER_FIXTURE_SETUP_REPLACEMENT: scenario.replacement ?? "",
          RECORDER_FIXTURE_ROLLBACK_ERROR: scenario.rollback ?? "",
          RECORDER_FIXTURE_SPAWN_MARKER: spawned,
        },
      };

      const result = await call(failing, "screen_record_start", { output, captureApproved: true, videoInput: "0" });
      assert.equal(result.resultType, "failure");
      assert.match(result.textResultForLlm, /fixture stale artifact removal failed with EIO/);
      await assert.rejects(readFile(spawned), { code: "ENOENT" });
      await assert.rejects(readFile(output), { code: "ENOENT" });

      if (scenario.replacement === "identity") {
        assert.equal(await readFile(lock, "utf8"), await readFile(`${lock}.original`, "utf8"));
      } else if (scenario.replacement === "owner") {
        assert.equal(await readFile(lock, "utf8"), "replacement-owner");
      } else if (scenario.rollback) {
        assert.match(result.textResultForLlm, /lock cleanup failed: fixture rollback .* failed with EACCES/);
        assert.match(await readFile(lock, "utf8"), /^[0-9a-f-]{36}$/);
      } else {
        await assert.rejects(readFile(lock), { code: "ENOENT" });
        recording = await start(fixture.runtime, output);
      }
    } finally {
      if (recording) await stop(fixture.runtime, recording);
      await fixture.cleanup();
    }
  }
});

test("confirmed worker spawn failure preserves its error, removes its owned lock, and permits retry", async () => {
  const fixture = await setup();
  let recording: RecordingState | undefined;

  try {
    const output = resolve(fixture.runtime.cwd, "spawn-failure.mp4");
    const id = stateId(output);
    const lock = join(fixture.runtime.env.TMPDIR!, stateDirectoryName(), `${id}.lock`);

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

test("spawn failure never removes a lock whose owner changed", async () => {
  const fixture = await setup();

  try {
    const output = resolve(fixture.runtime.cwd, "replaced-lock.mp4");
    const id = stateId(output);
    const lock = join(fixture.runtime.env.TMPDIR!, stateDirectoryName(), `${id}.lock`);

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

test("worker startup log and spawn failures release ownership, persist diagnostics, and allow retry", async () => {
  for (const failure of ["log", "spawn-sync", "spawn-async"]) {
    const fixture = await setup();
    let recording: RecordingState | undefined;

    try {
      const output = resolve(fixture.runtime.cwd, "worker-startup.mp4");
      const directory = join(fixture.runtime.env.TMPDIR!, stateDirectoryName());
      const base = join(directory, stateId(output));
      const recordingId = "11111111-1111-4111-8111-111111111111";

      const config = {
        output, recordingId, fps: 30, videoInput: "0",
        lock: `${base}.lock`, log: `${base}.log`, state: `${base}.json`, stop: `${base}.stop`,
      };

      const spawned = join(fixture.root, "spawned");
      const closed = join(fixture.root, "closed");
      await mkdir(directory);
      await writeFile(config.lock, recordingId);

      const result = spawnSync(process.execPath, [
        script, "_capture", "--config", Buffer.from(JSON.stringify(config)).toString("base64url"),
      ], {
        cwd: fixture.runtime.cwd, encoding: "utf8", timeout: 5000,
        env: {
          ...fixture.runtime.env,
          NODE_OPTIONS: `${fixture.runtime.env.NODE_OPTIONS} --import=${new URL("./fixtures/worker-startup-failure.mjs", import.meta.url).href}`,
          RECORDER_FIXTURE_STARTUP_FAILURE: failure,
          RECORDER_FIXTURE_SPAWN_MARKER: spawned, RECORDER_FIXTURE_CLOSED_MARKER: closed,
        },
      });

      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /fixture worker (log open|spawn) failed with EACCES/);
      await assert.rejects(readFile(config.lock), { code: "ENOENT" });
      await assert.rejects(readFile(output), { code: "ENOENT" });
      const current = await call(fixture.runtime, "screen_record_status", { output });
      assert.equal(current.resultType, "success", current.textResultForLlm);
      const terminal = state(current.textResultForLlm);
      assert.equal(terminal.status, "failed");
      assert.equal(terminal.recordingId, recordingId);
      assert.match(current.textResultForLlm, /fixture worker (log open|spawn) failed with EACCES/);

      if (failure === "log") {
        await assert.rejects(readFile(spawned), { code: "ENOENT" });
      } else {
        assert.equal(await readFile(closed, "utf8"), "log descriptor closed");
      }

      recording = await start(fixture.runtime, output);
    } finally {
      if (recording) await stop(fixture.runtime, recording);
      await fixture.cleanup();
    }
  }
});

test("worker startup rollback preserves replacement files and reports cleanup failures", async () => {
  for (const failure of ["log", "spawn-sync", "spawn-async"]) {
    for (const scenario of ["identity", "owner", "read", "remove", "state", "close", "log"]) {
      if (failure === "log" && scenario === "close") continue;
      const fixture = await setup();

      try {
        const base = join(fixture.root, "controller");
        const recordingId = "11111111-1111-4111-8111-111111111111";

        const config = {
          output: join(fixture.runtime.cwd, "absent.mp4"), recordingId, fps: 30, videoInput: "0",
          lock: `${base}.lock`, log: `${base}.log`, state: `${base}.json`, stop: `${base}.stop`,
        };

        await writeFile(config.lock, recordingId);
        const replacement = ["identity", "owner"].includes(scenario);

        const result = spawnSync(process.execPath, [
          script, "_capture", "--config", Buffer.from(JSON.stringify(config)).toString("base64url"),
        ], {
          cwd: fixture.runtime.cwd, encoding: "utf8", timeout: 5000,
          env: {
            ...fixture.runtime.env,
            NODE_OPTIONS: `${fixture.runtime.env.NODE_OPTIONS} --import=${new URL("./fixtures/worker-startup-failure.mjs", import.meta.url).href}`,
            RECORDER_FIXTURE_STARTUP_FAILURE: failure,
            RECORDER_FIXTURE_STARTUP_REPLACEMENT: replacement ? scenario : "",
            RECORDER_FIXTURE_STARTUP_CLEANUP: replacement ? "" : scenario,
            RECORDER_FIXTURE_SPAWN_MARKER: `${base}.spawned`,
            RECORDER_FIXTURE_CLOSED_MARKER: `${base}.closed`,
          },
        });

        assert.ifError(result.error);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /fixture worker (log open|spawn) failed with EACCES/);

        if (replacement) {
          assert.equal(await readFile(config.lock, "utf8"), scenario === "owner" ? "replacement-owner" : recordingId);
          assert.equal(await readFile(config.state, "utf8"), "replacement state");
          assert.equal(await readFile(config.log, "utf8"), "replacement log");
          assert.match(result.stderr, /ownership changed.*preserved/);
        } else {
          assert.match(result.stderr, new RegExp(`fixture startup ${{
            read: "ownership read", remove: "lock removal", state: "state persistence", close: "log close", log: "log write",
          }[scenario]} failed`));

          if (scenario === "read" || scenario === "remove") {
            assert.equal(await readFile(config.lock, "utf8"), recordingId);
          } else {
            await assert.rejects(readFile(config.lock), { code: "ENOENT" });
          }

          if (scenario === "remove" || scenario === "close" || scenario === "log") {
            assert.match(await readFile(config.state, "utf8"), /fixture startup .* failed/);
          }

          if (scenario === "state" && failure !== "log") {
            assert.match(await readFile(config.log, "utf8"), /fixture startup state persistence failed/);
          }
        }

        await assert.rejects(readFile(config.output), { code: "ENOENT" });
      } finally { await fixture.cleanup(); }
    }
  }
});

test("detached startup reports worker log-open failure instead of silently stranding ownership", async () => {
  const fixture = await setup();

  try {
    fixture.runtime.env.NODE_OPTIONS += ` --import=${new URL("./fixtures/worker-startup-failure.mjs", import.meta.url).href}`;
    fixture.runtime.env.RECORDER_FIXTURE_STARTUP_FAILURE = "log";

    const result = await call(fixture.runtime, "screen_record_start", {
      output: "log-failure.mp4", captureApproved: true, videoInput: "0",
    });

    assert.equal(result.resultType, "failure");
    assert.match(result.textResultForLlm, /fixture worker log open failed with EACCES/);
    fixture.runtime.env.RECORDER_FIXTURE_STARTUP_FAILURE = "";
    const current = await call(fixture.runtime, "screen_record_status", { output: "log-failure.mp4" });
    assert.equal(current.resultType, "success", current.textResultForLlm);
    assert.equal(state(current.textResultForLlm).status, "failed");
  } finally { await fixture.cleanup(); }
});

test("an interrupted startup lock is actionable and never silently replaced", async () => {
  const fixture = await setup();

  try {
    const output = resolve(fixture.runtime.cwd, process.platform === "win32" ? "Pending.mp4" : "pending.mp4");
    const id = stateId(output);
    const directory = join(fixture.runtime.env.TMPDIR!, process.getuid ? "scarypilot-screen-record" : stateDirectoryName());
    const lock = join(directory, `${id}.lock`);

    await mkdir(directory);
    await writeFile(lock, "interrupted-start");

    const alias = resolve(fixture.runtime.cwd, "pending.mp4");

    const current = await call(fixture.runtime, "screen_record_status", { output: alias });

    assert.equal(current.resultType, "failure");
    assert.match(current.textResultForLlm, /pending or interrupted/);

    const duplicate = await call(fixture.runtime, "screen_record_start", { output: alias, captureApproved: true, videoInput: "0" });

    assert.equal(duplicate.resultType, "failure");
    assert.match(duplicate.textResultForLlm, /cannot claim recording startup/);
    assert.equal(await readFile(lock, "utf8"), "interrupted-start");
  } finally { await fixture.cleanup(); }
});

test("diagnostic timeout and device failures are failures, not empty success", async () => {
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

      fixture.runtime.env.RECORDER_FIXTURE_MODE = "device-enumeration-error-only";

      const errorOnly = await call(fixture.runtime, "screen_record_devices", {});

      assert.equal(errorOnly.resultType, "failure");
      assert.match(errorOnly.textResultForLlm, /Could not enumerate video devices/);

      if (process.platform === "darwin") {
        fixture.runtime.env.RECORDER_FIXTURE_MODE = "device-enumeration-eio";

        const enumeration = await call(fixture.runtime, "screen_record_devices", {});

        assert.equal(enumeration.resultType, "success", enumeration.textResultForLlm);
        assert.match(enumeration.textResultForLlm, /Fixture screen/);
      }
    }
  } finally { await fixture.cleanup(); }
});

test("timed-out command does not kill the detached worker; graceful stop timeout can be retried", async () => {
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

test("persisted stale and corrupt states are diagnosed without signalling arbitrary processes", async () => {
  const fixture = await setup();

  try {
    const output = resolve(fixture.runtime.cwd, "raw.mp4");
    const id = stateId(output);
    const directory = join(fixture.runtime.env.TMPDIR!, process.getuid ? "scarypilot-screen-record" : stateDirectoryName());
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

test("malformed terminal state is rejected consistently by native tools and standalone CLI", async () => {
  const fixture = await setup();
  let recording: RecordingState | undefined;

  try {
    recording = await start(fixture.runtime);

    const stopped = await stop(fixture.runtime, recording);

    assert.equal(stopped.resultType, "success", stopped.textResultForLlm);

    const saved = state(stopped.textResultForLlm);

    assert.ok("statePath" in saved);

    for (const missing of ["statePath", "logPath", "endedAt", "exitCode"]) {
      await writeFile(saved.statePath, JSON.stringify(Object.fromEntries(
        Object.entries(saved).filter(([key]) => key !== missing),
      )));

      const native = await call(fixture.runtime, "screen_record_status", { output: saved.output });

      assert.equal(native.resultType, "failure");
      assert.match(native.textResultForLlm, /invalid recording state/);

      const standalone = spawnSync(process.execPath, [script, "status", "--output", saved.output], {
        env: fixture.runtime.env, encoding: "utf8", timeout: 10000, windowsHide: true,
      });

      assert.ifError(standalone.error);
      assert.notEqual(standalone.status, 0);
      assert.match(standalone.stderr, /invalid recording state/);
    }

    await writeFile(saved.statePath, JSON.stringify(saved));
  } finally {
    if (recording) await stop(fixture.runtime, recording);
    await fixture.cleanup();
  }
});

test("stop rereads terminal state when the worker exits during its last liveness check", async () => {
  const fixture = await setup("slow-stop");
  let recording: RecordingState | undefined;

  try {
    recording = await start(fixture.runtime, "exit-race.mp4");
    assert.ok("workerPid" in recording);

    const marker = join(fixture.root, "race-observed");

    const racing: RecorderRuntime = {
      ...fixture.runtime,
      script: fileURLToPath(new URL("./fixtures/stop-exit-race.mjs", import.meta.url)),
      env: {
        ...fixture.runtime.env,
        RECORDER_FIXTURE_SCRIPT: script,
        RECORDER_FIXTURE_WORKER_PID: String(recording.workerPid),
        RECORDER_FIXTURE_RACE_MARKER: marker,
      },
    };

    const result = await stop(racing, recording);

    assert.equal(await readFile(marker, "utf8"), "worker exited after cached state was read");
    assert.equal(result.resultType, "success", result.textResultForLlm);
    assert.equal(state(result.textResultForLlm).status, "stopped");
  } finally {
    if (recording) await stop(fixture.runtime, recording);
    await fixture.cleanup();
  }
});

test("SDK invocation cancellation ends only the command wait, not the detached recording", async () => {
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

test("concurrent CLI starts cannot replace startup ownership", async () => {
  const fixture = await setup();
  let recording: RecordingState | undefined;

  try {
    const results = await Promise.all([
      call(fixture.runtime, "screen_record_start", { output: process.platform === "win32" ? "Raw.mp4" : "raw.mp4", captureApproved: true, videoInput: "0" }),
      call(fixture.runtime, "screen_record_start", { output: "raw.mp4", captureApproved: true, videoInput: "0" }),
    ]);

    assert.equal(results.filter((result) => result.resultType === "success").length, 1);
    const success = results.find((result) => result.resultType === "success");
    assert.ok(success);
    recording = state(success.textResultForLlm);

    const alias = resolve(fixture.runtime.cwd, "raw.mp4");

    const current = await call(fixture.runtime, "screen_record_status", { output: alias });

    assert.equal(current.resultType, "success", current.textResultForLlm);
    assert.ok("recordingId" in recording);
    assert.equal(state(current.textResultForLlm).output, recording.output);

    const cli = spawnSync(process.execPath, [script, "status", "--output", alias], {
      env: fixture.runtime.env, encoding: "utf8", timeout: 10000, windowsHide: true,
    });

    assert.ifError(cli.error);
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(state(cli.stdout).output, recording.output);

    const aliasedStop = await call(fixture.runtime, "screen_record_stop", {
      output: alias, recordingId: recording.recordingId,
    });

    assert.equal(aliasedStop.resultType, "success", aliasedStop.textResultForLlm);

    const final = await stop(fixture.runtime, recording);
    assert.equal(final.resultType, "success", final.textResultForLlm);
  } finally {
    if (recording) await stop(fixture.runtime, recording);
    await fixture.cleanup();
  }
});

test("standalone CLI remains usable and capture errors retain actionable logs", async () => {
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
