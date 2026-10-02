#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  chmodSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, extname, relative, resolve } from "node:path";
import { tmpdir, userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import process from "node:process";

const args = process.argv.slice(2);

const command = args.shift();

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

const sapiScript = resolve(scriptDirectory, "sapi-narrate.ps1");

function fail(message, code = 1) {
  console.error(`screen-record: ${message}`);
  process.exit(code);
}

function parseArgs(values) {
  const parsed = { _: [] };

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];

    if (!value.startsWith("--")) {
      parsed._.push(value);
      continue;
    }

    const key = value.slice(2);
    const next = values[index + 1];

    if (next === undefined || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }

  return parsed;
}

const options = parseArgs(args);

function requireOption(name) {
  const value = options[name];

  if (typeof value !== "string" || value.length === 0) {
    fail(`--${name} is required`);
  }

  return value;
}

function executableWorks(name) {
  return spawnSync(name, ["-version"], {
    encoding: "utf8",
    windowsHide: true,
  }).status === 0;
}

function findPowerShell() {
  if (process.platform !== "win32") {
    return null;
  }

  for (const candidate of ["pwsh.exe", "powershell.exe"]) {
    const result = spawnSync(
      candidate,
      ["-NoProfile", "-NonInteractive", "-Command", "exit 0"],
      { encoding: "utf8", windowsHide: true, timeout: 1000, maxBuffer: 16384 },
    );

    if (result.error) {
      if (result.error.code !== "ENOENT") {
        console.error(`screen-record: PowerShell probe ${candidate} failed: ${result.error.message}`);
      }

      continue;
    }

    if (result.status === 0) {
      return candidate;
    }
  }

  return null;
}

function macosSayAvailable() {
  if (process.platform !== "darwin") {
    return false;
  }

  return spawnSync("/usr/bin/say", ["-v", "?"], {
    encoding: "utf8",
  }).status === 0;
}

function omlxBaseUrl() {
  return (process.env.OMLX_BASE_URL || "http://127.0.0.1:8000")
    .replace(/\/+$/, "")
    .replace(/\/v1$/, "");
}

function omlxHeaders() {
  const headers = { "Content-Type": "application/json" };

  if (process.env.OMLX_API_KEY) {
    headers.Authorization = `Bearer ${process.env.OMLX_API_KEY}`;
  }

  return headers;
}

async function omlxRequest(path, init = {}, timeout = 2000) {
  return fetch(`${omlxBaseUrl()}${path}`, {
    ...init,
    headers: {
      ...omlxHeaders(),
      ...init.headers,
    },
    signal: AbortSignal.timeout(timeout),
  });
}

async function discoverOmlxTts() {
  try {
    const response = await omlxRequest("/v1/models/status");

    if (!response.ok) {
      return null;
    }

    const payload = await response.json();

    const models = Array.isArray(payload)
      ? payload
      : Array.isArray(payload.data)
        ? payload.data
        : Array.isArray(payload.models)
          ? payload.models
          : [];

    const requestedModel = options.model ?? process.env.OMLX_TTS_MODEL;

    if (requestedModel) {
      const available = models.some(
        (model) =>
          model.id === requestedModel ||
          model.model_alias === requestedModel ||
          (Array.isArray(model.aliases) && model.aliases.includes(requestedModel)),
      );

      return available ? { baseUrl: omlxBaseUrl(), model: requestedModel } : null;
    }

    const candidates = models
      .filter(
        (model) =>
          model.engine_type === "audio_tts" ||
          model.model_type === "audio_tts" ||
          String(model.config_model_type ?? "").toLowerCase().includes("tts"),
      )
      .sort((left, right) => Number(right.loaded) - Number(left.loaded));

    return candidates[0]
      ? { baseUrl: omlxBaseUrl(), model: candidates[0].id }
      : null;
  } catch {
    return null;
  }
}

function run(name, commandArgs, { capture = false } = {}) {
  const result = spawnSync(name, commandArgs, {
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    windowsHide: true,
  });

  if (result.error) {
    fail(`could not run ${name}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    if (capture && result.stderr) {
      console.error(result.stderr.trim());
    }

    fail(`${name} exited with code ${result.status}`);
  }

  return result.stdout ?? "";
}

function ensureNewOutput(path) {
  const output = resolve(path);

  if (existsSync(output)) {
    fail(`output already exists: ${output}`);
  }

  mkdirSync(dirname(output), { recursive: true });

  return output;
}

function ensureInput(path) {
  const input = resolve(path);

  if (!existsSync(input)) {
    fail(`input does not exist: ${input}`);
  }

  return input;
}

function recordingKey(output) {
  const resolved = resolve(output);
  let ancestor = dirname(resolved);

  while (!existsSync(ancestor)) ancestor = dirname(ancestor);

  const canonical = existsSync(resolved)
    ? realpathSync(resolved)
    : resolve(realpathSync(ancestor), relative(ancestor, resolved));

  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function recordingPaths(output) {
  let id = createHash("sha256").update(recordingKey(output)).digest("hex").slice(0, 16);

  const user = process.getuid ? String(process.getuid()) :
    createHash("sha256").update(`${userInfo().username}\0${userInfo().homedir}`).digest("hex").slice(0, 16);

  const legacy = resolve(tmpdir(), "scarypilot-screen-record");

  const oldDirectory = lstatSync(legacy, { throwIfNoEntry: false });

  const ownLegacy = oldDirectory?.isDirectory() &&
    (!process.getuid || oldDirectory.uid === process.getuid());

  const oldId = createHash("sha256").update(resolve(output)).digest("hex").slice(0, 16);

  const legacyId = ownLegacy && [id, oldId].find((candidate) =>
    ["json", "lock", "log", "stop"].some((suffix) => existsSync(resolve(legacy, `${candidate}.${suffix}`))));

  const root = legacyId ? legacy : resolve(tmpdir(), `scarypilot-screen-record-${user}`);

  if (legacyId) id = legacyId;

  mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = lstatSync(root);

  if (!directory.isDirectory() || (process.getuid && directory.uid !== process.getuid())) {
    fail(`recording state directory is not a directory owned by this user: ${root}`);
  }

  if (process.platform !== "win32") chmodSync(root, 0o700);

  return {
    state: resolve(root, `${id}.json`),
    stop: resolve(root, `${id}.stop`),
    log: resolve(root, `${id}.log`),
    lock: resolve(root, `${id}.lock`),
  };
}

function readState(path) {
  if (!existsSync(path)) {
    return null;
  }

  try {
    if (statSync(path).size > 65536) {
      throw new Error("state exceeds 64 KiB");
    }

    const state = JSON.parse(readFileSync(path, "utf8"));

    if (
      !state ||
      !["recording", "stopping", "stopped", "failed"].includes(state.status) ||
      typeof state.output !== "string" ||
      !Number.isSafeInteger(state.workerPid) || state.workerPid <= 0 ||
      !Number.isSafeInteger(state.ffmpegPid) || state.ffmpegPid <= 0 ||
      typeof state.startedAt !== "string" ||
      !state.startedAt || state.startedAt.length > 4096 ||
      typeof state.statePath !== "string" || !state.statePath || state.statePath.length > 4096 ||
      typeof state.logPath !== "string" || !state.logPath || state.logPath.length > 4096 ||
      !state.output || state.output.length > 4096 ||
      (["stopped", "failed"].includes(state.status) &&
        (typeof state.endedAt !== "string" || !state.endedAt || state.endedAt.length > 4096 ||
          !Number.isInteger(state.exitCode))) ||
      (state.updatedAt !== undefined &&
        (typeof state.updatedAt !== "string" || !state.updatedAt || state.updatedAt.length > 4096)) ||
      (state.recordingId !== undefined &&
        (typeof state.recordingId !== "string" || !state.recordingId || state.recordingId.length > 4096))
    ) {
      throw new Error("unsupported recording state; inspect the state file before recovery");
    }

    return state;
  } catch (error) {
    fail(`invalid recording state ${path}: ${error.message}`);
  }
}

function pidRunning(pid) {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;

    if (error.code === "EPERM") return true;
    throw error;
  }
}

function writeState(path, state) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}

function logTail(path) {
  if (!existsSync(path)) return "";
  const fd = openSync(path, "r");

  try {
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, 16384));
    readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));

    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function activeState(state) {
  return ["recording", "stopping"].includes(state.status) &&
    pidRunning(state.workerPid) && pidRunning(state.ffmpegPid) &&
    (!state.updatedAt || Date.now() - Date.parse(state.updatedAt) < 5000);
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function nativeNarrationEngine() {
  if (process.platform === "win32") {
    return "sapi";
  }

  if (process.platform === "darwin") {
    return "say";
  }

  return "flite";
}

async function narrationEngine() {
  const requested = options.engine ?? "auto";

  if (!["auto", "omlx", "sapi", "say", "flite"].includes(requested)) {
    fail("--engine must be auto, omlx, sapi, say, or flite");
  }

  if (requested === "auto" || requested === "omlx") {
    const omlx = await discoverOmlxTts();

    if (omlx) {
      return { engine: "omlx", omlx };
    }

    if (requested === "omlx") {
      fail(
        `no OMLX TTS model is available at ${omlxBaseUrl()}; set OMLX_BASE_URL or OMLX_TTS_MODEL`,
      );
    }
  }

  return { engine: requested === "auto" ? nativeNarrationEngine() : requested };
}

const windowIdPattern = /^w1_[A-Za-z0-9_-]{43}$/;

const windowHandlePattern = /^0x[0-9a-fA-F]{1,16}$/;

function windowIdFor(window) {
  const identity = [
    window.hwnd,
    window.processId,
    window.processStartTime,
    window.threadId,
    window.className,
    window.title,
  ];

  return `w1_${createHash("sha256").update(JSON.stringify(identity)).digest("base64url")}`;
}

function sanitizeWindowText(value, limit) {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);

    return code < 32 || (code >= 0x7f && code <= 0x9f) ? " " : character;
  }).join("").trim().slice(0, limit);
}

function enumerateWindows() {
  if (process.platform !== "win32") throw new Error("Windows window discovery is only supported on Windows.");

  const powershell = findPowerShell();

  if (!powershell) throw new Error("Windows window discovery requires pwsh.exe or powershell.exe on PATH.");

  const script = resolve(process.argv[1], "..", "windows-enumerate.ps1");

  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-File", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 7000,
    maxBuffer: 1048576,
  });

  if (result.error) throw new Error(`Could not enumerate Windows windows: ${result.error.message}`);

  if (result.status !== 0) {
    throw new Error(`Windows window enumeration failed: ${result.stderr.trim() || `PowerShell exited with code ${result.status}`}`);
  }

  let snapshot;

  try {
    snapshot = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`PowerShell returned invalid window JSON: ${error.message}`);
  }

  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) ||
    !Array.isArray(snapshot.windows) ||
    !Number.isSafeInteger(snapshot.uninspectableCount) || snapshot.uninspectableCount < 0 ||
    snapshot.windows.length > 4096) {
    throw new Error("PowerShell returned an unsupported window listing.");
  }

  for (const window of snapshot.windows) {
    if (!window || typeof window !== "object" || Array.isArray(window) ||
      typeof window.hwnd !== "string" || !windowHandlePattern.test(window.hwnd) ||
      !Number.isSafeInteger(window.processId) || window.processId < 1 ||
      typeof window.processStartTime !== "string" || !/^\d+$/.test(window.processStartTime) ||
      !Number.isSafeInteger(window.threadId) || window.threadId < 1 ||
      typeof window.className !== "string" || !window.className ||
      typeof window.title !== "string" || !window.title ||
      typeof window.processName !== "string" || !window.processName ||
      !Number.isSafeInteger(window.clientWidth) || window.clientWidth < 1 ||
      !Number.isSafeInteger(window.clientHeight) || window.clientHeight < 1 ||
      !Number.isSafeInteger(window.windowLeft) ||
      !Number.isSafeInteger(window.windowTop) ||
      !Number.isSafeInteger(window.windowWidth) || window.windowWidth < 1 ||
      !Number.isSafeInteger(window.windowHeight) || window.windowHeight < 1 ||
      typeof window.foreground !== "boolean") {
      throw new Error("PowerShell returned an invalid window entry.");
    }
  }

  return snapshot;
}

function resolveWindowId(windowId) {
  if (process.platform !== "win32") throw new Error("Window capture is only supported on Windows.");

  if (typeof windowId !== "string" || !windowIdPattern.test(windowId)) {
    throw new Error("Invalid windowId; rediscover windows and use an ID returned by the windows command.");
  }

  const snapshot = enumerateWindows();
  const matches = snapshot.windows.filter((window) => windowIdFor(window) === windowId);

  if (matches.length !== 1) {
    throw new Error("The selected window is stale or unavailable; run the windows command again and select a current window.");
  }

  return matches[0];
}

function requireGdigrabWindowSupport() {
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-f", "gdigrab", "-i", "hwnd=not-a-window",
    "-frames:v", "1", "-f", "null", "-",
  ], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 3000,
    maxBuffer: 262144,
  });

  const diagnostic = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

  if (result.error) throw new Error(`Could not check FFmpeg window-capture support: ${result.error.message}`);

  if (!diagnostic.includes("Invalid window handle 'not-a-window'")) {
    throw new Error("This FFmpeg build does not support gdigrab HWND capture; install FFmpeg 7.0 or newer or use desktop capture.");
  }
}

function windows() {
  if (process.platform !== "win32") fail("Windows window discovery is only supported on Windows.");

  requireGdigrabWindowSupport();
  const snapshot = enumerateWindows();

  const candidates = snapshot.windows.flatMap((window) => {
    const title = sanitizeWindowText(window.title, 1024);
    const processName = sanitizeWindowText(window.processName, 260);

    return title && processName
      ? [{
        windowId: windowIdFor(window),
        title,
        processName,
        processId: window.processId,
        bounds: {
          x: window.windowLeft,
          y: window.windowTop,
          width: window.windowWidth,
          height: window.windowHeight,
        },
        clientArea: { width: window.clientWidth, height: window.clientHeight },
        foreground: window.foreground,
      }]
      : [];
  });

  console.log(JSON.stringify({
    platform: "win32",
    windows: candidates.slice(0, 128),
    truncated: candidates.length > 128,
    uninspectableCount: snapshot.uninspectableCount,
    permissionsVerified: false,
  }, null, 2));
}

function ffmpegCaptureArgs(config, windowTarget) {
  const ffmpegArgs = ["-hide_banner", "-n"];
  const fps = String(config.fps);
  let region;

  if (config.region) {
    const parts = config.region.split(",").map(Number);

    if (
      parts.length !== 4 ||
      parts.some((part) => !Number.isFinite(part)) ||
      parts[2] <= 0 ||
      parts[3] <= 0 ||
      parts[2] % 2 !== 0 ||
      parts[3] % 2 !== 0
    ) {
      fail("--region must be x,y,width,height with positive even dimensions");
    }

    if (process.platform === "darwin" && (parts[0] < 0 || parts[1] < 0)) {
      fail("macOS region x and y coordinates cannot be negative");
    }

    region = parts;
  }

  if (process.platform === "win32") {
    ffmpegArgs.push("-f", "gdigrab", "-framerate", fps);

    if (windowTarget && (config.region || config.videoInput)) {
      fail("--window-id cannot be combined with --region or --video-input.");
    }

    if (region) {
      ffmpegArgs.push(
        "-offset_x",
        String(region[0]),
        "-offset_y",
        String(region[1]),
        "-video_size",
        `${region[2]}x${region[3]}`,
      );
    }

    ffmpegArgs.push("-i", windowTarget ? `hwnd=${windowTarget.hwnd}` : "desktop");

    if (config.audioDevice) {
      ffmpegArgs.push("-f", "dshow", "-i", `audio=${config.audioDevice}`);
    }

    if (windowTarget) {
      ffmpegArgs.push("-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2");
    }
  } else if (process.platform === "linux") {
    const display = config.videoInput || process.env.DISPLAY;

    if (!display) {
      fail("DISPLAY is unset; pass --video-input for x11grab");
    }

    ffmpegArgs.push("-f", "x11grab", "-framerate", fps);

    if (region) {
      ffmpegArgs.push("-video_size", `${region[2]}x${region[3]}`);
    }

    const offset = region ? `+${region[0]},${region[1]}` : "";
    ffmpegArgs.push("-i", `${display}${offset}`);

    if (config.audioDevice) {
      ffmpegArgs.push("-f", "pulse", "-i", config.audioDevice);
    }
  } else if (process.platform === "darwin") {
    if (!config.videoInput) {
      fail("macOS capture requires --video-input with an avfoundation screen index");
    }

    ffmpegArgs.push(
      "-f",
      "avfoundation",
      "-framerate",
      fps,
      "-i",
      `${config.videoInput}:${config.audioDevice ?? "none"}`,
    );

    if (region) {
      ffmpegArgs.push(
        "-vf",
        `crop=${region[2]}:${region[3]}:${region[0]}:${region[1]}`,
      );
    }
  } else {
    fail(`screen capture is not supported on ${process.platform}`);
  }

  ffmpegArgs.push(
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
  );

  if (config.audioDevice) {
    ffmpegArgs.push("-c:a", "aac", "-b:a", "192k");
  }

  ffmpegArgs.push("-movflags", "+faststart", config.output);

  return ffmpegArgs;
}

async function doctor() {
  if (options["capture-only"]) {
    const checks = ["ffmpeg", "ffprobe"].map((name) => {
      const result = spawnSync(name, ["-version"], {
        encoding: "utf8", windowsHide: true, timeout: 3000, maxBuffer: 262144,
      });

      if (result.error) fail(`could not check ${name}: ${result.error.message}`);

      if (result.status !== 0) fail(`${name} -version exited with code ${result.status}`);

      return true;
    });

    const result = spawnSync("ffmpeg", ["-hide_banner", "-devices"], {
      encoding: "utf8", windowsHide: true, timeout: 3000, maxBuffer: 262144,
    });

    if (result.error) fail(`could not discover FFmpeg devices: ${result.error.message}`);

    if (result.status !== 0) fail(`FFmpeg device discovery exited with code ${result.status}`);
    const captureDevice = { win32: "gdigrab", linux: "x11grab", darwin: "avfoundation" }[process.platform];

    if (!captureDevice) fail(`screen capture is not supported on ${process.platform}`);

    const available = new RegExp(`^\\s*D\\S*\\s+${captureDevice}\\s`, "m")
      .test(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);

    console.log(JSON.stringify({
      platform: process.platform, ffmpeg: checks[0], ffprobe: checks[1],
      captureDevice, captureAvailable: available, permissionsVerified: false,
    }));

    if (!available) fail(`FFmpeg does not provide the ${captureDevice} input on this system`);

    return;
  }

  const ffmpeg = executableWorks("ffmpeg");
  const ffprobe = executableWorks("ffprobe");

  if (!ffmpeg || !ffprobe) {
    fail("ffmpeg and ffprobe must both be available on PATH");
  }

  const filters = run("ffmpeg", ["-hide_banner", "-filters"], { capture: true });
  const devices = run("ffmpeg", ["-hide_banner", "-devices"], { capture: true });
  const powershell = findPowerShell();
  const sayTts = macosSayAvailable();
  const omlx = await discoverOmlxTts();

  const sapiCheck =
    powershell
      ? spawnSync(
          powershell,
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            sapiScript,
            "-ListVoices",
          ],
          { encoding: "utf8", windowsHide: true },
        )
      : null;

  const sapiVoices =
    sapiCheck?.status === 0 ? JSON.parse(sapiCheck.stdout || "[]") : [];

  const captureDevice = {
    win32: "gdigrab",
    linux: "x11grab",
    darwin: "avfoundation",
  }[process.platform];

  if (!captureDevice) {
    fail(`screen capture is not supported on ${process.platform}`);
  }

  const result = {
    ffmpeg,
    ffprobe,
    platform: process.platform,
    capture_device: captureDevice,
    capture_available: devices.includes(captureDevice),
    subtitles: /\bsubtitles\b/.test(filters),
    flite_tts: /\bflite\b/.test(filters),
    omlx_tts: Boolean(omlx),
    omlx_base_url: omlx?.baseUrl ?? omlxBaseUrl(),
    omlx_tts_model: omlx?.model ?? null,
    say_tts: sayTts,
    sapi_tts: sapiCheck?.status === 0 && sapiVoices.length > 0,
    sapi_voice_count: sapiVoices.length,
    default_tts: omlx ? "omlx" : nativeNarrationEngine(),
  };

  console.log(JSON.stringify(result, null, 2));

  if (!result.capture_available) {
    fail(`FFmpeg does not provide the ${captureDevice} input on this system`);
  }
}

async function voices() {
  const automatic = (options.engine ?? "auto") === "auto";
  let selection = await narrationEngine();
  let engine = selection.engine;

  if (engine === "omlx") {
    try {
      const response = await omlxRequest(
        `/v1/audio/voices?model=${encodeURIComponent(selection.omlx.model)}`,
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }

      process.stdout.write(`${JSON.stringify(await response.json(), null, 2)}\n`);

      return;
    } catch (error) {
      if (!automatic) {
        fail(`OMLX voice discovery failed: ${error.message}`);
      }

      console.error(
        `screen-record: OMLX voice discovery failed; using ${nativeNarrationEngine()}`,
      );
      selection = { engine: nativeNarrationEngine() };
      engine = selection.engine;
    }
  }

  if (engine === "sapi") {
    if (process.platform !== "win32") {
      fail("the SAPI narration engine is available only on Windows");
    }

    const powershell = findPowerShell();

    if (!powershell) {
      fail("SAPI narration requires pwsh.exe or powershell.exe");
    }

    const output = run(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        sapiScript,
        "-ListVoices",
      ],
      { capture: true },
    );

    process.stdout.write(output);

    return;
  }

  if (engine === "say") {
    if (process.platform !== "darwin") {
      fail("the say narration engine is available only on macOS");
    }

    if (!macosSayAvailable()) {
      fail("macOS narration requires /usr/bin/say");
    }

    const output = run("/usr/bin/say", ["-v", "?"], { capture: true });

    const voices = output
      .split(/\r?\n/)
      .map((line) => line.match(/^(.+?)\s+([A-Za-z]{2,3}_[A-Za-z]{2,4})\s+#/))
      .filter(Boolean)
      .map((match) => ({
        name: match[1].trim(),
        locale: match[2],
        engine: "say",
      }));

    console.log(JSON.stringify(voices, null, 2));

    return;
  }

  const result = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-f", "lavfi", "-i", "flite=list_voices=1", "-f", "null", "-"],
    { encoding: "utf8", windowsHide: true },
  );

  if (result.error) {
    fail(`could not run ffmpeg: ${result.error.message}`);
  }

  const names = [...(result.stderr ?? "").matchAll(/\]\s+([A-Za-z0-9_-]+)\r?$/gm)]
    .flatMap((match) => {
      const name = match[1];

      return ["requested"].includes(name) ? [] : [name];
    });

  console.log(
    JSON.stringify(
      names.map((name) => ({ name, engine: "flite" })),
      null,
      2,
    ),
  );
}

function devices() {
  if (process.platform === "win32") {
    const result = spawnSync(
      "ffmpeg",
      ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
      { encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 262144 },
    );

    printDeviceListing(result, "dshow");

    return;
  }

  if (process.platform === "darwin") {
    const result = spawnSync(
      "ffmpeg",
      ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
      { encoding: "utf8", timeout: 5000, maxBuffer: 262144 },
    );

    printDeviceListing(result, "avfoundation");

    return;
  }

  if (!["linux"].includes(process.platform)) fail(`screen capture is not supported on ${process.platform}`);

  if (options.json) {
    console.log(JSON.stringify({
      platform: process.platform, captureDevice: "x11grab",
      listing: `DISPLAY=${process.env.DISPLAY ?? "(unset)"}; pass videoInput for X11 and audioDevice for a PulseAudio source.`,
      permissionsVerified: false,
    }));

    return;
  }

  console.log(
    JSON.stringify(
      {
        display: process.env.DISPLAY ?? null,
        video_input: "x11grab uses DISPLAY or --video-input",
        audio_input: "pass a PulseAudio source name, commonly default",
      },
      null,
      2,
    ),
  );
}

function printDeviceListing(result, captureDevice) {
  if (result.error) fail(`device discovery failed: ${result.error.message}`);
  const listing = result.stderr ?? "";

  const marker = captureDevice === "avfoundation"
    ? /AVFoundation (?:video|audio) devices:/
    : /DirectShow (?:video|audio) devices|\((?:video|audio)\)/;

  const enumerationExit = [0, 1].includes(result.status) ||
    (captureDevice === "avfoundation" && result.status === 251);

  if (!enumerationExit || !marker.test(listing)) {
    fail(`device discovery did not return a device list (exit ${result.status}): ${listing.trim()}`);
  }

  if (options.json) {
    console.log(JSON.stringify({
      platform: process.platform, captureDevice, listing, permissionsVerified: false,
    }));
  } else {
    process.stdout.write(listing);
  }
}

async function start() {
  const output = ensureNewOutput(requireOption("output"));
  const paths = recordingPaths(output);
  const existing = readState(paths.state);

  if (existing && activeState(existing)) {
    fail(`a recording is already active for ${output}`);
  }

  if (existing && ["recording", "stopping"].includes(existing.status)) {
    fail(`stale recording state for ${output}; inspect ${paths.state} and ${paths.log} before recovery`);
  }

  const fps = Number(options.fps ?? 30);

  if (!Number.isInteger(fps) || fps < 1 || fps > 120) {
    fail("--fps must be an integer from 1 to 120");
  }

  const config = {
    output,
    fps,
    region: typeof options.region === "string" ? options.region : null,
    audioDevice:
      typeof options["audio-device"] === "string" ? options["audio-device"] : null,
    videoInput:
      typeof options["video-input"] === "string" ? options["video-input"] : null,
    ...paths,
    recordingId: randomUUID(),
  };

  let windowTarget;

  if (options["window-id"] !== undefined) {
    if (process.platform !== "win32") fail("--window-id is only supported on Windows.");

    if (typeof options["window-id"] !== "string" || !windowIdPattern.test(options["window-id"])) {
      fail("--window-id must be an ID returned by the Windows windows command.");
    }

    if (config.region || config.videoInput) {
      fail("--window-id cannot be combined with --region or --video-input.");
    }

    requireGdigrabWindowSupport();
    windowTarget = resolveWindowId(options["window-id"]);
    config.windowId = options["window-id"];
  }

  ffmpegCaptureArgs(config, windowTarget);

  let lockFd;
  let lockIdentity;

  try {
    lockFd = openSync(paths.lock, "wx", 0o600);
    lockIdentity = fstatSync(lockFd);
    writeFileSync(lockFd, config.recordingId);
    closeSync(lockFd);
    lockFd = undefined;
  } catch (error) {
    const cleanupErrors = [];

    if (lockFd !== undefined) {
      try {
        closeSync(lockFd);
      } catch (closeError) {
        if (closeError.code !== "EBADF") cleanupErrors.push(`descriptor cleanup failed: ${closeError.message}`);
      }
    }

    try {
      const current = lstatSync(paths.lock, { throwIfNoEntry: false });

      if (lockIdentity && current?.isFile() &&
        current.dev === lockIdentity.dev && current.ino === lockIdentity.ino &&
        config.recordingId.startsWith(readFileSync(paths.lock, "utf8"))) {
        rmSync(paths.lock);
      }
    } catch (cleanupError) {
      cleanupErrors.push(`lock cleanup failed: ${cleanupError.message}`);
    }

    fail(`cannot claim recording startup: ${error.message}${cleanupErrors.length ? `; ${cleanupErrors.join("; ")}` : ""}; inspect ${paths.lock} before recovery`);
  }

  rmSync(paths.state, { force: true });
  rmSync(paths.stop, { force: true });
  rmSync(paths.log, { force: true });
  const encoded = Buffer.from(JSON.stringify(config), "utf8").toString("base64url");

  const worker = await new Promise((accept, reject) => {
    const child = spawn(
      process.execPath,
      [resolve(process.argv[1]), "_capture", "--config", encoded],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      },
    );

    child.once("spawn", () => accept(child));
    child.once("error", reject);
  }).catch((error) => {
    if (existsSync(paths.lock) && readFileSync(paths.lock, "utf8") === config.recordingId) {
      rmSync(paths.lock, { force: true });
    }

    fail(`could not start detached recording worker: ${error.message}`);
  });

  worker.unref();

  for (let attempt = 0; attempt < 50; attempt += 1) {
    sleep(100);
    const state = readState(paths.state);

    if (
      state?.recordingId === config.recordingId &&
      state.status === "recording" && activeState(state) &&
      Date.now() - Date.parse(state.startedAt) >= 300
    ) {
      console.log(JSON.stringify(state, null, 2));

      return;
    }

    if (state?.status === "failed" || !worker.pid || !pidRunning(worker.pid)) {
      const log = logTail(paths.log);
      fail(`recording failed to start${log ? `\n${log}` : ""}`);
    }
  }

  fail(`recording readiness timed out; the detached worker may still be active. Run status for ${output}; inspect ${paths.log}`);
}

function captureWorker() {
  const encoded = requireOption("config");
  const config = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));

  if (!existsSync(config.lock) || readFileSync(config.lock, "utf8") !== config.recordingId) {
    fail("recording worker startup ownership changed; refusing capture");
  }

  let windowTarget;

  if (config.windowId !== undefined) {
    try {
      if (process.platform !== "win32" || typeof config.windowId !== "string" ||
        !windowIdPattern.test(config.windowId) || config.region || config.videoInput) {
        throw new Error("Invalid Windows window capture configuration.");
      }

      requireGdigrabWindowSupport();
      windowTarget = resolveWindowId(config.windowId);
    } catch (error) {
      const details = [`Could not resolve selected window before capture: ${error.message}`];

      try {
        writeFileSync(config.log, `${details[0]}\n`, { flag: "a", mode: 0o600 });
      } catch (logError) {
        details.push(`could not write worker log: ${logError.message}`);
      }

      try {
        if (existsSync(config.lock)) {
          if (readFileSync(config.lock, "utf8") === config.recordingId) {
            rmSync(config.lock);
          } else {
            details.push("startup lock ownership changed; lock was preserved");
          }
        }
      } catch (cleanupError) {
        details.push(`could not release startup lock: ${cleanupError.message}`);
      }

      fail(details.join("; "));
    }
  }

  const logFd = openSync(config.log, "a", 0o600);

  const ffmpeg = spawn("ffmpeg", ffmpegCaptureArgs(config, windowTarget), {
    stdio: ["pipe", "ignore", logFd],
    windowsHide: true,
  });

  const state = {
    status: "recording",
    output: config.output,
    workerPid: process.pid,
    ffmpegPid: ffmpeg.pid,
    startedAt: new Date().toISOString(),
    statePath: config.state,
    logPath: config.log,
    recordingId: config.recordingId,
    updatedAt: new Date().toISOString(),
  };

  let stopping = false;
  let finalized = false;
  let controllerError;

  const recordFailure = (error, operation) => {
    controllerError ??= error;

    const message = `Recording controller ${operation} failed: ${error.message}\n`;

    try {
      writeSync(logFd, message);
    } catch (logError) {
      console.error(`${message.trim()}; could not write controller log: ${logError.message}`);
    }
  };

  const persistState = () => {
    try {
      writeState(config.state, state);
    } catch (error) {
      recordFailure(error, "state persistence");
      requestStop();
    }
  };

  const requestStop = () => {
    if (finalized) return;

    if (!stopping && ffmpeg.stdin?.writable) {
      stopping = true;
      state.status = "stopping";
      state.updatedAt = new Date().toISOString();

      try {
        ffmpeg.stdin.write("q\n");
      } catch (error) {
        recordFailure(error, "graceful stop");
      }

      persistState();
    }
  };

  const interval = setInterval(() => {
    try {
      if (existsSync(config.stop)) {
        const request = readFileSync(config.stop, "utf8").trim();

        if (request === config.recordingId || !config.recordingId) requestStop();
      }

      if (ffmpeg.pid && !controllerError) {
        state.updatedAt = new Date().toISOString();
        persistState();
      }
    } catch (error) {
      recordFailure(error, "stop request");
      requestStop();
    }
  }, 200);

  process.on("SIGINT", requestStop);
  process.on("SIGTERM", requestStop);

  const finish = (code, error) => {
    if (finalized) {
      return;
    }

    finalized = true;
    clearInterval(interval);

    if (error) {
      recordFailure(error, "FFmpeg startup");
    }

    try {
      rmSync(config.stop, { force: true });
    } catch (cleanupError) {
      recordFailure(cleanupError, "stop-file cleanup");
    }

    if (ffmpeg.pid) {
      state.status = !controllerError && code === 0 && existsSync(config.output) ? "stopped" : "failed";
      state.endedAt = new Date().toISOString();
      state.updatedAt = state.endedAt;
      state.exitCode = controllerError ? 1 : code;
      persistState();
    }

    try {
      closeSync(logFd);
    } catch (closeError) {
      recordFailure(closeError, "log close");

      if (ffmpeg.pid) {
        state.status = "failed";
        state.exitCode = 1;
        persistState();
      }
    }

    try {
      if (existsSync(config.lock) && readFileSync(config.lock, "utf8") === config.recordingId) {
        rmSync(config.lock);
      }
    } catch (cleanupError) {
      console.error(`Recording controller lock cleanup failed: ${cleanupError.message}`);
      controllerError ??= cleanupError;
    }

    process.exit(controllerError ? 1 : code);
  };

  ffmpeg.once("spawn", () => {
    persistState();
  });
  ffmpeg.stdin.on("error", (error) => {
    recordFailure(error, "graceful stop");
    requestStop();
  });
  ffmpeg.once("error", (error) => {
    finish(1, error);
  });
  ffmpeg.once("close", (code) => {
    finish(code ?? 1);
  });
}

function status() {
  const output = resolve(requireOption("output"));
  const paths = recordingPaths(output);
  const state = readState(paths.state);

  if (!state) {
    if (existsSync(paths.lock)) {
      fail(`recording startup is pending or interrupted; inspect ${paths.lock} and ${paths.log}`);
    }

    console.log(JSON.stringify({ status: "not-recording", output }, null, 2));

    return;
  }

  if (recordingKey(state.output) !== recordingKey(output)) fail(`recording state output does not match ${output}`);

  if (options["recording-id"] && options["recording-id"] !== state.recordingId) {
    fail("recording identity does not match; run status and use the current recordingId");
  }

  console.log(
    JSON.stringify(
      {
        ...state,
        status:
          ["stopped", "failed"].includes(state.status) || activeState(state)
            ? state.status : "stale",
      },
      null,
      2,
    ),
  );
}

function stop() {
  const output = resolve(requireOption("output"));
  const paths = recordingPaths(output);
  const state = readState(paths.state);

  const timeout = Number(options.timeout ?? 20);

  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 120) {
    fail("--timeout must be a positive number of seconds no greater than 120");
  }

  if (!state || recordingKey(state.output) !== recordingKey(output)) {
    fail(`no active recording found for ${output}`);
  }

  if (options["recording-id"] !== state.recordingId) {
    fail("recording identity does not match; pass --recording-id retained from start; refusing to stop a different recording");
  }

  const ownsLock = () =>
    state.recordingId && existsSync(paths.lock) && readFileSync(paths.lock, "utf8") === state.recordingId;

  if (state.status === "stopped" && !ownsLock()) {
    if (!existsSync(output)) fail(`stopped recording output is missing: ${output}`);
    console.log(JSON.stringify(state));

    return;
  }

  if (!activeState(state) && !(state.status === "stopped" && ownsLock() && pidRunning(state.workerPid))) {
    fail(`recording is ${state.status === "failed" ? "failed" : "stale"}; inspect ${paths.log}`);
  }

  if (state.status !== "stopped") {
    const stopTemporary = `${paths.stop}.${randomUUID()}.tmp`;
    writeFileSync(stopTemporary, `${state.recordingId ?? new Date().toISOString()}\n`, { mode: 0o600, flag: "wx" });
    renameSync(stopTemporary, paths.stop);
  }

  const deadline = Date.now() + timeout * 1000;

  let final = readState(paths.state);

  const finalizationPending = () =>
    (final && ["recording", "stopping"].includes(final.status)) ||
    ownsLock();

  while (Date.now() < deadline && finalizationPending() && pidRunning(state.workerPid)) {
    sleep(200);
    final = readState(paths.state);
  }

  final = readState(paths.state);

  if (finalizationPending() && pidRunning(state.workerPid)) {
    fail(`graceful stop timed out; recording may still be active. Run status; inspect ${paths.log}. No process was killed.`);
  }

  if (final?.status === "failed") fail(`FFmpeg failed with exit ${final.exitCode}; inspect ${paths.log}`);

  if (final && final.status !== "stopped") fail(`recording worker ended without final state; inspect ${paths.log}`);

  if (!existsSync(output)) {
    fail(`recording stopped without producing ${output}; inspect ${paths.log}`);
  }

  console.log(JSON.stringify(final ?? { status: "stopped", output }, null, 2));
}

function probe() {
  const input = ensureInput(requireOption("input"));

  const output = run(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=filename,duration,size,bit_rate:stream=index,codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels",
      "-of",
      "json",
      input,
    ],
    { capture: true },
  );

  process.stdout.write(output);
}

function trim() {
  const input = ensureInput(requireOption("input"));
  const output = ensureNewOutput(requireOption("output"));
  const startAt = requireOption("start");

  if (!options.end && !options.duration) {
    fail("trim requires --end or --duration");
  }

  if (options.end && options.duration) {
    fail("trim accepts only one of --end or --duration");
  }

  const commandArgs = ["-hide_banner", "-i", input, "-ss", startAt];

  if (options.end) {
    commandArgs.push("-to", options.end);
  } else {
    commandArgs.push("-t", options.duration);
  }

  if (options.copy) {
    commandArgs.push("-c", "copy");
  } else {
    commandArgs.push(
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "18",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
    );
  }

  commandArgs.push(output);
  run("ffmpeg", commandArgs);
}

function sideBySide() {
  const left = ensureInput(requireOption("left"));
  const right = ensureInput(requireOption("right"));
  const output = ensureNewOutput(requireOption("output"));
  const height = Number(options.height ?? 720);

  if (!Number.isInteger(height) || height < 2 || height % 2 !== 0) {
    fail("--height must be a positive even integer");
  }

  run("ffmpeg", [
    "-hide_banner",
    "-i",
    left,
    "-i",
    right,
    "-filter_complex",
    `[0:v]scale=-2:${height}[left];[1:v]scale=-2:${height}[right];[left][right]hstack=inputs=2:shortest=1[video]`,
    "-map",
    "[video]",
    "-map",
    "0:a?",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-c:a",
    "aac",
    "-shortest",
    "-movflags",
    "+faststart",
    output,
  ]);
}

function filterPath(path) {
  return resolve(path)
    .replaceAll("\\", "/")
    .replaceAll(":", "\\:")
    .replaceAll("'", "\\'");
}

function subtitles() {
  const input = ensureInput(requireOption("input"));
  const srt = ensureInput(requireOption("srt"));
  const output = ensureNewOutput(requireOption("output"));
  run("ffmpeg", [
    "-hide_banner",
    "-i",
    input,
    "-vf",
    `subtitles=filename='${filterPath(srt)}'`,
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-c:a",
    "copy",
    "-movflags",
    "+faststart",
    output,
  ]);
}

async function narrate() {
  const textFile = ensureInput(requireOption("text-file"));
  const output = ensureNewOutput(requireOption("output"));
  const automatic = (options.engine ?? "auto") === "auto";
  let selection = await narrationEngine();
  let engine = selection.engine;
  let useNativeOptions = true;

  if (engine === "omlx") {
    if (extname(output).toLowerCase() !== ".wav") {
      fail("OMLX narration output must use the .wav extension");
    }

    const speed = Number(options.speed ?? 1);

    if (!Number.isFinite(speed) || speed <= 0) {
      fail("--speed must be a positive number");
    }

    const payload = {
      model: selection.omlx.model,
      input: readFileSync(textFile, "utf8"),
      response_format: "wav",
      speed,
    };

    if (typeof options.voice === "string") {
      payload.voice = options.voice;
    }

    if (typeof options.language === "string") {
      payload.language = options.language;
    }

    if (typeof options.instructions === "string") {
      payload.instructions = options.instructions;
    }

    try {
      const response = await omlxRequest(
        "/v1/audio/speech",
        {
          method: "POST",
          body: JSON.stringify(payload),
        },
        120000,
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }

      writeFileSync(output, Buffer.from(await response.arrayBuffer()));

      return;
    } catch (error) {
      if (!automatic) {
        fail(`OMLX narration failed: ${error.message}`);
      }

      console.error(
        `screen-record: OMLX narration failed; using ${nativeNarrationEngine()}`,
      );
      selection = { engine: nativeNarrationEngine() };
      engine = selection.engine;
      useNativeOptions = false;
    }
  }

  if (engine === "sapi") {
    if (process.platform !== "win32") {
      fail("the SAPI narration engine is available only on Windows");
    }

    const powershell = findPowerShell();

    if (!powershell) {
      fail("SAPI narration requires pwsh.exe or powershell.exe");
    }

    if (extname(output).toLowerCase() !== ".wav") {
      fail("SAPI narration output must use the .wav extension");
    }

    const rate = Number(useNativeOptions ? (options.rate ?? 0) : 0);
    const volume = Number(useNativeOptions ? (options.volume ?? 100) : 100);

    if (!Number.isInteger(rate) || rate < -10 || rate > 10) {
      fail("--rate must be an integer from -10 to 10");
    }

    if (!Number.isInteger(volume) || volume < 0 || volume > 100) {
      fail("--volume must be an integer from 0 to 100");
    }

    const sapiArgs = [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      sapiScript,
      "-TextFile",
      textFile,
      "-Output",
      output,
      "-Rate",
      String(rate),
      "-Volume",
      String(volume),
    ];

    if (useNativeOptions && typeof options.voice === "string") {
      sapiArgs.push("-Voice", options.voice);
    }

    run(powershell, sapiArgs);

    return;
  }

  if (engine === "say") {
    if (process.platform !== "darwin") {
      fail("the say narration engine is available only on macOS");
    }

    if (!macosSayAvailable()) {
      fail("macOS narration requires /usr/bin/say");
    }

    if (extname(output).toLowerCase() !== ".wav") {
      fail("macOS say narration output must use the .wav extension");
    }

    if (useNativeOptions && options.volume !== undefined) {
      fail("--volume is supported only by the SAPI engine");
    }

    const sayArgs = [
      "--file-format=WAVE",
      "--data-format=LEI16@48000",
      "-o",
      output,
      "-f",
      textFile,
    ];

    if (useNativeOptions && typeof options.voice === "string") {
      sayArgs.unshift("-v", options.voice);
    }

    if (useNativeOptions && options.rate !== undefined) {
      const rate = Number(options.rate);

      if (!Number.isFinite(rate) || rate <= 0) {
        fail("--rate must be a positive words-per-minute value for the say engine");
      }

      sayArgs.unshift("-r", String(rate));
    }

    run("/usr/bin/say", sayArgs);

    return;
  }

  if (useNativeOptions && options.rate !== undefined) {
    fail("--rate is supported only by the SAPI and say engines");
  }

  if (useNativeOptions && options.volume !== undefined) {
    fail("--volume is supported only by the SAPI engine");
  }

  const voice = useNativeOptions ? (options.voice ?? "slt") : "slt";

  if (!/^[A-Za-z0-9_-]+$/.test(voice)) {
    fail("--voice contains unsupported characters");
  }

  run("ffmpeg", [
    "-hide_banner",
    "-f",
    "lavfi",
    "-i",
    `flite=textfile='${filterPath(textFile)}':voice=${voice}`,
    "-ar",
    "48000",
    "-ac",
    "1",
    output,
  ]);
}

function dub() {
  const video = ensureInput(requireOption("video"));
  const audio = ensureInput(requireOption("audio"));
  const output = ensureNewOutput(requireOption("output"));
  const commandArgs = ["-hide_banner", "-i", video, "-i", audio];

  if (options["mix-original"]) {
    commandArgs.push(
      "-filter_complex",
      "[0:a]volume=0.25[original];[original][1:a]amix=inputs=2:duration=longest:normalize=0[mixed]",
      "-map",
      "0:v",
      "-map",
      "[mixed]",
    );
  } else {
    commandArgs.push("-map", "0:v", "-map", "1:a", "-af", "apad");
  }

  commandArgs.push(
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-ar",
    "48000",
    "-b:a",
    "192k",
    "-shortest",
    "-movflags",
    "+faststart",
    output,
  );
  run("ffmpeg", commandArgs);
}

function usage() {
  console.log(`Usage: node scripts/screen-record.mjs <command> [options]

Commands:
  doctor [--capture-only]
  devices [--json]
  windows [--json]
  voices [--engine omlx|sapi|say|flite] [--model <name>]
  start --output <file> [--fps 30] [--region x,y,w,h]
        [--audio-device <name>] [--video-input <source>] [--window-id <id>]
  status --output <file> [--recording-id <id>]
  stop --output <file> [--recording-id <id>] [--timeout 20]
       (recording-id required unless persisted legacy state has no ID;
        timeout must be at most 120 seconds)
  probe --input <file>
  trim --input <file> --output <file> --start <time>
       (--end <time> | --duration <time>) [--copy]
  side-by-side --left <file> --right <file> --output <file> [--height 720]
  subtitles --input <file> --srt <file> --output <file>
  narrate --text-file <file> --output <file>
           [--engine omlx|sapi|say|flite] [--model <name>] [--voice <name>]
           [--speed 1] [--language <code>] [--instructions <text>]
           [--rate <value>] [--volume 100]
  dub --video <file> --audio <file> --output <file> [--mix-original]`);
}

switch (command) {
  case "doctor":
    await doctor();
    break;
  case "windows":
    windows();
    break;
  case "devices":
    devices();
    break;
  case "voices":
    await voices();
    break;
  case "start":
    await start();
    break;
  case "_capture":
    captureWorker();
    break;
  case "status":
    status();
    break;
  case "stop":
    stop();
    break;
  case "probe":
    probe();
    break;
  case "trim":
    trim();
    break;
  case "side-by-side":
    sideBySide();
    break;
  case "subtitles":
    subtitles();
    break;
  case "narrate":
    await narrate();
    break;
  case "dub":
    dub();
    break;
  case "help":
  case "--help":
  case "-h":
  case undefined:
    usage();
    break;
  default:
    fail(`unknown command: ${command}`);
}
