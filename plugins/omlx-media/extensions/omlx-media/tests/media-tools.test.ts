import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, describe, it } from "node:test";
import type { Tool, ToolInvocation } from "@github/copilot-sdk";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { createOmlxTranscriptionTool } from "../src/audio-tools.ts";
import { createOmlxPrepareFramesTool } from "../src/frame-tool.ts";
import { OmlxToolError } from "../src/domain.ts";
import { runMediaProcess, type MediaDependencies, type ProcessRunner } from "../src/media-io.ts";
import { FramesResultSchema, FramesSchema, RecordingResultSchema, RecordingSchema } from "../src/media-domain.ts";

const roots: string[] = [];

const servers: Server[] = [];

let fixtureRoot: string;

let video: string;

let audioOnly: string;

let videoOnly: string;

let delayedAudio: string;

let tailVideo: string;

let unequalRecording: string;

const shortVideos: string[] = [];

let delayedVideo: string;

async function workspace(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "omlx-preparation-")));
  roots.push(root);

  return root;
}

before(async () => {
  fixtureRoot = await realpath(await mkdtemp(path.join(tmpdir(), "omlx-fixture-")));
  video = path.join(fixtureRoot, "recording.mp4");
  audioOnly = path.join(fixtureRoot, "audio.wav");
  videoOnly = path.join(fixtureRoot, "silent.mp4");
  delayedAudio = path.join(fixtureRoot, "delayed.mp4");
  tailVideo = path.join(fixtureRoot, "tail.mkv");
  unequalRecording = path.join(fixtureRoot, "unequal.mkv");
  await runMediaProcess("ffmpeg", [
    "-nostdin", "-v", "error", "-n", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=3",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000",
    "-t", "12", "-c:v", "mpeg4", "-c:a", "aac", "-threads", "1", video,
  ], AbortSignal.timeout(20_000));
  await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-n", "-i", video, "-vn", "-c:a", "pcm_s16le", audioOnly], AbortSignal.timeout(20_000));
  await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-n", "-i", video, "-an", "-c:v", "copy", videoOnly], AbortSignal.timeout(20_000));
  await runMediaProcess("ffmpeg", [
    "-nostdin", "-v", "error", "-n", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=3",
    "-itsoffset", "2", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000",
    "-t", "12", "-c:v", "mpeg4", "-c:a", "aac", "-threads", "1", delayedAudio,
  ], AbortSignal.timeout(20_000));
  await runMediaProcess("ffmpeg", [
    "-nostdin", "-v", "error", "-n", "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=1",
    "-t", "4", "-c:v", "mpeg4", "-g", "100", "-threads", "1", tailVideo,
  ], AbortSignal.timeout(20_000));
  await runMediaProcess("ffmpeg", [
    "-nostdin", "-v", "error", "-n", "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=1",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=10",
    "-t", "90", "-c:v", "mpeg4", "-c:a", "pcm_s16le", "-threads", "1", unequalRecording,
  ], AbortSignal.timeout(20_000));

  for (const extension of ["mp4", "mkv"]) {
    const input = path.join(fixtureRoot, `short-video.${extension}`);
    shortVideos.push(input);
    await runMediaProcess("ffmpeg", [
      "-nostdin", "-v", "error", "-n", "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=1:duration=4",
      "-f", "lavfi", "-i", "sine=sample_rate=16000:duration=10",
      "-c:v", "mpeg4", "-g", "100", "-c:a", "aac", "-threads", "1", input,
    ], AbortSignal.timeout(20_000));
  }

  delayedVideo = path.join(fixtureRoot, "delayed-video.mkv");
  await runMediaProcess("ffmpeg", [
    "-nostdin", "-v", "error", "-n", "-itsoffset", "2",
    "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=1:duration=4",
    "-f", "lavfi", "-i", "sine=sample_rate=16000:duration=10",
    "-fps_mode", "passthrough", "-c:v", "mpeg4", "-g", "100", "-c:a", "aac", "-threads", "1", delayedVideo,
  ], AbortSignal.timeout(20_000));
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  })));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

after(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

const SuccessResultSchema = Type.Object({
  resultType: Type.Literal("success"),
  textResultForLlm: Type.String(),
}, { additionalProperties: false });

const FailureResultSchema = Type.Object({
  resultType: Type.Literal("failure"),
  error: Type.String(),
  textResultForLlm: Type.String(),
}, { additionalProperties: false });

const HandlerResultSchema = Type.Union([Type.String(), SuccessResultSchema, FailureResultSchema]);

type HandlerResult = Static<typeof HandlerResultSchema>;

const PublicParametersDescriptorSchema = Type.Object({
  type: Type.Literal("object"),
  required: Type.Array(Type.String()),
  additionalProperties: Type.Boolean(),
  properties: Type.Record(Type.String(), Type.Object({ type: Type.String() }, { additionalProperties: true })),
}, { additionalProperties: true });

async function callHandler<T>(tool: Tool<T>, args: T, signal?: AbortSignal): Promise<HandlerResult> {
  assert.ok(tool.handler);
  const invocation: ToolInvocation = { sessionId: "test", toolCallId: "test", toolName: tool.name, arguments: args, signal };

  const result = await tool.handler(args, invocation);
  assert.ok(Value.Check(HandlerResultSchema, result));

  return result;
}

async function invokeResult<T, S extends TSchema>(tool: Tool<T>, args: T, schema: S, signal?: AbortSignal): Promise<Static<S>> {
  const result = await callHandler(tool, args, signal);
  assert.ok(Value.Check(SuccessResultSchema, result), JSON.stringify(result));
  assert.equal(result.resultType, "success");
  const payload: unknown = JSON.parse(result.textResultForLlm);
  assert.ok(Value.Check(schema, payload));

  return payload;
}

async function invoke<T>(tool: Tool<T>, args: T, signal?: AbortSignal): Promise<string> {
  const result = await callHandler(tool, args, signal);

  if (typeof result === "string") {
    assert.equal(tool.name, "omlx_transcribe");
    assert.match(result, /^Saved transcription with /);

    return result;
  }

  assert.ok(Value.Check(FailureResultSchema, result));
  assert.equal(result.resultType, "failure");
  assert.equal(result.textResultForLlm, `❌ ${result.error}`);

  return result.textResultForLlm;
}

const DimensionsSchema = Type.Object({ width: Type.Integer(), height: Type.Integer() });

const ManifestSchema = Type.Object({
  status: Type.Literal("complete"),
  source: Type.String(),
  source_duration_seconds: Type.Number(),
  timing: Type.String(),
  model: Type.Optional(Type.String()),
  audio_format: Type.Optional(Type.Object({ codec: Type.String(), channels: Type.Integer(), sample_rate: Type.Integer() })),
  sampling: Type.Optional(Type.String()),
  source_dimensions: Type.Optional(DimensionsSchema),
  dimensions: Type.Optional(DimensionsSchema),
  range: Type.Optional(Type.Object({ start_seconds: Type.Number(), end_seconds: Type.Number() })),
  source_video_range: Type.Optional(Type.Object({ start: Type.Number(), end: Type.Number() })),
  crop: Type.Optional(Type.Object({ x: Type.Integer(), y: Type.Integer(), width: Type.Integer(), height: Type.Integer() })),
  frames: Type.Optional(Type.Array(Type.Object({ index: Type.Integer(), requested_seconds: Type.Number(), file: Type.String() }))),
});

async function manifest(directory: string): Promise<Static<typeof ManifestSchema>> {
  const payload: unknown = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  assert.ok(Value.Check(ManifestSchema, payload));

  return payload;
}

async function noManifest(directory: string): Promise<void> {
  await assert.rejects(readFile(path.join(directory, "manifest.json")), { code: "ENOENT" });
}

interface ServiceOptions {
  models?: unknown;
  transcript?: unknown;
  malformedJson?: boolean;
  hang?: "models" | "transcript" | "body";
  redirect?: string;
  redirectModels?: string;
  redirectTranscription?: string;
}

async function service(options: ServiceOptions = {}): Promise<{ environment: NodeJS.ProcessEnv; uploads: Buffer[]; requests: string[] }> {
  const uploads: Buffer[] = [];
  const requests: string[] = [];

  const server = createServer(async (request, response) => {
    requests.push(request.url ?? "");

    if (options.redirect) {
      response.writeHead(307, { location: options.redirect }).end();

      return;
    }

    if (request.url === "/v1/models/status") {
      if (options.redirectModels) {
        response.writeHead(307, { location: options.redirectModels }).end();

        return;
      }

      if (options.hang === "models") return;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(options.models ?? { models: [{ id: "fixture-stt", model_type: "audio_stt", loaded: true }] }));

      return;
    }

    if (options.redirectTranscription) {
      response.writeHead(307, { location: options.redirectTranscription }).end();

      return;
    }

    const body: Buffer[] = [];

    for await (const part of request) body.push(Buffer.from(part));
    uploads.push(Buffer.concat(body));

    if (options.hang === "transcript") return;
    response.setHeader("content-type", "application/json");

    if (options.hang === "body") {
      response.write('{"text":"');

      return;
    }

    response.end(options.malformedJson ? "not json" : JSON.stringify(options.transcript ?? { text: `Recognized chunk ${uploads.length}.` }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  return { environment: { OMLX_BASE_URL: `http://127.0.0.1:${address.port}` }, uploads, requests };
}

interface ProbeFixture {
  format: { duration: string };
  streams: Array<{ index: number; codec_type: string; width?: number; height?: number; sample_rate?: string; duration?: string }>;
}

function probeRunner(payload: ProbeFixture, ffmpegFailure?: OmlxToolError): ProcessRunner {
  return async (command) => {
    if (command === "ffmpeg") {
      if (ffmpegFailure) throw ffmpegFailure;
      throw new Error("Unexpected extraction");
    }

    return JSON.stringify(payload);
  };
}

const mediaMetadata = {
  format: { duration: "12" },
  streams: [
    { index: 0, codec_type: "video", width: 320, height: 180, duration: "12" },
    { index: 1, codec_type: "audio", sample_rate: "16000", duration: "12" },
  ],
};

describe("registered recording preparation", () => {
  it("rejects incomplete or invalid selected-audio extent measurements before creating outputs", async () => {
    const root = await workspace();

    const metadata = {
      ...mediaMetadata,
      streams: [{ index: 1, codec_type: "audio", sample_rate: "16000" }],
    };

    for (const [index, progress] of [
      "out_time_us=10000000\nprogress=continue\n",
      "out_time_us=0\nprogress=end\n",
      "out_time_us=7201000000\nprogress=end\n",
      "out_time_us=NaN\nprogress=end\n",
    ].entries()) {
      const output_dir = path.join(root, `invalid-extent-${index}`);

      const processRunner: ProcessRunner = async (command, args) => {
        if (command === "ffprobe") return JSON.stringify(metadata);

        assert.ok(args.includes("-progress"));
        assert.ok(args.includes("0:1"));
        assert.ok(args.includes("7200"));

        return progress;
      };

      const result = await invoke(createOmlxTranscriptionTool({ processRunner }), { input: video, output_dir });

      assert.match(result, /INVALID_MEDIA.*selected audio stream/);
      await assert.rejects(stat(output_dir), { code: "ENOENT" });
    }
  });

  it("uses the selected audio extent when MKV stream duration is absent and video lasts longer", async () => {
    const root = await workspace();
    const output_dir = path.join(root, "unequal");
    const server = await service();
    const sourceBefore = await readFile(unequalRecording);

    const metadata = Value.Parse(Type.Object({
      streams: Type.Array(Type.Object({ codec_type: Type.String(), duration: Type.Optional(Type.String()) })),
    }), JSON.parse(await runMediaProcess("ffprobe", [
      "-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json", unequalRecording,
    ], AbortSignal.timeout(20_000))));

    assert.equal(metadata.streams.find((stream) => stream.codec_type === "audio")?.duration, undefined);

    const result = await invokeResult(createOmlxTranscriptionTool(server), {
      input: unequalRecording, output_dir,
    }, RecordingResultSchema);

    assert.equal(result.chunks, 1);
    const saved = JSON.parse(await readFile(result.manifest, "utf8"));
    assert.equal(saved.source_duration_seconds, 90);
    assert.deepEqual(saved.source_audio_range, { start: 0, end: 10 });
    assert.deepEqual(saved.chunks.map((chunk: { start_seconds: number; end_seconds: number; text: string }) =>
      [chunk.start_seconds, chunk.end_seconds, chunk.text]), [[0, 10, "Recognized chunk 1."]]);
    assert.equal(server.uploads.length, 1);
    assert.deepEqual((await readdir(output_dir)).sort(), ["chunk-001.wav", "chunks.json", "manifest.json", "transcript.md"]);
    assert.equal(await readFile(result.transcript, "utf8"), [
      "# Transcript", "", "Timestamps are extracted audio chunk boundaries, not word or speaker timestamps.", "",
      "## 0.000s - 10.000s", "", "Recognized chunk 1.", "",
    ].join("\n"));
    assert.deepEqual(await readFile(unequalRecording), sourceBefore);
  });

  it("publishes an object-root transcription schema with only input required for native discovery", () => {
    const tool = createOmlxTranscriptionTool();
    assert.ok(tool.parameters);
    const parameters = Value.Parse(PublicParametersDescriptorSchema, JSON.parse(JSON.stringify(tool.parameters)));

    assert.equal(tool.name, "omlx_transcribe");
    assert.equal(parameters.type, "object");
    assert.deepEqual(parameters.required, ["input"]);
    assert.equal(parameters.additionalProperties, false);
    assert.equal("anyOf" in parameters, false);
    assert.equal("oneOf" in parameters, false);
    assert.deepEqual(Object.keys(parameters.properties).sort(), [
      "allow_remote", "chunk_seconds", "input", "language", "model", "output", "output_dir", "prompt", "timeout_seconds",
    ]);
    assert.equal(parameters.properties.input.type, "string");
    assert.equal(parameters.properties.output.type, "string");
    assert.equal(parameters.properties.output_dir.type, "string");
    assert.equal(parameters.properties.chunk_seconds.type, "integer");
    assert.equal(parameters.properties.timeout_seconds.type, "integer");
    assert.equal(parameters.properties.allow_remote.type, "boolean");
  });

  it("rejects recording-only options in legacy mode despite exposing them in the shared public schema", async () => {
    const root = await workspace();
    const output = path.join(root, "legacy.txt");

    const tool = createOmlxTranscriptionTool({
      fetchImplementation: async () => { throw new Error("Invalid legacy options must not make requests"); },
    });

    for (const options of [{ chunk_seconds: 60 }, { timeout_seconds: 600 }, { allow_remote: false }]) {
      const result = await invoke(tool, { input: audioOnly, output, ...options });
      assert.match(result, /INVALID_INPUT/);
    }

    await assert.rejects(stat(output), { code: "ENOENT" });
  });

  it("extracts serial WAV chunks and publishes actual boundaries, source and artifact paths", async () => {
    const root = await workspace();
    const output = path.join(root, "prepared");
    const sourceBefore = await readFile(video);
    const server = await service();

    const result = await invokeResult(createOmlxTranscriptionTool(server), {
      input: video, output_dir: output, chunk_seconds: 10, language: "en", prompt: "Copilot",
    }, RecordingResultSchema);

    assert.deepEqual(result, {
      kind: "recording", directory: output, manifest: path.join(output, "manifest.json"),
      transcript: path.join(output, "transcript.md"), model: "fixture-stt", chunks: 2,
      timing: "Timestamps are chunk boundaries, not word or speaker timestamps.",
    });
    const saved = await manifest(output);
    assert.equal(saved.status, "complete");
    assert.equal(saved.source, video);
    assert.equal(saved.model, "fixture-stt");
    assert.equal(saved.source_duration_seconds, 12);
    assert.deepEqual(saved.audio_format, { codec: "pcm_s16le", channels: 1, sample_rate: 16000 });
    const chunks = JSON.parse(await readFile(path.join(output, "chunks.json"), "utf8")).chunks;
    assert.equal(chunks.length, 2);
    assert.deepEqual(chunks.map((chunk: { start_seconds: number; end_seconds: number }) => [chunk.start_seconds, chunk.end_seconds]), [[0, 10], [10, 12]]);
    assert.deepEqual(chunks.map((chunk: { text: string }) => chunk.text), ["Recognized chunk 1.", "Recognized chunk 2."]);

    for (const chunk of chunks) {
      const wav = await readFile(chunk.audio);
      assert.equal(wav.toString("ascii", 0, 4), "RIFF");
      assert.equal(wav.toString("ascii", 8, 12), "WAVE");
      assert.equal(wav.readUInt16LE(22), 1);
      assert.equal(wav.readUInt32LE(24), 16000);
      assert.equal(wav.readUInt16LE(34), 16);
    }

    assert.equal(server.uploads.length, 2);

    for (const upload of server.uploads) {
      assert.ok(upload.includes(Buffer.from("RIFF")));
      assert.ok(upload.includes(Buffer.from("fixture-stt")));
      assert.ok(upload.includes(Buffer.from("Copilot")));
    }

    const transcript = await readFile(path.join(output, "transcript.md"), "utf8");
    assert.match(transcript, /## 0.000s - 10.000s/);
    assert.match(transcript, /## 10.000s - 12.000s/);
    assert.match(transcript, /not word or speaker timestamps/);
    assert.deepEqual(await readFile(video), sourceBefore);
    assert.deepEqual((await readdir(output)).sort(), ["chunk-001.wav", "chunk-002.wav", "chunks.json", "manifest.json", "transcript.md"]);
  });

  it("prepares audio-only recordings and preserves legacy txt mode", async () => {
    const root = await workspace();
    const server = await service({ transcript: { text: "Audio transcript." } });
    const tool = createOmlxTranscriptionTool(server);
    const prepared = await invokeResult(tool, { input: audioOnly, output_dir: path.join(root, "audio") }, RecordingResultSchema);

    assert.equal(prepared.chunks, 1);
    const txt = path.join(root, "legacy.txt");
    const legacy = await invoke(tool, { input: audioOnly, output: txt });
    assert.equal(legacy, `Saved transcription with fixture-stt: ${txt}\n\nAudio transcript.`);
    assert.equal(await readFile(txt, "utf8"), "Audio transcript.");
  });

  it("preserves legacy discovery and upload redirect following without preparation privacy overrides", async () => {
    const root = await workspace();
    const target = await service({ transcript: { text: "Legacy redirected transcript." } });

    const origin = await service({
      redirectModels: `${target.environment.OMLX_BASE_URL}/v1/models/status`,
      redirectTranscription: `${target.environment.OMLX_BASE_URL}/v1/audio/transcriptions`,
    });

    const output = path.join(root, "legacy.txt");
    const result = await invoke(createOmlxTranscriptionTool(origin), { input: audioOnly, output });
    assert.equal(result, `Saved transcription with fixture-stt: ${output}\n\nLegacy redirected transcript.`);
    assert.equal(await readFile(output, "utf8"), "Legacy redirected transcript.");
    assert.deepEqual(target.requests, ["/v1/models/status", "/v1/audio/transcriptions"]);
    assert.equal(target.uploads.length, 1);
    assert.ok(target.uploads[0].includes(Buffer.from("RIFF")));
  });

  it("rejects mutually exclusive outputs and existing legacy transcript files through its registered handler", async () => {
    const root = await workspace();
    const output = path.join(root, "existing.txt");
    const output_dir = path.join(root, "new-directory");
    const before = await readFile(audioOnly);
    await writeFile(output, "Caller transcript.");

    const tool = createOmlxTranscriptionTool({
      fetchImplementation: async () => { throw new Error("Invalid output modes must not make network requests"); },
    });

    const both = await invoke(tool, { input: audioOnly, output, output_dir });
    assert.match(both, /INVALID_INPUT/);
    assert.match(both, /exactly one of output or output_dir/);
    const collision = await invoke(tool, { input: audioOnly, output });
    assert.match(collision, /OUTPUT_CONFLICT/);
    assert.equal(await readFile(output, "utf8"), "Caller transcript.");
    assert.deepEqual(await readFile(audioOnly), before);
    await assert.rejects(stat(output_dir), { code: "ENOENT" });
  });

  it("preserves the legacy unreachable error code for request timeout failures", async () => {
    const root = await workspace();

    const result = await invoke(createOmlxTranscriptionTool({
      environment: { OMLX_BASE_URL: "https://legacy.example" },
      fetchImplementation: async () => { throw new DOMException("Legacy timeout", "TimeoutError"); },
    }), { input: audioOnly, output: path.join(root, "timeout.txt") });

    assert.match(result, /OMLX_UNREACHABLE/);
    assert.doesNotMatch(result, /REQUEST_TIMEOUT|REMOTE_ENDPOINT_FORBIDDEN/);
  });

  it("records source-relative audio offsets rather than inventing zero-based timing for delayed audio", async () => {
    const root = await workspace();
    const output_dir = path.join(root, "delayed");
    const server = await service();
    const result = await invokeResult(createOmlxTranscriptionTool(server), { input: delayedAudio, output_dir, chunk_seconds: 10 }, RecordingResultSchema);

    assert.equal(result.chunks, 2);
    const saved = JSON.parse(await readFile(path.join(output_dir, "chunks.json"), "utf8"));
    assert.equal(saved.chunks[0].start_seconds, 1.936);
    assert.equal(saved.chunks[0].end_seconds, 11.936);
    assert.equal(saved.chunks[1].start_seconds, 11.936);
    const finalWav = await readFile(saved.chunks[1].audio);
    let dataBytes: number | undefined;

    for (let offset = 12; offset + 8 <= finalWav.length;) {
      const size = finalWav.readUInt32LE(offset + 4);

      if (finalWav.toString("ascii", offset, offset + 4) === "data") {
        dataBytes = size;
        break;
      }

      offset += 8 + size + size % 2;
    }

    assert.ok(dataBytes !== undefined && dataBytes > 0);
    assert.equal(saved.chunks[1].end_seconds, 11.936 + dataBytes / 32000);
    const transcript = await readFile(path.join(output_dir, "transcript.md"), "utf8");
    assert.match(transcript, /## 1.936s - 11.936s/);
  });

  it("rejects preexisting directories and symlinks without changing caller artifacts or source", async () => {
    const root = await workspace();
    const existing = path.join(root, "existing");
    await mkdir(existing);
    await writeFile(path.join(existing, "keep"), "caller data");
    const alias = path.join(root, "alias");
    const dangling = path.join(root, "dangling");
    await symlink(existing, alias);
    await symlink(path.join(root, "not-there"), dangling);
    const before = await readFile(video);
    const tool = createOmlxTranscriptionTool({ fetchImplementation: async () => { throw new Error("No network allowed"); } });

    for (const output_dir of [existing, alias, dangling, video]) {
      const result = await invoke(tool, { input: video, output_dir });
      assert.match(result, /OUTPUT_CONFLICT/);
    }

    assert.equal(await readFile(path.join(existing, "keep"), "utf8"), "caller data");
    assert.deepEqual(await readFile(video), before);
  });

  it("retains incomplete chunks on empty or malformed model responses without a success manifest", async () => {
    const root = await workspace();

    for (const [index, options] of [
      { transcript: { text: "" } }, { transcript: { text: "   " } },
      { transcript: { language: "en" } }, { malformedJson: true },
    ].entries()) {
      const server = await service(options);
      const output_dir = path.join(root, `failure-${index}`);
      const result = await invoke(createOmlxTranscriptionTool(server), { input: video, output_dir });
      assert.match(result, /INVALID_RESPONSE/);
      assert.match(result, /Incomplete artifacts retained at/);
      assert.ok((await stat(path.join(output_dir, "chunk-001.wav"))).size > 0);
      await noManifest(output_dir);
    }
  });

  it("rejects empty and malformed discovery even for an explicit model without success fallback", async () => {
    const root = await workspace();

    for (const [index, models] of [{ models: [] }, { models: "bad" }, { models: [{}] }, { models: [{ id: "", model_type: "audio_stt" }] }].entries()) {
      const server = await service({ models });
      const output_dir = path.join(root, `models-${index}`);
      const result = await invoke(createOmlxTranscriptionTool(server), { input: video, output_dir, model: "explicit" });
      assert.match(result, /MODEL_NOT_FOUND|INVALID_MODEL_STATUS/);
      assert.equal(server.uploads.length, 0);
      await assert.rejects(stat(output_dir), { code: "ENOENT" });
    }
  });

  it("rejects non-loopback endpoints before sending audio and never follows redirects", async () => {
    const root = await workspace();

    for (const url of ["https://cloud.example", "http://localhost:8000", "http://127.0.0.1.evil.test:8000"]) {
      const result = await invoke(createOmlxTranscriptionTool({
        environment: { OMLX_BASE_URL: url },
        fetchImplementation: async () => { throw new Error("Remote request must not run"); },
      }), { input: video, output_dir: path.join(root, "remote") });

      assert.match(result, /REMOTE_ENDPOINT_FORBIDDEN/);
    }

    const remote = await service();
    const redirect = await service({ redirect: remote.environment.OMLX_BASE_URL });
    const result = await invoke(createOmlxTranscriptionTool(redirect), { input: video, output_dir: path.join(root, "redirect"), model: "explicit" });
    assert.match(result, /OMLX_UNREACHABLE/);
    assert.equal(remote.requests.length, 0);
    const redirectUpload = await service({ redirectTranscription: remote.environment.OMLX_BASE_URL });
    const uploadResult = await invoke(createOmlxTranscriptionTool(redirectUpload), { input: video, output_dir: path.join(root, "redirect-upload") });
    assert.match(uploadResult, /OMLX_UNREACHABLE/);
    assert.match(uploadResult, /Incomplete artifacts retained/);
    assert.equal(remote.requests.length, 0);
  });

  it("permits an explicit remote consent and uses ::1 as a literal loopback without following redirects", async () => {
    const root = await workspace();

    for (const [index, baseUrl, allow_remote] of [[0, "https://remote.example", true], [1, "http://[::1]:8000", false]] as const) {
      let requests = 0;

      const result = await invokeResult(createOmlxTranscriptionTool({
        environment: { OMLX_BASE_URL: baseUrl },
        fetchImplementation: async (url, init) => {
          requests++;
          assert.equal(init?.redirect, "error");
          assert.ok(String(url).startsWith(baseUrl));

          return String(url).endsWith("/status")
            ? Response.json({ models: [{ id: "stt", model_type: "audio_stt" }] })
            : Response.json({ text: "Consented." });
        },
      }), { input: audioOnly, output_dir: path.join(root, `consent-${index}`), allow_remote }, RecordingResultSchema);

      assert.equal(result.chunks, 1);
      assert.equal(result.model, "stt");
      assert.equal(requests, 2);
    }
  });

  it("times out stalled network headers and bodies and preserves retained artifacts", async () => {
    const root = await workspace();

    for (const hang of ["models", "transcript", "body"] as const) {
      const server = await service({ hang });
      const output_dir = path.join(root, hang);
      const result = await invoke(createOmlxTranscriptionTool(server), { input: video, output_dir, timeout_seconds: 1 });
      assert.match(result, /OPERATION_TIMEOUT/);
      await noManifest(output_dir);

      if (hang !== "models") assert.match(result, /Incomplete artifacts retained at/);
    }
  });

  it("cancels network requests from ToolInvocation.signal and retains incomplete files", async () => {
    const root = await workspace();
    const server = await service({ hang: "transcript" });
    const controller = new AbortController();
    const output_dir = path.join(root, "cancelled");

    const timer = setInterval(() => {
      if (server.uploads.length) controller.abort();
    }, 10);

    try {
      const result = await invoke(createOmlxTranscriptionTool(server), { input: video, output_dir }, controller.signal);
      assert.match(result, /CANCELLED/);
      assert.match(result, /Incomplete artifacts retained at/);
      assert.ok((await stat(path.join(output_dir, "chunk-001.wav"))).size > 0);
      await noManifest(output_dir);
    } finally {
      clearInterval(timer);
    }
  });

  it("caps JSON response buffers instead of publishing an unbounded transcript", async () => {
    const root = await workspace();
    const server = await service({ transcript: { text: "x".repeat(1024 ** 2) } });
    const output_dir = path.join(root, "large-response");
    const result = await invoke(createOmlxTranscriptionTool(server), { input: video, output_dir });
    assert.match(result, /RESPONSE_SIZE_LIMIT/);
    await noManifest(output_dir);
  });

  it("caps total accumulated transcript text across individually bounded responses", async () => {
    const root = await workspace();
    const input = path.join(root, "long.wav");
    await runMediaProcess("ffmpeg", [
      "-nostdin", "-v", "error", "-n", "-f", "lavfi", "-i", "sine=sample_rate=16000",
      "-t", "90", "-c:a", "pcm_s16le", input,
    ], AbortSignal.timeout(20_000));
    const output_dir = path.join(root, "large-transcript");
    const server = await service({ transcript: { text: "x".repeat(1_000_000) } });
    const result = await invoke(createOmlxTranscriptionTool(server), { input, output_dir, chunk_seconds: 10 });
    assert.match(result, /TRANSCRIPT_SIZE_LIMIT/);
    assert.match(result, /Incomplete artifacts retained/);
    assert.equal(server.uploads.length, 9);
    await noManifest(output_dir);
  });
});

describe("registered frame preparation", () => {
  it("rejects invalid selected-video timing metadata and incomplete extent measurements before output creation", async () => {
    const root = await workspace();
    const stream = { index: 0, codec_type: "video", width: 320, height: 180 };

    for (const [index, progress] of [
      "out_time_us=10000000\nprogress=continue\n",
      "out_time_us=0\nprogress=end\n",
      "out_time_us=7201000000\nprogress=end\n",
      "out_time_us=NaN\nprogress=end\n",
    ].entries()) {
      const processRunner: ProcessRunner = async (command, args) => {
        if (command === "ffprobe") return JSON.stringify({ format: { duration: "12" }, streams: [stream] });
        assert.ok(args.includes("-progress") && args.includes("0:0") && args.includes("7200"));
        assert.ok(args.includes("-an") && args.includes("setpts=PTS-STARTPTS"));

        return progress;
      };

      const output_dir = path.join(root, `bad-video-extent-${index}`);
      assert.match(await invoke(createOmlxPrepareFramesTool({ processRunner }), { input: video, output_dir }), /INVALID_MEDIA.*selected video stream/);
      await assert.rejects(stat(output_dir), { code: "ENOENT" });
    }

    for (const [index, timing] of [
      { duration: "NaN" }, { duration: "Infinity" }, { duration: "0" }, { duration: "-1" },
      { start_time: "NaN" }, { start_time: "12", duration: "4" },
    ].entries()) {
      const processRunner: ProcessRunner = async (command) => {
        assert.equal(command, "ffprobe");

        return JSON.stringify({ format: { duration: "12" }, streams: [{ ...stream, ...timing }] });
      };

      const output_dir = path.join(root, `bad-video-timing-${index}`);
      assert.match(await invoke(createOmlxPrepareFramesTool({ processRunner }), { input: video, output_dir }), /INVALID_MEDIA.*Video stream/);
      await assert.rejects(stat(output_dir), { code: "ENOENT" });
    }
  });

  for (const [index, extension] of ["mp4", "mkv"].entries()) {
    it(`samples the selected video extent when audio outlasts it in ${extension}`, async () => {
      const input = shortVideos[index];
      assert.ok(input);
      const output_dir = path.join(await workspace(), "short-video");

      const metadata: unknown = JSON.parse(await runMediaProcess("ffprobe", [
        "-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json", input,
      ], AbortSignal.timeout(20_000)));

      assert.ok(Value.Check(Type.Object({ streams: Type.Array(Type.Object({
        codec_type: Type.String(), duration: Type.Optional(Type.String()),
      })) }), metadata));

      if (input.endsWith(".mkv")) assert.equal(metadata.streams.find((stream) => stream.codec_type === "video")?.duration, undefined);
      const before = await readFile(input);
      const result = await invokeResult(createOmlxPrepareFramesTool(), { input, output_dir }, FramesResultSchema);
      const saved = await manifest(output_dir);
      assert.equal(result.frames, 24);
      assert.ok(saved.source_duration_seconds > 9);
      assert.deepEqual(saved.source_video_range, { start: 0, end: 4 });
      assert.deepEqual(saved.range, { start_seconds: 0, end_seconds: 4 });
      assert.equal(saved.frames?.at(-1)?.requested_seconds, 4 * 23 / 24);
      assert.deepEqual(await readFile(input), before);

      for (const options of [{ seconds: [4] }, { seconds: [9] }, { end: 5 }]) {
        const invalid = path.join(await workspace(), "outside-video");
        assert.match(await invoke(createOmlxPrepareFramesTool(), { input, output_dir: invalid, ...options }), /INVALID_RANGE/);
        await assert.rejects(stat(invalid), { code: "ENOENT" });
      }
    });
  }

  it("defaults to the delayed video range and rejects requests before its first frame", async () => {
    const output_dir = path.join(await workspace(), "delayed-video");
    const result = await invokeResult(createOmlxPrepareFramesTool(), { input: delayedVideo, output_dir }, FramesResultSchema);
    const saved = await manifest(output_dir);
    assert.equal(result.frames, 24);
    assert.deepEqual(saved.source_video_range, { start: 2, end: 6 });
    assert.deepEqual(saved.range, { start_seconds: 2, end_seconds: 6 });
    assert.equal(saved.frames?.[0]?.requested_seconds, 2);
    assert.equal(saved.frames?.at(-1)?.requested_seconds, 2 + 4 * 23 / 24);

    for (const [sample, sourceFrame] of [[0, 0], [23, 3]]) {
      const frame = saved.frames?.[sample];
      assert.ok(frame);

      const pixels = await runMediaProcess("ffmpeg", [
        "-nostdin", "-v", "error", "-i", frame.file, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "framemd5", "-",
      ], AbortSignal.timeout(20_000));

      const reference = await runMediaProcess("ffmpeg", [
        "-nostdin", "-v", "error", "-i", delayedVideo, "-map", "0:v:0", "-vf", `select=eq(n\\,${sourceFrame})`,
        "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "framemd5", "-",
      ], AbortSignal.timeout(20_000));

      assert.match(pixels, /[0-9a-f]{32}\s*$/);
      assert.equal(pixels.trim().split(",").at(-1), reference.trim().split(",").at(-1));
    }

    for (const options of [{ seconds: [1.9] }, { start: 0 }, { seconds: [6] }]) {
      const invalid = path.join(await workspace(), "outside-video");
      assert.match(await invoke(createOmlxPrepareFramesTool(), { input: delayedVideo, output_dir: invalid, ...options }), /INVALID_RANGE/);
      await assert.rejects(stat(invalid), { code: "ENOENT" });
    }
  });

  it("selects the final covering frame for an explicit timestamp between the last PTS and EOF", async () => {
    const output_dir = path.join(await workspace(), "tail");

    const result = await invokeResult(createOmlxPrepareFramesTool(), {
      input: tailVideo, output_dir, seconds: [3.8],
    }, FramesResultSchema);

    const saved = await manifest(output_dir);

    assert.equal(result.frames, 1);
    assert.equal(saved.status, "complete");
    assert.equal(saved.frames?.[0].requested_seconds, 3.8);
    assert.ok(saved.frames?.[0]);

    const pixels = await runMediaProcess("ffmpeg", [
      "-nostdin", "-v", "error", "-i", saved.frames[0].file, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "framemd5", "-",
    ], AbortSignal.timeout(20_000));

    const reference = await runMediaProcess("ffmpeg", [
      "-nostdin", "-v", "error", "-ss", "3", "-i", tailVideo, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "framemd5", "-",
    ], AbortSignal.timeout(20_000));

    assert.match(pixels, /[0-9a-f]{32}\s*$/);
    assert.equal(pixels.trim().split(",").at(-1), reference.trim().split(",").at(-1));
  });

  it("completes default 24-frame sampling of a four-second 1fps video including its tail", async () => {
    const output_dir = path.join(await workspace(), "short-default");
    const sourceBefore = await readFile(tailVideo);

    const result = await invokeResult(createOmlxPrepareFramesTool(), {
      input: tailVideo, output_dir,
    }, FramesResultSchema);

    const saved = await manifest(output_dir);

    assert.equal(result.frames, 24);
    assert.equal(saved.status, "complete");
    assert.equal(saved.frames?.length, 24);
    assert.equal(saved.frames?.at(-1)?.requested_seconds, 4 * 23 / 24);

    const reference = await runMediaProcess("ffmpeg", [
      "-nostdin", "-v", "error", "-i", tailVideo, "-pix_fmt", "rgb24", "-f", "framemd5", "-",
    ], AbortSignal.timeout(20_000));

    const hashes = reference.split("\n").filter((line) => line.startsWith('0,')).map((line) => line.split(",").at(-1)?.trim());

    assert.equal(hashes.length, 4);

    for (const frame of saved.frames ?? []) {
      assert.ok((await stat(frame.file)).size > 0);

      const pixels = await runMediaProcess("ffmpeg", [
        "-nostdin", "-v", "error", "-i", frame.file, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "framemd5", "-",
      ], AbortSignal.timeout(20_000));

      assert.equal(pixels.trim().split(",").at(-1)?.trim(), hashes[Math.floor(frame.requested_seconds)]);
    }

    assert.deepEqual(await readFile(tailVideo), sourceBefore);
  });

  it("samples deterministic periodic timestamps, bounds width and publishes paths without ranking", async () => {
    const root = await workspace();
    const output_dir = path.join(root, "frames");
    const before = await readFile(video);
    const result = await invokeResult(createOmlxPrepareFramesTool(), { input: video, output_dir, max_frames: 3, width: 160 }, FramesResultSchema);

    assert.deepEqual(result, {
      kind: "frames", directory: output_dir, manifest: path.join(output_dir, "manifest.json"),
      frames: 3, format: "png",
      timing: "Timestamps are requested source times; selects the covering frame, including the final frame interval, not measured frame PTS.",
      classification_script_compatible: false,
      compatibility_note: "PNG output is not discovered by classify_frames.py, which requires .jpg files.",
    });
    const saved = await manifest(output_dir);
    assert.equal(saved.source_duration_seconds, 12);
    assert.deepEqual(saved.source_dimensions, { width: 320, height: 180 });
    assert.deepEqual(saved.dimensions, { width: 160, height: 90 });
    assert.deepEqual(saved.range, { start_seconds: 0, end_seconds: 12 });
    assert.deepEqual(saved.frames, [
      { index: 0, requested_seconds: 0, file: path.join(output_dir, "t_000m00s_f0000.png") },
      { index: 1, requested_seconds: 4, file: path.join(output_dir, "t_000m04s_f0001.png") },
      { index: 2, requested_seconds: 8, file: path.join(output_dir, "t_000m08s_f0002.png") },
    ]);
    assert.match(String(saved.timing), /covering.*final frame interval.*not measured frame PTS/);

    for (const filename of ["t_000m00s_f0000.png", "t_000m04s_f0001.png", "t_000m08s_f0002.png"]) {
      const png = await readFile(path.join(output_dir, filename));
      assert.equal(png.readUInt32BE(16), 160);
      assert.equal(png.readUInt32BE(20), 90);
    }

    assert.deepEqual(await readFile(video), before);
  });

  it("re-extracts explicit seconds with an original-pixel crop into a new JPEG directory", async () => {
    const root = await workspace();
    const output_dir = path.join(root, "selection");
    const crop = { x: 11, y: 13, width: 101, height: 81 };
    const result = await invokeResult(createOmlxPrepareFramesTool(), { input: video, output_dir, seconds: [5.125, 1, 5.875], crop, width: 4096, format: "jpeg" }, FramesResultSchema);

    assert.deepEqual(result, {
      kind: "frames", directory: output_dir, manifest: path.join(output_dir, "manifest.json"),
      frames: 3, format: "jpeg",
      timing: "Timestamps are requested source times; selects the covering frame, including the final frame interval, not measured frame PTS.",
      classification_script_compatible: true,
    });
    const saved = await manifest(output_dir);
    assert.equal(saved.sampling, "explicit");
    assert.equal(JSON.parse(await readFile(path.join(output_dir, "manifest.json"), "utf8")).format, "jpeg");
    assert.equal(saved.range, undefined);
    assert.deepEqual(saved.crop, crop);
    assert.deepEqual(saved.dimensions, { width: 101, height: 81 });
    assert.deepEqual(saved.frames, [
      { index: 0, requested_seconds: 5.125, file: path.join(output_dir, "t_000m05s_f0000.jpg") },
      { index: 1, requested_seconds: 1, file: path.join(output_dir, "t_000m01s_f0001.jpg") },
      { index: 2, requested_seconds: 5.875, file: path.join(output_dir, "t_000m06s_f0002.jpg") },
    ]);
    const jpeg = await readFile(path.join(output_dir, "t_000m05s_f0000.jpg"));
    assert.equal(jpeg.readUInt16BE(0), 0xffd8);
    const reference = path.join(root, "reference-crop.jpg");

    await runMediaProcess("ffmpeg", [
      "-nostdin", "-v", "error", "-n", "-noautorotate", "-threads", "1", "-filter_threads", "1",
      "-i", video, "-vf", "select=eq(n\\,15),crop=101:81:11:13:exact=1,scale=101:81,setsar=1",
      "-frames:v", "1", "-c:v", "mjpeg", "-threads", "1", "-update", "1", reference,
    ], AbortSignal.timeout(20_000));

    const pixels = await Promise.all([saved.frames[0].file, reference].map((file) =>
      runMediaProcess("ffmpeg", [
        "-nostdin", "-v", "error", "-i", file, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "framemd5", "-",
      ], AbortSignal.timeout(20_000))));

    for (const decoded of pixels) assert.match(decoded, /[0-9a-f]{32}\s*$/);

    assert.equal(pixels[0].trim().split(",").at(-1), pixels[1].trim().split(",").at(-1));
  });

  it("uses start-inclusive/end-exclusive ranges and defaults to 24 samples without upscaling", async () => {
    const root = await workspace();
    const output_dir = path.join(root, "default");
    const result = await invokeResult(createOmlxPrepareFramesTool(), { input: video, output_dir, start: 2, end: 8 }, FramesResultSchema);

    assert.equal(result.frames, 24);
    const saved = await manifest(output_dir);
    assert.deepEqual(saved.dimensions, { width: 320, height: 180 });
    const frames = saved.frames;
    assert.ok(frames);
    assert.equal(frames[0].requested_seconds, 2);
    assert.equal(frames[23].requested_seconds, 7.75);
  });

  it("names JPEG candidates with minute/second timestamps while retaining distinct fractional requests", async () => {
    const root = await workspace();
    const input = path.join(root, "long.mp4");
    const output_dir = path.join(root, "candidates");
    await runMediaProcess("ffmpeg", [
      "-nostdin", "-v", "error", "-n", "-f", "lavfi", "-i", "testsrc2=size=16x16:rate=1",
      "-t", "70", "-c:v", "mpeg4", "-threads", "1", input,
    ], AbortSignal.timeout(20_000));
    const result = await invokeResult(createOmlxPrepareFramesTool(), { input, output_dir, seconds: [59.75, 61.125, 61.375, 61.875], format: "jpeg" }, FramesResultSchema);

    assert.equal(result.frames, 4);
    const saved = await manifest(output_dir);
    assert.deepEqual(saved.frames, [
      { index: 0, requested_seconds: 59.75, file: path.join(output_dir, "t_001m00s_f0000.jpg") },
      { index: 1, requested_seconds: 61.125, file: path.join(output_dir, "t_001m01s_f0001.jpg") },
      { index: 2, requested_seconds: 61.375, file: path.join(output_dir, "t_001m01s_f0002.jpg") },
      { index: 3, requested_seconds: 61.875, file: path.join(output_dir, "t_001m02s_f0003.jpg") },
    ]);
    assert.deepEqual((await readdir(output_dir)).filter((name) => name.endsWith(".jpg")).sort(), [
      "t_001m00s_f0000.jpg", "t_001m01s_f0001.jpg", "t_001m01s_f0002.jpg", "t_001m02s_f0003.jpg",
    ]);
  });

  it("rejects invalid ranges, mixed sampling modes and crops before creating outputs", async () => {
    const root = await workspace();

    for (const options of [
      { start: 8, end: 2 }, { start: 2, end: 2 }, { end: 13 },
      { seconds: [12] }, { seconds: [1], start: 0 }, { seconds: [1], max_frames: 2 },
      { crop: { x: 300, y: 0, width: 30, height: 10 } },
    ]) {
      const output_dir = path.join(root, "bad");
      const result = await invoke(createOmlxPrepareFramesTool(), { input: video, output_dir, ...options });
      assert.match(result, /INVALID_RANGE|INVALID_INPUT|INVALID_CROP/);
      await assert.rejects(stat(output_dir), { code: "ENOENT" });
    }
  });

  it("preserves existing output directories, including dangling symlinks", async () => {
    const root = await workspace();
    const output_dir = path.join(root, "frames");
    await mkdir(output_dir);
    await writeFile(path.join(output_dir, "keep"), "original");
    const alias = path.join(root, "alias");
    await symlink(path.join(root, "missing"), alias);

    for (const output of [output_dir, alias]) {
      assert.match(await invoke(createOmlxPrepareFramesTool(), { input: video, output_dir: output }), /OUTPUT_CONFLICT/);
    }

    assert.equal(await readFile(path.join(output_dir, "keep"), "utf8"), "original");
  });

  it("retains extracted frames if a later subprocess fails without publishing a manifest", async () => {
    const root = await workspace();
    const output_dir = path.join(root, "partial");

    const processRunner: ProcessRunner = async (command, args, signal) => {
      if (args.at(-1)?.endsWith("_f0001.png")) throw new OmlxToolError("MEDIA_PROCESS_FAILED", "Synthetic second-frame failure");

      return runMediaProcess(command, args, signal);
    };

    const result = await invoke(createOmlxPrepareFramesTool({ processRunner }), { input: video, output_dir, max_frames: 2 });
    assert.match(result, /MEDIA_PROCESS_FAILED.*Incomplete artifacts retained at/);
    assert.ok((await stat(path.join(output_dir, "t_000m00s_f0000.png"))).size > 0);
    await noManifest(output_dir);
  });
});

describe("registered media boundaries", () => {
  it("keeps path schemas platform-neutral and rejects relative paths as SDK failures at execution", async () => {
    for (const args of [
      { input: "C:\\recordings\\video.mp4", output_dir: "D:\\artifacts\\prepared" },
      { input: "\\\\server\\recordings\\video.mp4", output_dir: "\\\\server\\artifacts\\prepared" },
    ]) {
      assert.ok(Value.Check(RecordingSchema, args));
      assert.ok(Value.Check(FramesSchema, args));
    }

    const root = await workspace();

    const dependencies: MediaDependencies = {
      processRunner: async () => { throw new Error("Relative paths must not run subprocesses"); },
      fetchImplementation: async () => { throw new Error("Relative paths must not make network requests"); },
    };

    for (const args of [
      { input: "relative.mp4", output_dir: path.join(root, "prepared") },
      { input: video, output_dir: "relative-directory" },
    ]) {
      for (const tool of [createOmlxTranscriptionTool(dependencies), createOmlxPrepareFramesTool(dependencies)]) {
        const result = await invoke(tool, args);
        assert.match(result, /ABSOLUTE_PATH_REQUIRED/);
      }
    }
  });

  it("reports missing output parents without referencing an uninitialized output path", async () => {
    const root = await workspace();
    const output_dir = path.join(root, "missing-parent", "prepared");
    const server = await service();
    const before = await readFile(video);
    const recording = await invoke(createOmlxTranscriptionTool(server), { input: video, output_dir });
    const frames = await invoke(createOmlxPrepareFramesTool(), { input: video, output_dir });

    for (const result of [recording, frames]) {
      assert.match(result, /INVALID_OUTPUT/);
      assert.match(result, /parent must exist/);
      assert.ok(result.includes(output_dir));
      assert.doesNotMatch(result, /undefined/);
    }

    assert.equal(server.uploads.length, 0);
    assert.deepEqual(await readFile(video), before);
    await assert.rejects(stat(output_dir), { code: "ENOENT" });
  });

  it("checks runtime schemas including NaN, infinity, counts, nested fields and mutually exclusive output modes", async () => {
    const root = await workspace();
    const output_dir = path.join(root, "invalid");

    const dependencies: MediaDependencies = {
      processRunner: async () => { throw new Error("Subprocess must not run"); },
      fetchImplementation: async () => { throw new Error("Network must not run"); },
    };

    const transcribe = createOmlxTranscriptionTool(dependencies);

    for (const value of [
      { input: video }, { input: video, output_dir, output: path.join(root, "a.txt") },
      { input: video, output_dir, chunk_seconds: NaN }, { input: video, output_dir, chunk_seconds: Infinity },
      { input: video, output_dir, chunk_seconds: 9 }, { input: video, output_dir, chunk_seconds: 121 },
      { input: video, output_dir, timeout_seconds: 1801 }, { input: video, output_dir, allow_remote: "true" },
      { input: video, output_dir, unknown: true },
    ]) assert.match(await invoke(transcribe, value), /INVALID_INPUT/);
    const frames = createOmlxPrepareFramesTool(dependencies);

    for (const value of [
      { seconds: [NaN] }, { seconds: [Infinity] }, { seconds: [-1] }, { seconds: [1, 1] },
      { seconds: [] }, { seconds: Array.from({ length: 121 }, (_, i) => i) },
      { max_frames: 121 }, { max_frames: 0 }, { max_frames: 1.5 },
      { width: 4097 }, { width: NaN }, { end: Infinity }, { start: NaN },
      { crop: { x: 0, y: 0, width: 0, height: 1 } }, { crop: { x: 0, y: -1, width: 1, height: 1 } },
      { crop: { x: 0, y: 0, width: 1, height: 1, extra: true } }, { format: "webp" },
      { timeout_seconds: 0 }, { extra: true },
    ]) assert.match(await invoke(frames, { input: video, output_dir, ...value }), /INVALID_INPUT/);
    await assert.rejects(stat(output_dir), { code: "ENOENT" });
  });

  it("rejects traversal and canonical plugin-tree destinations including symlink aliases", async () => {
    const root = await workspace();
    const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const alias = path.join(root, "plugin");
    await symlink(plugin, alias);

    for (const output_dir of [
      `${root}/../traversal`, path.join(plugin, "prepared"), path.join(plugin, "extensions/omlx-media/dist/prepared"), path.join(alias, "prepared"),
    ]) {
      const result = await invoke(createOmlxPrepareFramesTool(), { input: video, output_dir });
      assert.match(result, /INVALID_PATH|PLUGIN_OUTPUT_FORBIDDEN/);
    }

    const result = await invoke(createOmlxTranscriptionTool(), { input: video, output_dir: path.join(alias, "prepared") });
    assert.match(result, /PLUGIN_OUTPUT_FORBIDDEN/);
    assert.match(await invoke(createOmlxTranscriptionTool(), { input: audioOnly, output: path.join(alias, "protected.txt") }), /PLUGIN_OUTPUT_FORBIDDEN/);
  });

  it("returns actionable missing ffmpeg and ffprobe errors through handlers", async () => {
    const root = await workspace();
    const missingProbe: ProcessRunner = async () => { throw new OmlxToolError("FFPROBE_NOT_FOUND", "Install ffmpeg including ffprobe on PATH"); };

    const missingFfmpeg = probeRunner(mediaMetadata, new OmlxToolError("FFMPEG_NOT_FOUND", "Install ffmpeg on PATH"));

    for (const processRunner of [missingProbe, missingFfmpeg]) {
      for (const tool of [createOmlxPrepareFramesTool({ processRunner }), createOmlxTranscriptionTool({ processRunner })]) {
        const args = { input: video, output_dir: path.join(root, "missing") };
        const result = await invoke(tool, args);
        assert.match(result, /FFMPEG_NOT_FOUND|FFPROBE_NOT_FOUND/);
        assert.match(result, /Install ffmpeg/);
      }
    }
  });

  it("rejects no-video/no-audio media without creating output directories", async () => {
    const root = await workspace();
    const output_dir = path.join(root, "none");
    assert.match(await invoke(createOmlxPrepareFramesTool(), { input: audioOnly, output_dir }), /NO_VIDEO_STREAM/);
    assert.match(await invoke(createOmlxTranscriptionTool(), { input: videoOnly, output_dir }), /NO_AUDIO_STREAM/);
    await assert.rejects(stat(output_dir), { code: "ENOENT" });
  });

  it("enforces source-duration, chunk-count, stream-dimension and total pixel caps", async () => {
    const root = await workspace();
    const output_dir = path.join(root, "capped");
    const dependencies = (metadata: ProbeFixture) => ({ processRunner: probeRunner(metadata) });
    assert.match(await invoke(createOmlxPrepareFramesTool(dependencies({ ...mediaMetadata, format: { duration: "7201" } })), { input: video, output_dir }), /MEDIA_DURATION_LIMIT/);
    assert.match(await invoke(createOmlxTranscriptionTool(dependencies({
      ...mediaMetadata, format: { duration: "1210" },
      streams: [{ index: 1, codec_type: "audio", sample_rate: "16000", duration: "1210" }],
    })), { input: video, output_dir, chunk_seconds: 10 }), /CHUNK_COUNT_LIMIT/);
    assert.match(await invoke(createOmlxPrepareFramesTool(dependencies({ format: { duration: "12" }, streams: [{ index: 0, codec_type: "video", width: 16384, height: 16384 }] })), { input: video, output_dir }), /MEDIA_DIMENSION_LIMIT/);
    assert.match(await invoke(createOmlxPrepareFramesTool(dependencies({ format: { duration: "12" }, streams: [{ index: 0, codec_type: "video", width: 4096, height: 4096, duration: "12" }] })), { input: video, output_dir, width: 4096, max_frames: 120 }), /FRAME_WORK_LIMIT/);

    for (const duration of ["NaN", "Infinity", "0", "-1"]) {
      assert.match(await invoke(createOmlxPrepareFramesTool(dependencies({ ...mediaMetadata, format: { duration } })), { input: video, output_dir }), /INVALID_MEDIA/);
    }

    await assert.rejects(stat(output_dir), { code: "ENOENT" });
  });

  it("cancels and times out subprocesses through the invocation signal, retaining extracted files", async () => {
    const root = await workspace();

    for (const mode of ["cancel", "timeout"] as const) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;

      const processRunner: ProcessRunner = async (command, args, signal) => {
        if (command === "ffmpeg" && args.at(-1)?.endsWith("_f0001.png")) {
          if (mode === "cancel") timer = setTimeout(() => controller.abort(), 10);

          return runMediaProcess("ffmpeg", [
            "-nostdin", "-v", "error", "-re", "-f", "lavfi", "-i",
            "testsrc2=size=320x180:rate=3", "-f", "null", "-",
          ], signal);
        }

        return runMediaProcess(command, args, signal);
      };

      const output_dir = path.join(root, mode);

      try {
        const result = await invoke(createOmlxPrepareFramesTool({ processRunner }), { input: video, output_dir, max_frames: 2, timeout_seconds: 1 }, controller.signal);
        assert.match(result, mode === "cancel" ? /CANCELLED/ : /OPERATION_TIMEOUT/);
        assert.match(result, /Incomplete artifacts retained at/);
        assert.ok((await stat(path.join(output_dir, "t_000m00s_f0000.png"))).size > 0);
        await noManifest(output_dir);
      } finally {
        clearTimeout(timer);
      }
    }
  });

  it("returns cancellation before doing any work for already-aborted invocations", async () => {
    const root = await workspace();
    const output_dir = path.join(root, "cancelled");
    const signal = AbortSignal.abort();
    assert.match(await invoke(createOmlxPrepareFramesTool(), { input: video, output_dir }, signal), /CANCELLED/);
    assert.match(await invoke(createOmlxTranscriptionTool(), { input: video, output_dir }, signal), /CANCELLED/);
    await assert.rejects(stat(output_dir), { code: "ENOENT" });
  });

  it("rejects empty, directory and oversized sources without media work", async () => {
    const root = await workspace();
    const empty = path.join(root, "empty.mp4");
    const large = path.join(root, "large.mp4");
    await writeFile(empty, "");
    await writeFile(large, "");
    await truncate(large, 4 * 1024 ** 3 + 1);
    const output_dir = path.join(root, "invalid-source");
    const processRunner: ProcessRunner = async () => { throw new Error("No subprocess should run"); };

    for (const input of [empty, root, large]) {
      assert.match(await invoke(createOmlxPrepareFramesTool({ processRunner }), { input, output_dir }), /INVALID_INPUT/);
      assert.match(await invoke(createOmlxTranscriptionTool({ processRunner }), { input, output_dir }), /INVALID_INPUT/);
    }

    await assert.rejects(stat(output_dir), { code: "ENOENT" });
  });

  it("bounds subprocess diagnostic buffers and reports retained incomplete artifacts", async () => {
    const root = await workspace();
    const output_dir = path.join(root, "diagnostics");

    const processRunner: ProcessRunner = async (command, args, signal) => {
      if (command === "ffmpeg" && args.at(-1)?.endsWith("_f0000.png")) {
        return runMediaProcess("ffmpeg", [
          "-nostdin", "-v", "debug", "-debug_ts", "-f", "lavfi", "-i",
          "testsrc2=size=16x16:rate=1000", "-f", "null", "-",
        ], signal);
      }

      return runMediaProcess(command, args, signal);
    };

    const result = await invoke(createOmlxPrepareFramesTool({ processRunner }), { input: video, output_dir, max_frames: 1, timeout_seconds: 5 });
    assert.match(result, /MEDIA_DIAGNOSTICS_LIMIT/);
    assert.match(result, /Incomplete artifacts retained at/);
    await noManifest(output_dir);
  });
});
