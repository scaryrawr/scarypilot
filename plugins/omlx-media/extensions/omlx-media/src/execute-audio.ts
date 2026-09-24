import * as path from "node:path";
import { access, mkdir, open, rm, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import {
  OmlxToolError,
  type FetchImplementation,
  type OmlxSpeechArgs,
  type OmlxTranscriptionArgs,
  type SpeechFormat,
} from "./domain.ts";
import { OmlxClient } from "./omlx-client.ts";

export interface AudioDependencies {
  environment?: NodeJS.ProcessEnv;
  fetchImplementation?: FetchImplementation;
}

const SPEECH_FORMATS = new Set<SpeechFormat>(["wav", "mp3", "opus", "flac", "pcm"]);

const MAX_AUDIO_INPUT_BYTES = 100 * 1024 * 1024;

function absolutePath(value: string): string {
  if (!path.isAbsolute(value)) {
    throw new OmlxToolError("ABSOLUTE_PATH_REQUIRED", `Path must be absolute: ${value}`);
  }

  return path.resolve(value);
}

async function outputPath(value: string, extension: string): Promise<string> {
  const output = absolutePath(value);

  if (path.extname(output).toLowerCase() !== extension) {
    throw new OmlxToolError("INVALID_OUTPUT", `Audio output must use a ${extension} extension`);
  }

  await mkdir(path.dirname(output), { recursive: true });

  try {
    await access(output, fsConstants.F_OK);
    throw new OmlxToolError("OUTPUT_CONFLICT", `Output already exists: ${output}`);
  } catch (error) {
    if (error instanceof OmlxToolError) throw error;

    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }

  return output;
}

async function saveOutput(output: string, content: Buffer | string): Promise<void> {
  let handle;

  try {
    handle = await open(output, "wx");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new OmlxToolError("OUTPUT_CONFLICT", `Output already exists: ${output}`);
    }

    throw error;
  }

  try {
    await handle.writeFile(content);
  } catch (error) {
    await handle.close();
    await rm(output);
    throw error;
  }

  await handle.close();
}

function requireText(value: string, name: string): string {
  const trimmed = value?.trim();

  if (!trimmed) throw new OmlxToolError("INVALID_INPUT", `${name} must not be empty`);

  return trimmed;
}

function client(dependencies: AudioDependencies): OmlxClient {
  return new OmlxClient(
    dependencies.environment ?? process.env,
    dependencies.fetchImplementation ?? fetch,
  );
}

export async function executeSpeech(
  args: OmlxSpeechArgs,
  dependencies: AudioDependencies = {},
): Promise<{ model: string; file: string }> {
  const input = requireText(args.input, "Speech input");
  const format = args.response_format ?? "wav";

  if (!SPEECH_FORMATS.has(format)) {
    throw new OmlxToolError("INVALID_FORMAT", `Unsupported speech format: ${format}`);
  }

  if (args.speed !== undefined && (!Number.isFinite(args.speed) || args.speed <= 0)) {
    throw new OmlxToolError("INVALID_SPEED", "Speech speed must be positive");
  }

  const file = await outputPath(args.output, `.${format}`);
  const api = client(dependencies);
  const model = await api.selectAudioModel("speech", args.model);
  const audio = await api.speech({ ...args, input }, model);
  await saveOutput(file, audio);

  return { model, file };
}

export async function executeTranscription(
  args: OmlxTranscriptionArgs,
  dependencies: AudioDependencies = {},
): Promise<{ model: string; file: string; text: string }> {
  const input = absolutePath(args.input);
  let inputStat;

  try {
    inputStat = await stat(input);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new OmlxToolError("INPUT_NOT_FOUND", `Audio input was not found: ${input}`);
    }

    throw error;
  }

  if (!inputStat.isFile()) throw new OmlxToolError("INVALID_INPUT", `Audio input is not a file: ${input}`);

  if (!inputStat.size || inputStat.size > MAX_AUDIO_INPUT_BYTES) {
    throw new OmlxToolError("INVALID_INPUT", "Audio input must be nonempty and at most 100 MB");
  }

  const file = await outputPath(args.output, ".txt");
  const api = client(dependencies);
  const model = await api.selectAudioModel("transcription", args.model);
  const text = await api.transcribe({ ...args, input }, model);

  if (!text.trim()) throw new OmlxToolError("INVALID_RESPONSE", "OMLX returned an empty transcription");
  await saveOutput(file, text);

  return { model, file, text };
}
