import type { Tool, ToolResultObject } from "@github/copilot-sdk";
import { Value } from "@sinclair/typebox/value";
import { OmlxToolError } from "./domain.ts";
import { FramesSchema, type FramesResult } from "./media-domain.ts";
import { type MediaDependencies } from "./media-io.ts";
import { prepareFrames } from "./prepare-frames.ts";

export function createOmlxPrepareFramesTool(dependencies: MediaDependencies = {}): Tool {
  return {
    name: "omlx_prepare_frames",
    description: "Extract bounded video frames without ranking, classification or deduplication. Use a fresh absolute output_dir outside the plugin tree with an existing parent. Source is preserved. Defaults to 24 periodic samples across the duration, start inclusive and end exclusive, or provide unique seconds instead of start/end/max_frames. PNG by default; select format='jpeg' for classify_frames.py-compatible .jpg candidates. Filenames use t_<MMMmSSs>_fNNNN with rounded requested seconds, three-digit minutes and a zero-based four-digit index; manifest.json retains exact fractional requested timestamps. PNG output is not discovered by that script. Width defaults to 1280, maximum 4096, never upscales; crop uses original unrotated stream pixels before scaling. At most 120 frames, 256 megapixels total, 2-hour/4-GiB source, 600-second default total deadline. Requires ffmpeg/ffprobe. Selects the frame covering each requested instant, including the final frame interval; timestamps are requests, not measured frame PTS. Retry failures or re-extract selections/crops into a new directory.",
    parameters: FramesSchema,
    handler: async (args, invocation) => {
      try {
        if (!Value.Check(FramesSchema, args)) {
          throw new OmlxToolError("INVALID_INPUT", "Require absolute input/output_dir and finite bounded frame options");
        }

        const result = await prepareFrames(args, dependencies, invocation?.signal);

        const response: FramesResult = {
          kind: "frames",
          ...result,
          format: args.format ?? "png",
          timing: "Timestamps are requested source times; selects the covering frame, including the final frame interval, not measured frame PTS.",
          classification_script_compatible: args.format === "jpeg",
        };

        if (response.format === "png") {
          response.compatibility_note = "PNG output is not discovered by classify_frames.py, which requires .jpg files.";
        }

        return {
          resultType: "success",
          textResultForLlm: JSON.stringify(response),
        } satisfies ToolResultObject;
      } catch (error) {
        const failure = error instanceof OmlxToolError ? error
          : new OmlxToolError("MEDIA_PREPARATION_FAILED", error instanceof Error ? error.message : String(error));

        const message = `${failure.code}: ${failure.message}`;

        return {
          resultType: "failure",
          error: message,
          textResultForLlm: `❌ ${message}`,
        } satisfies ToolResultObject;
      }
    },
  };
}
