import type { Tool, ToolResultObject } from "@github/copilot-sdk";
import { Value } from "@sinclair/typebox/value";
import {
  OmlxToolError,
  type OmlxSpeechArgs,
} from "./domain.ts";
import { executeSpeech, executeTranscription } from "./execute-audio.ts";
import { TranscriptionParametersSchema, TranscriptionSchema, type RecordingResult } from "./media-domain.ts";
import { type MediaDependencies } from "./media-io.ts";
import { prepareRecording } from "./prepare-recording.ts";

export function createOmlxSpeechTool(): Tool<OmlxSpeechArgs> {
  return {
    name: "omlx_speech",
    description: "Generate speech with a local OMLX TTS model and save the audio file in the workspace. Returns the selected model and file path.",
    parameters: {
      type: "object",
      properties: {
        input: { type: "string", description: "Text to speak." },
        output: { type: "string", description: "Absolute path for a new .wav file, or an extension matching response_format." },
        model: { type: "string", description: "Optional explicit OMLX TTS model; otherwise prefer a loaded model, then an installed one." },
        voice: { type: "string", description: "Optional voice name supported by the model." },
        language: { type: "string", description: "Optional language code." },
        speed: { type: "number", exclusiveMinimum: 0, description: "Speech speed multiplier." },
        instructions: { type: "string", description: "Optional delivery/style instructions for supported models." },
        response_format: { type: "string", enum: ["wav", "mp3", "opus", "flac", "pcm"], description: "Output format; defaults to wav. The output extension must match." },
      },
      required: ["input", "output"],
      additionalProperties: false,
    },
    handler: async (args) => {
      try {
        const result = await executeSpeech(args);

        return `Saved speech with ${result.model}: ${result.file}`;
      } catch (error) {
        if (error instanceof OmlxToolError) return `❌ ${error.code}: ${error.message}`;

        return `❌ AUDIO_FAILED: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };
}

export function createOmlxTranscriptionTool(dependencies: MediaDependencies = {}): Tool {
  return {
    name: "omlx_transcribe",
    description: "Transcribe local audio with OMLX. Use output for a new .txt transcript (legacy mode), OR output_dir for bounded audio/video preparation with mono 16 kHz WAV chunks, transcript.md, chunks.json and manifest.json. output_dir must be fresh, outside the plugin tree, with an existing parent. Source is preserved. Recording limits: 2 hours, 4 GiB, 120 serial chunks, 120-second requests, 600-second total deadline by default. Chunk-boundary timestamps are not word/speaker timestamps. Requires ffmpeg/ffprobe and a literal loopback endpoint unless allow_remote explicitly consents; no redirects. Failures retain incomplete artifacts.",
    parameters: TranscriptionParametersSchema,
    handler: async (args, invocation) => {
      try {
        if (!Value.Check(TranscriptionSchema, args)) {
          throw new OmlxToolError("INVALID_INPUT", "Require absolute input and exactly one of output or output_dir with valid bounded options");
        }

        if ("output_dir" in args) {
          const result = await prepareRecording(args, dependencies, invocation?.signal);

          const response: RecordingResult = {
            kind: "recording",
            ...result,
            timing: "Timestamps are chunk boundaries, not word or speaker timestamps.",
          };

          return {
            resultType: "success",
            textResultForLlm: JSON.stringify(response),
          } satisfies ToolResultObject;
        }

        const result = await executeTranscription(args, dependencies);

        return `Saved transcription with ${result.model}: ${result.file}\n\n${result.text}`;
      } catch (error) {
        const failure = error instanceof OmlxToolError ? error
          : new OmlxToolError("AUDIO_FAILED", error instanceof Error ? error.message : String(error));

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
