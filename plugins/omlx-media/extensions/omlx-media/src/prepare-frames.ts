import * as path from "node:path";
import { OmlxToolError } from "./domain.ts";
import { type FramesArgs, type PreparedFrame } from "./media-domain.ts";
import {
  abortError, boundedOperation, freshDirectory, probeFrame, probeMedia, publishManifest, reserveDirectory,
  retainedArtifacts, runMediaProcess, sourceFile,
  type MediaDependencies,
} from "./media-io.ts";

export async function prepareFrames(
  args: FramesArgs,
  dependencies: MediaDependencies = {},
  invocationSignal?: AbortSignal,
): Promise<{ directory: string; manifest: string; frames: number }> {
  return boundedOperation(args.timeout_seconds, invocationSignal, async (signal) => {
    if (args.seconds && (args.start !== undefined || args.end !== undefined || args.max_frames !== undefined)) {
      throw new OmlxToolError("INVALID_INPUT", "seconds is mutually exclusive with start, end and max_frames");
    }

    const source = await sourceFile(args.input);
    const requested = await freshDirectory(args.output_dir);
    const runner = dependencies.processRunner ?? runMediaProcess;
    const media = await probeMedia(source, runner, signal);
    const video = media.streams.find((stream) => stream.codec_type === "video");

    if (!video || !video.width || !video.height) throw new OmlxToolError("NO_VIDEO_STREAM", "Source has no video stream to extract");
    const start = args.start ?? 0;
    const end = args.end ?? media.duration;

    if (start >= end || end > media.duration) throw new OmlxToolError("INVALID_RANGE", "Require 0 <= start < end <= source duration");
    const count = args.max_frames ?? 24;
    const seconds = args.seconds ?? Array.from({ length: count }, (_, index) => start + (end - start) * index / count);

    if (seconds.some((second) => second >= media.duration)) {
      throw new OmlxToolError("INVALID_RANGE", "Explicit seconds must be less than source duration");
    }

    const crop = args.crop;

    if (crop && (crop.x + crop.width > video.width || crop.y + crop.height > video.height)) {
      throw new OmlxToolError("INVALID_CROP", "Crop must be contained in the probed original video dimensions");
    }

    const originalWidth = crop?.width ?? video.width;
    const originalHeight = crop?.height ?? video.height;
    const width = Math.min(args.width ?? 1280, originalWidth);
    const height = Math.max(1, Math.round(originalHeight * width / originalWidth));

    if (width * height * seconds.length > 268_435_456) {
      throw new OmlxToolError("FRAME_WORK_LIMIT", "Requested frames exceed the 256 megapixel total output limit; reduce width or max_frames");
    }

    await runner("ffmpeg", ["-version"], signal);
    signal.throwIfAborted();
    const directory = await reserveDirectory(requested);

    try {
      const frames: PreparedFrame[] = [];
      const format = args.format ?? "png";

      const filters = [
        "fps=1:start_time=0:round=up:eof_action=pass",
        ...(crop ? [`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}:exact=1`] : []),
        `scale=${width}:${height}`, "setsar=1",
      ].join(",");

      for (const [index, second] of seconds.entries()) {
        signal.throwIfAborted();
        const wholeSeconds = Math.round(second);
        const timestamp = `${String(Math.floor(wholeSeconds / 60)).padStart(3, "0")}m${String(wholeSeconds % 60).padStart(2, "0")}s`;
        const file = path.join(directory, `t_${timestamp}_f${String(index).padStart(4, "0")}.${format === "jpeg" ? "jpg" : "png"}`);
        await runner("ffmpeg", [
          "-nostdin", "-hide_banner", "-loglevel", "error", "-n", "-noautorotate",
          "-threads", "1", "-filter_threads", "1",
          "-protocol_whitelist", "file,pipe", "-noaccurate_seek", "-ss", String(second),
          "-i", source, "-map", `0:${video.index}`, "-frames:v", "1",
          "-vf", filters, "-c:v", format === "jpeg" ? "mjpeg" : "png",
          "-threads", "1", "-update", "1", file,
        ], signal);
        const frame = (await probeFrame(file, runner, signal)).find((stream) => stream.codec_type === "video");

        if (!frame || frame.width !== width || frame.height !== height) {
          throw new OmlxToolError("INVALID_MEDIA", "Extracted frame dimensions do not match the requested crop and width");
        }

        frames.push({ index, requested_seconds: second, file });
      }

      signal.throwIfAborted();
      const manifest = path.join(directory, "manifest.json");
      await publishManifest(manifest, JSON.stringify({
        status: "complete", kind: "frames", source, source_duration_seconds: media.duration,
        timing: "Requested source timestamps in seconds; selects the frame covering each request, including the final frame interval. Requests are resolved at ffmpeg microsecond seek precision, not measured frame PTS.",
        filename_timing: "Requested seconds rounded to the nearest whole second with zero-based frame indices; frames[].requested_seconds retains exact fractional timestamps.",
        sampling: args.seconds ? "explicit" : "periodic-start-inclusive-end-exclusive",
        range: args.seconds ? undefined : { start_seconds: start, end_seconds: end },
        source_dimensions: { width: video.width, height: video.height },
        dimensions: { width, height }, orientation: "unrotated stream pixels; display rotation is not applied",
        crop, format, frames,
      }, null, 2), signal);

      return { directory, manifest, frames: frames.length };
    } catch (error) {
      const failure = signal.aborted ? abortError(signal) : error instanceof OmlxToolError ? error
        : new OmlxToolError("MEDIA_PREPARATION_FAILED", error instanceof Error ? error.message : String(error));

      throw retainedArtifacts(failure, directory);
    }
  });
}
