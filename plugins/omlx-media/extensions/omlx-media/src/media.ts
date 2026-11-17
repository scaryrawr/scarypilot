#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { Value } from "@sinclair/typebox/value";
import { executeImage } from "./execute-image.ts";
import { executeSpeech, executeTranscription } from "./execute-audio.ts";
import { imageParameters, speechParameters, transcriptionParameters, framesParameters } from "./tool-schemas.ts";
import { OmlxToolError } from "./domain.ts";
import { prepareRecording } from "./prepare-recording.ts";
import { prepareFrames } from "./prepare-frames.ts";

const [operation, option, value, ...extra] = process.argv.slice(2);

if (["--help", "-h"].includes(operation) || !operation) {
  console.log(`Usage: node <plugin-root>/scripts/media.mjs <image|speech|transcribe|prepare-frames> --input-json <file>
       node <plugin-root>/scripts/media.mjs <image|speech|transcribe|prepare-frames> --json '<arguments>'

Uses OMLX_BASE_URL (default http://127.0.0.1:8000) and optional OMLX_API_KEY.
Outputs must be new absolute paths. Source files are never modified.
Image: prompt, output (.png), sources?, mask?, size?, model?, variants?, strength?, advanced?
Speech: input (text), output (.wav), model?, voice?, language?, speed?, instructions?, response_format?
Transcribe: input (audio path), output (.txt), model?, language?, prompt?
Recording: transcribe with input and output_dir instead of output; model?, language?, prompt?,
           chunk_seconds? (10-120, default 60), timeout_seconds? (1-1800, default 600), allow_remote?
Frames: prepare-frames with input and output_dir; max_frames? (1-120, default 24), start?, end?,
        OR seconds? (unique source timestamps); width? (1-4096, default 1280), crop?, format? (png|jpeg),
        timeout_seconds? (1-1800, default 600)
Preparation: at most 2 hours/4 GiB, fresh directory outside the plugin with an existing parent.
Recording: 120 serial chunks, 120-second requests, literal loopback unless allow_remote=true; no redirects.
Frames: 256 megapixels total; requested timestamps are not frame PTS; JPEG for classify_frames.py.
Failures retain partial files and failure.json; retry into a new directory.
Results are JSON on stdout. Errors go to stderr with exit code 1.`);
} else {
  const controller = new AbortController();
  const cancel = () => controller.abort(new OmlxToolError("CANCELLED", "Media preparation was cancelled"));

  try {
    if (!value || extra.length || !["--input-json", "--json"].includes(option)) throw new Error("Use --input-json <file> or --json '<arguments>'; see --help");
    const args: unknown = JSON.parse(option === "--input-json" ? await readFile(value, "utf8") : value);
    let result;

    switch (operation) {
      case "image":
        if (!Value.Check(imageParameters, args)) throw new Error("Invalid image arguments");
        result = await executeImage(args);
        break;
      case "speech":
        if (!Value.Check(speechParameters, args)) throw new Error("Invalid speech arguments");
        result = await executeSpeech(args);
        break;
      case "transcribe":
        if (!Value.Check(transcriptionParameters, args)) throw new Error("Invalid transcription arguments");

        if ("output_dir" in args) {
          process.once("SIGINT", cancel);
          process.once("SIGTERM", cancel);
          result = await prepareRecording(args, {}, controller.signal);
        } else {
          result = await executeTranscription(args);
        }

        break;
      case "prepare-frames":
        if (!Value.Check(framesParameters, args)) throw new Error("Invalid frame preparation arguments");
        process.once("SIGINT", cancel);
        process.once("SIGTERM", cancel);
        result = await prepareFrames(args, {}, controller.signal);
        break;
      default: throw new Error(`Unknown operation: ${operation}`);
    }

    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof OmlxToolError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
