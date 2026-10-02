import { spawn } from "node:child_process";
import { link, lstat, mkdir, realpath, stat, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { OmlxToolError, type FetchImplementation } from "./domain.ts";

export interface MediaDependencies {
  environment?: NodeJS.ProcessEnv;
  fetchImplementation?: FetchImplementation;
  processRunner?: ProcessRunner;
}

export type ProcessRunner = (command: "ffmpeg" | "ffprobe", args: string[], signal: AbortSignal) => Promise<string>;

export const MAX_DURATION_SECONDS = 7200;

const MAX_SOURCE_BYTES = 4 * 1024 ** 3;

const MAX_PROCESS_BYTES = 64 * 1024;

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export function abortError(signal: AbortSignal): OmlxToolError {
  return signal.reason instanceof OmlxToolError
    ? signal.reason
    : new OmlxToolError("CANCELLED", "Media preparation was cancelled");
}

export async function boundedOperation<T>(
  timeoutSeconds: number | undefined,
  invocationSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const signal = invocationSignal ? AbortSignal.any([controller.signal, invocationSignal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new OmlxToolError("OPERATION_TIMEOUT", "Media preparation exceeded its total deadline")), (timeoutSeconds ?? 600) * 1000);

  try {
    signal.throwIfAborted();

    return await operation(signal);
  } catch (error) {
    if (signal.aborted && !(error instanceof OmlxToolError)) throw abortError(signal);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export const runMediaProcess: ProcessRunner = async (command, args, signal) => {
  if (signal.aborted) throw abortError(signal);

  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: OmlxToolError | undefined;

    const stop = (error: OmlxToolError) => {
      failure ??= error;
      child.kill("SIGKILL");
    };

    const abort = () => stop(abortError(signal));
    signal.addEventListener("abort", abort, { once: true });

    if (signal.aborted) abort();

    const collect = (target: Buffer[], data: Buffer) => {
      bytes += data.length;

      if (bytes > MAX_PROCESS_BYTES) {
        stop(new OmlxToolError("MEDIA_DIAGNOSTICS_LIMIT", `${command} exceeded its 64 KiB diagnostic limit`));
      } else {
        target.push(data);
      }
    };

    child.stdout.on("data", (data: Buffer) => collect(stdout, data));
    child.stderr.on("data", (data: Buffer) => collect(stderr, data));
    child.once("error", (error: NodeJS.ErrnoException) => {
      signal.removeEventListener("abort", abort);
      reject(error.code === "ENOENT"
        ? new OmlxToolError(command === "ffmpeg" ? "FFMPEG_NOT_FOUND" : "FFPROBE_NOT_FOUND", `Install ffmpeg (including ffprobe) and make ${command} available on PATH`)
        : new OmlxToolError("MEDIA_PROCESS_FAILED", `Could not start ${command}: ${error.message}`));
    });
    child.once("close", (code) => {
      signal.removeEventListener("abort", abort);

      if (failure) reject(failure);
      else if (code !== 0) reject(new OmlxToolError("MEDIA_PROCESS_FAILED", `${command} exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
      else resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });
};

export function mediaPath(value: string): string {
  if (!path.isAbsolute(value)) throw new OmlxToolError("ABSOLUTE_PATH_REQUIRED", `Path must be absolute: ${value}`);

  if (value.includes("\0") || value.split(/[\\/]/).includes("..")) {
    throw new OmlxToolError("INVALID_PATH", "Media paths must not contain NUL or parent traversal segments");
  }

  return path.resolve(value);
}

async function canonicalTarget(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    const parent = path.dirname(candidate);

    if (parent === candidate) throw error;

    return path.join(await canonicalTarget(parent), path.basename(candidate));
  }
}

export async function guardPluginOutput(candidate: string): Promise<void> {
  const target = await canonicalTarget(candidate);
  const root = await realpath(PLUGIN_ROOT);
  const relative = path.relative(root, target);

  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new OmlxToolError("PLUGIN_OUTPUT_FORBIDDEN", "Outputs must be outside the installed omlx-media plugin tree");
  }
}

export async function sourceFile(value: string): Promise<string> {
  const candidate = mediaPath(value);
  let source: string;

  try {
    source = await realpath(candidate);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new OmlxToolError("INPUT_NOT_FOUND", `Media source was not found: ${candidate}`);
    }

    throw error;
  }

  const info = await stat(source);

  if (!info.isFile() || info.size === 0 || info.size > MAX_SOURCE_BYTES) {
    throw new OmlxToolError("INVALID_INPUT", "Media source must be a nonempty file no larger than 4 GiB");
  }

  return source;
}

export async function freshDirectory(value: string): Promise<string> {
  const candidate = mediaPath(value);
  await guardPluginOutput(candidate);

  try {
    await lstat(candidate);
    throw new OmlxToolError("OUTPUT_CONFLICT", `Output directory already exists (including symlinks): ${candidate}`);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }

  return candidate;
}

export async function reserveDirectory(candidate: string): Promise<string> {
  try {
    const parent = await realpath(path.dirname(candidate));
    const output = path.join(parent, path.basename(candidate));
    await guardPluginOutput(output);
    await mkdir(output);

    return output;
  } catch (error) {
    if (error instanceof OmlxToolError) throw error;

    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new OmlxToolError("OUTPUT_CONFLICT", `Output directory already exists: ${candidate}`);
    }

    throw new OmlxToolError("INVALID_OUTPUT", `Cannot create fresh output directory; its parent must exist: ${candidate}. ${error instanceof Error ? error.message : String(error)}`);
  }

}

export function retainedArtifacts(error: OmlxToolError, directory: string): OmlxToolError {
  return new OmlxToolError(
    error.code,
    `${error.message}. Incomplete artifacts retained at ${directory}. Retry with a new output_dir.`,
  );
}

export async function writeArtifact(file: string, content: string): Promise<void> {
  await writeFile(file, content, { flag: "wx" });
}

export async function publishManifest(file: string, content: string, signal: AbortSignal): Promise<void> {
  const pending = `${file}.incomplete`;
  await writeArtifact(pending, content);
  signal.throwIfAborted();
  await link(pending, file);
  await unlink(pending);
}

const ProbeSchema = Type.Object({
  format: Type.Optional(Type.Object({
    duration: Type.Optional(Type.String({ minLength: 1 })),
    start_time: Type.Optional(Type.String()),
  })),
  streams: Type.Array(Type.Object({
    index: Type.Integer({ minimum: 0 }),
    codec_type: Type.String(),
    width: Type.Optional(Type.Integer({ minimum: 1, maximum: 16384 })),
    height: Type.Optional(Type.Integer({ minimum: 1, maximum: 16384 })),
    sample_rate: Type.Optional(Type.String()),
    channels: Type.Optional(Type.Integer({ minimum: 1 })),
    start_time: Type.Optional(Type.String()),
    duration: Type.Optional(Type.String()),
  }), { maxItems: 128 }),
});

export type MediaStream = Static<typeof ProbeSchema>["streams"][number];

export interface MediaProbe {
  duration: number;
  streams: MediaStream[];
  audioRange?: { start: number; end?: number };
  videoRange?: { start: number; end?: number };
}

export async function probeStreamDuration(source: string, index: number, kind: "audio" | "video", runner: ProcessRunner, signal: AbortSignal): Promise<number> {
  const progress = await runner("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "1",
    "-filter_threads", "1", "-stats_period", "86400", "-progress", "pipe:1",
    "-protocol_whitelist", "file,pipe", "-noautorotate", "-i", source, "-map", `0:${index}`,
    ...(kind === "audio"
      ? ["-vn", "-af", "asetpts=PTS-STARTPTS", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"]
      : ["-an", "-vf", "setpts=PTS-STARTPTS", "-fps_mode", "passthrough", "-c:v", "wrapped_avframe"]),
    "-t", String(MAX_DURATION_SECONDS), "-threads", "1", "-f", "null", "-",
  ], signal);

  const finalTime = [...progress.matchAll(/^out_time_us=(\d+)\r?$/gm)].at(-1);
  const duration = finalTime ? Number(finalTime[1]) / 1_000_000 : NaN;

  if (!/^progress=end\r?$/m.test(progress) || !Number.isFinite(duration) || duration <= 0 || duration > MAX_DURATION_SECONDS) {
    throw new OmlxToolError("INVALID_MEDIA", `Could not determine the selected ${kind} stream's finite positive extent`);
  }

  return duration;
}

async function probe(source: string, runner: ProcessRunner, signal: AbortSignal): Promise<Static<typeof ProbeSchema>> {
  const raw = await runner("ffprobe", [
    "-v", "error", "-protocol_whitelist", "file,pipe",
    "-show_entries", "format=duration,start_time:stream=index,codec_type,width,height,sample_rate,channels,start_time,duration",
    "-of", "json", source,
  ], signal);

  let payload: unknown;

  try {
    payload = JSON.parse(raw);
  } catch {
    throw new OmlxToolError("INVALID_MEDIA", "ffprobe returned malformed JSON");
  }

  if (!Value.Check(ProbeSchema, payload)) throw new OmlxToolError("INVALID_MEDIA", "ffprobe returned invalid duration or stream metadata");

  return payload;
}

export async function probeFrame(source: string, runner: ProcessRunner, signal: AbortSignal): Promise<MediaStream[]> {
  return (await probe(source, runner, signal)).streams;
}

export async function probeMedia(source: string, runner: ProcessRunner, signal: AbortSignal): Promise<MediaProbe> {
  const payload = await probe(source, runner, signal);
  const duration = Number(payload.format?.duration);

  if (!Number.isFinite(duration) || duration <= 0) throw new OmlxToolError("INVALID_MEDIA", "Media must have a finite positive duration");

  if (duration > MAX_DURATION_SECONDS) throw new OmlxToolError("MEDIA_DURATION_LIMIT", "Media must be no longer than 2 hours");

  for (const stream of payload.streams) {
    if (stream.codec_type === "video" && (!stream.width || !stream.height || stream.width * stream.height > 33_554_432)) {
      throw new OmlxToolError("MEDIA_DIMENSION_LIMIT", "Video streams must have valid dimensions and at most 32 megapixels");
    }
  }

  const ranges: Pick<MediaProbe, "audioRange" | "videoRange"> = {};

  for (const kind of ["audio", "video"] as const) {
    const stream = payload.streams.find((candidate) => candidate.codec_type === kind);

    if (!stream) continue;
    const origin = Number(payload.format?.start_time ?? "0");
    const streamStart = Number(stream.start_time ?? String(origin));
    const streamDuration = stream.duration === undefined ? undefined : Number(stream.duration);
    const label = kind === "audio" ? "Audio" : "Video";

    if (!Number.isFinite(origin) || !Number.isFinite(streamStart) ||
        (streamDuration !== undefined && (!Number.isFinite(streamDuration) || streamDuration <= 0))) {
      throw new OmlxToolError("INVALID_MEDIA", `${label} stream timing metadata must be finite with positive duration`);
    }

    const start = Math.max(0, streamStart - origin);
    const end = streamDuration === undefined ? undefined : Math.min(duration, streamStart - origin + streamDuration);

    if (start >= duration || (end !== undefined && start >= end)) {
      throw new OmlxToolError("INVALID_MEDIA", `${label} stream does not overlap the source duration`);
    }

    ranges[kind === "audio" ? "audioRange" : "videoRange"] = { start, end };
  }

  return { duration, streams: payload.streams, ...ranges };
}
