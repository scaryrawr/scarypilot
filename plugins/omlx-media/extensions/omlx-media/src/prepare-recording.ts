import * as path from "node:path";
import { stat } from "node:fs/promises";
import { OmlxToolError } from "./domain.ts";
import { type AudioChunk, type RecordingArgs } from "./media-domain.ts";
import {
  abortError, boundedOperation, freshDirectory, probeAudioDuration, probeMedia, publishManifest, reserveDirectory,
  retainedArtifacts, runMediaProcess, sourceFile, writeArtifact,
  type MediaDependencies,
} from "./media-io.ts";
import { OmlxClient } from "./omlx-client.ts";

export async function prepareRecording(
  args: RecordingArgs,
  dependencies: MediaDependencies = {},
  invocationSignal?: AbortSignal,
): Promise<{ directory: string; manifest: string; transcript: string; model: string; chunks: number }> {
  return boundedOperation(args.timeout_seconds, invocationSignal, async (signal) => {
    const source = await sourceFile(args.input);
    const requested = await freshDirectory(args.output_dir);

    const api = new OmlxClient(dependencies.environment ?? process.env, dependencies.fetchImplementation ?? fetch, {
      signal,
      requestTimeoutMs: 120_000,
      maxResponseBytes: 1024 ** 2,
      recording: { allowRemote: args.allow_remote === true },
    });

    const runner = dependencies.processRunner ?? runMediaProcess;
    const media = await probeMedia(source, runner, signal);
    const audio = media.streams.find((stream) => stream.codec_type === "audio");

    if (!audio || !media.audioRange) throw new OmlxToolError("NO_AUDIO_STREAM", "Recording has no audio stream to transcribe");

    const audioRange = {
      start: media.audioRange.start,
      end: media.audioRange.end ?? Math.min(media.duration,
        media.audioRange.start + await probeAudioDuration(source, audio.index, runner, signal)),
    };

    const chunkSeconds = args.chunk_seconds ?? 60;
    const count = Math.ceil((audioRange.end - audioRange.start) / chunkSeconds);

    if (count > 120) throw new OmlxToolError("CHUNK_COUNT_LIMIT", "Recording requires more than 120 chunks; use a larger chunk_seconds (up to 120)");
    await runner("ffmpeg", ["-version"], signal);
    const model = await api.selectAudioModel("transcription", args.model);
    signal.throwIfAborted();
    const directory = await reserveDirectory(requested);

    try {
      const chunks: AudioChunk[] = [];
      let transcriptBytes = 0;

      for (let index = 0; index < count; index++) {
        signal.throwIfAborted();
        const start = audioRange.start + index * chunkSeconds;
        const end = Math.min(audioRange.end, start + chunkSeconds);
        const file = path.join(directory, `chunk-${String(index + 1).padStart(3, "0")}.wav`);
        await runner("ffmpeg", [
          "-nostdin", "-hide_banner", "-loglevel", "error", "-n", "-threads", "1",
          "-filter_threads", "1", "-protocol_whitelist", "file,pipe", "-ss", String(start), "-i", source,
          "-t", String(end - start), "-map", `0:${audio.index}`,
          "-vn", "-af", `atrim=duration=${end - start},asetpts=PTS-STARTPTS`,
          "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-threads", "1", file,
        ], signal);
        const info = await stat(file);

        if (!info.isFile() || info.size <= 44 || info.size > (end - start) * 32000 + 65536) {
          throw new OmlxToolError("INVALID_MEDIA", "Extracted WAV chunk is empty or exceeds its bounded PCM size");
        }

        const extracted = await probeMedia(file, runner, signal);

        if (!extracted.streams.some((stream) => stream.codec_type === "audio" && stream.sample_rate === "16000" && stream.channels === 1) ||
            extracted.duration > end - start + 1 / 16000) {
          throw new OmlxToolError("INVALID_MEDIA", "Extracted chunk did not match its bounded 16 kHz audio contract");
        }

        const actualEnd = start + extracted.duration;
        const text = await api.transcribe({ input: file, model, language: args.language, prompt: args.prompt }, model);

        if (!text.trim()) throw new OmlxToolError("INVALID_RESPONSE", "OMLX returned an empty transcription");
        transcriptBytes += Buffer.byteLength(text);

        if (transcriptBytes > 8 * 1024 ** 2) {
          throw new OmlxToolError("TRANSCRIPT_SIZE_LIMIT", "Total transcript exceeded its 8 MiB limit");
        }

        chunks.push({ index: index + 1, start_seconds: start, end_seconds: actualEnd, audio: file, text });
      }

      signal.throwIfAborted();
      const transcript = path.join(directory, "transcript.md");
      const chunksFile = path.join(directory, "chunks.json");
      const manifest = path.join(directory, "manifest.json");
      const timing = "Timestamps are extracted audio chunk boundaries, not word or speaker timestamps.";
      await writeArtifact(transcript, [
        "# Transcript", "", timing, "",
        ...chunks.flatMap((chunk) => [`## ${chunk.start_seconds.toFixed(3)}s - ${chunk.end_seconds.toFixed(3)}s`, "", chunk.text, ""]),
      ].join("\n"));
      await writeArtifact(chunksFile, JSON.stringify({ timing, chunks }, null, 2));
      signal.throwIfAborted();
      await publishManifest(manifest, JSON.stringify({
        status: "complete", kind: "recording", source, source_duration_seconds: media.duration,
        model, timing, source_audio_range: audioRange,
        chunk_seconds: chunkSeconds, audio_format: { codec: "pcm_s16le", channels: 1, sample_rate: 16000 },
        artifacts: { transcript, chunks: chunksFile, audio: chunks.map((chunk) => chunk.audio) },
        chunks,
      }, null, 2), signal);

      return { directory, manifest, transcript, model, chunks: chunks.length };
    } catch (error) {
      const failure = signal.aborted ? abortError(signal) : error instanceof OmlxToolError ? error
        : new OmlxToolError("MEDIA_PREPARATION_FAILED", error instanceof Error ? error.message : String(error));

      throw retainedArtifacts(failure, directory);
    }
  });
}
