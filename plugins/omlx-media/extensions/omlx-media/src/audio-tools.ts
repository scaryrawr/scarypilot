import type { Tool } from "@github/copilot-sdk";
import {
  OmlxToolError,
  type OmlxSpeechArgs,
  type OmlxTranscriptionArgs,
} from "./domain.ts";
import { executeSpeech, executeTranscription } from "./execute-audio.ts";

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

export function createOmlxTranscriptionTool(): Tool<OmlxTranscriptionArgs> {
  return {
    name: "omlx_transcribe",
    description: "Transcribe a local audio file with an OMLX STT model, saving its text to the workspace. Returns the transcript path and text.",
    parameters: {
      type: "object",
      properties: {
        input: { type: "string", description: "Absolute path to an existing audio file." },
        output: { type: "string", description: "Absolute path for a new .txt transcript." },
        model: { type: "string", description: "Optional explicit OMLX STT model; otherwise prefer a loaded model, then an installed one." },
        language: { type: "string", description: "Optional spoken language code." },
        prompt: { type: "string", description: "Optional vocabulary/spelling guidance for supported models." },
      },
      required: ["input", "output"],
      additionalProperties: false,
    },
    handler: async (args) => {
      try {
        const result = await executeTranscription(args);

        return `Saved transcription with ${result.model}: ${result.file}\n\n${result.text}`;
      } catch (error) {
        if (error instanceof OmlxToolError) return `❌ ${error.code}: ${error.message}`;

        return `❌ AUDIO_FAILED: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };
}
