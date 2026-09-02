#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, extname, resolve } from "node:path";
import { tmpdir } from "node:os";
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
      { encoding: "utf8", windowsHide: true },
    );
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

function recordingPaths(output) {
  const id = createHash("sha256").update(resolve(output)).digest("hex").slice(0, 16);
  const root = resolve(tmpdir(), "scarypilot-screen-record");
  mkdirSync(root, { recursive: true });
  return {
    state: resolve(root, `${id}.json`),
    stop: resolve(root, `${id}.stop`),
    log: resolve(root, `${id}.log`),
  };
}

function readState(path) {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`invalid recording state ${path}: ${error.message}`);
  }
}

function pidRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

function ffmpegCaptureArgs(config) {
  const ffmpegArgs = ["-hide_banner", "-y"];
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
    ffmpegArgs.push("-i", "desktop");
    if (config.audioDevice) {
      ffmpegArgs.push("-f", "dshow", "-i", `audio=${config.audioDevice}`);
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
    .map((match) => match[1])
    .filter((name) => !["requested"].includes(name));
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
      { encoding: "utf8", windowsHide: true },
    );
    process.stdout.write(result.stderr ?? "");
    return;
  }
  if (process.platform === "darwin") {
    const result = spawnSync(
      "ffmpeg",
      ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
      { encoding: "utf8" },
    );
    process.stdout.write(result.stderr ?? "");
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

function start() {
  const output = ensureNewOutput(requireOption("output"));
  const paths = recordingPaths(output);
  const existing = readState(paths.state);
  if (existing && pidRunning(existing.workerPid)) {
    fail(`a recording is already active for ${output}`);
  }
  rmSync(paths.state, { force: true });
  rmSync(paths.stop, { force: true });
  rmSync(paths.log, { force: true });

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
  };
  ffmpegCaptureArgs(config);
  const encoded = Buffer.from(JSON.stringify(config), "utf8").toString("base64url");
  const worker = spawn(
    process.execPath,
    [resolve(process.argv[1]), "_capture", "--config", encoded],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  worker.unref();

  for (let attempt = 0; attempt < 50; attempt += 1) {
    sleep(100);
    const state = readState(paths.state);
    if (
      state?.status === "recording" &&
      pidRunning(state.workerPid) &&
      pidRunning(state.ffmpegPid)
    ) {
      console.log(JSON.stringify(state, null, 2));
      return;
    }
    if (!pidRunning(worker.pid)) {
      const log = existsSync(paths.log) ? readFileSync(paths.log, "utf8") : "";
      fail(`recording failed to start${log ? `\n${log}` : ""}`);
    }
  }
  fail(`recording did not become ready; inspect ${paths.log}`);
}

function captureWorker() {
  const encoded = requireOption("config");
  const config = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  const logFd = openSync(config.log, "a");
  const ffmpeg = spawn("ffmpeg", ffmpegCaptureArgs(config), {
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
  };

  let stopping = false;
  let finalized = false;
  const requestStop = () => {
    if (!stopping && ffmpeg.stdin?.writable) {
      stopping = true;
      ffmpeg.stdin.write("q\n");
    }
  };
  const interval = setInterval(() => {
    if (existsSync(config.stop)) {
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
      writeFileSync(config.log, `Could not start ffmpeg: ${error.message}\n`, {
        flag: "a",
      });
    }
    closeSync(logFd);
    rmSync(config.stop, { force: true });
    rmSync(config.state, { force: true });
    process.exit(code);
  };

  ffmpeg.once("spawn", () => {
    writeFileSync(config.state, `${JSON.stringify(state, null, 2)}\n`);
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
    console.log(JSON.stringify({ status: "not-recording", output }, null, 2));
    return;
  }
  console.log(
    JSON.stringify(
      {
        ...state,
        status:
          pidRunning(state.workerPid) && pidRunning(state.ffmpegPid)
            ? state.status
            : "stale",
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
  if (
    !state ||
    !pidRunning(state.workerPid) ||
    !pidRunning(state.ffmpegPid)
  ) {
    fail(`no active recording found for ${output}`);
  }
  writeFileSync(paths.stop, `${new Date().toISOString()}\n`);
  const timeout = Number(options.timeout ?? 20);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    fail("--timeout must be a positive number of seconds");
  }
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline && pidRunning(state.workerPid)) {
    sleep(200);
  }
  if (pidRunning(state.workerPid)) {
    fail(`graceful stop timed out; inspect ${paths.log}`);
  }
  if (!existsSync(output)) {
    fail(`recording stopped without producing ${output}; inspect ${paths.log}`);
  }
  console.log(JSON.stringify({ status: "stopped", output }, null, 2));
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
  doctor
  devices
  voices [--engine omlx|sapi|say|flite] [--model <name>]
  start --output <file> [--fps 30] [--region x,y,w,h]
        [--audio-device <name>] [--video-input <source>]
  status --output <file>
  stop --output <file> [--timeout 20]
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
  case "devices":
    devices();
    break;
  case "voices":
    await voices();
    break;
  case "start":
    start();
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
