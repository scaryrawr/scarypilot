import assert from "node:assert/strict";
import * as path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "node:test";
import { executeSpeech, executeTranscription } from "../src/execute-audio.ts";

const workspaces: string[] = [];

async function workspace(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "omlx-audio-test-"));
  workspaces.push(directory);

  return directory;
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: Error) => "code" in error && error.code === code);
}

const models = {
  models: [
    { id: "chat", model_type: "llm", loaded: true },
    { id: "breeze", model_type: "audio_tts", loaded: false },
    { id: "kokoro", model_type: "audio_tts", loaded: true },
    { id: "nemotron", model_type: "audio_stt", loaded: true },
  ],
};

describe("OMLX audio tools", () => {
  it("discovers a loaded TTS model, sends OpenAI speech JSON, and saves WAV bytes", async () => {
    const root = await workspace();
    const output = path.join(root, "speech.wav");
    const audio = Buffer.from("wave-data");

    const fetchImplementation = async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/v1/models/status")) return Response.json(models);
      assert.equal(String(input), "http://omlx.test/v1/audio/speech");
      assert.equal(init?.method, "POST");
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer secret");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        model: "kokoro", input: "Hello", voice: "af_heart", response_format: "wav",
      });

      return new Response(audio, { headers: { "content-type": "audio/wav" } });
    };

    const result = await executeSpeech(
      { input: " Hello ", voice: "af_heart", output },
      { environment: { OMLX_BASE_URL: "http://omlx.test/", OMLX_API_KEY: "secret" }, fetchImplementation },
    );

    assert.deepEqual(result, { model: "kokoro", file: output });
    assert.deepEqual(await readFile(output), audio);
  });

  it("uploads multipart audio, forwards recognition guidance, and saves the transcript", async () => {
    const root = await workspace();
    const input = path.join(root, "recording.wav");
    const output = path.join(root, "transcript.txt");
    await writeFile(input, "audio-data");

    const fetchImplementation = async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/v1/models/status")) return Response.json(models);
      assert.equal(String(url), "http://omlx.test/v1/audio/transcriptions");
      assert.equal(init?.method, "POST");
      assert.equal(new Headers(init?.headers).get("Content-Type"), null);
      const form = init?.body;

      assert.ok(form instanceof FormData);
      assert.equal(form.get("model"), "nemotron");
      assert.equal(form.get("response_format"), "json");
      assert.equal(form.get("language"), "en");
      assert.equal(form.get("prompt"), "GitHub Copilot");
      const file = form.get("file");

      assert.ok(file instanceof File);
      assert.equal(file.name, "recording.wav");
      assert.equal(await file.text(), "audio-data");

      return Response.json({ text: "Hello, world.", language: "en" });
    };

    const result = await executeTranscription(
      { input, output, language: "en", prompt: "GitHub Copilot" },
      { environment: { OMLX_BASE_URL: "http://omlx.test" }, fetchImplementation },
    );

    assert.deepEqual(result, { model: "nemotron", file: output, text: "Hello, world." });
    assert.equal(await readFile(output, "utf8"), "Hello, world.");
  });

  it("rejects the wrong model type and accepts an unloaded model for on-demand loading", async () => {
    const root = await workspace();

    const dependencies = {
      fetchImplementation: async (input: string | URL | Request) =>
        String(input).endsWith("/status")
          ? Response.json(models)
          : new Response("audio", { headers: { "content-type": "audio/wav" } }),
    };

    await rejectsWithCode(executeSpeech({ input: "hello", output: path.join(root, "a.wav"), model: "nemotron" }, dependencies), "MODEL_CAPABILITY_MISMATCH");
    await rejectsWithCode(executeSpeech({ input: "hello", output: path.join(root, "a.wav"), model: "missing" }, dependencies), "MODEL_NOT_FOUND");

    const speech = await executeSpeech({ input: "hello", output: path.join(root, "a.wav"), model: "breeze" }, dependencies);

    assert.equal(speech.model, "breeze");
  });

  it("selects an installed STT model when none is loaded", async () => {
    const root = await workspace();
    const input = path.join(root, "audio.wav");
    await writeFile(input, "audio");

    const dependencies = {
      fetchImplementation: async (url: string | URL | Request) =>
        String(url).endsWith("/status")
          ? Response.json({ models: [{ id: "parakeet", model_type: "audio_stt", loaded: false }] })
          : Response.json({ text: "Recognized." }),
    };

    const result = await executeTranscription({ input, output: path.join(root, "transcript.txt") }, dependencies);

    assert.equal(result.model, "parakeet");
  });

  it("rejects invalid paths, existing output, and unsupported formats before making requests", async () => {
    const root = await workspace();
    const existing = path.join(root, "existing.wav");
    await writeFile(existing, "original");

    let calls = 0;

    const dependencies = {
      fetchImplementation: async () => {
        calls++;

        return Response.json(models);
      },
    };

    await rejectsWithCode(executeSpeech({ input: "hello", output: "relative.wav" }, dependencies), "ABSOLUTE_PATH_REQUIRED");
    await rejectsWithCode(executeSpeech({ input: "hello", output: existing }, dependencies), "OUTPUT_CONFLICT");
    await rejectsWithCode(executeSpeech({ input: "hello", output: path.join(root, "voice.mp3") }, dependencies), "INVALID_OUTPUT");
    await rejectsWithCode(executeSpeech({ input: "hello", output: path.join(root, "voice.wav"), speed: 0 }, dependencies), "INVALID_SPEED");
    await rejectsWithCode(executeTranscription({ input: path.join(root, "missing.wav"), output: path.join(root, "transcript.txt") }, dependencies), "INPUT_NOT_FOUND");
    assert.equal(calls, 0);
    assert.equal(await readFile(existing, "utf8"), "original");
  });

  it("preserves API errors and rejects malformed or empty responses without writing artifacts", async () => {
    const root = await workspace();
    const input = path.join(root, "audio.wav");
    await writeFile(input, "audio");

    const unauthorized = async (url: string | URL | Request) =>
      String(url).endsWith("/status") ? Response.json(models) : Response.json({ detail: "Bad key" }, { status: 401 });

    await rejectsWithCode(
      executeSpeech({ input: "hello", output: path.join(root, "unauthorized.wav") }, { fetchImplementation: unauthorized }),
      "AUTHENTICATION_FAILED",
    );

    const malformed = async (url: string | URL | Request) =>
      String(url).endsWith("/status") ? Response.json(models) : Response.json({ language: "en" });

    const output = path.join(root, "transcript.txt");
    await rejectsWithCode(executeTranscription({ input, output }, { fetchImplementation: malformed }), "INVALID_RESPONSE");

    const empty = async (url: string | URL | Request) =>
      String(url).endsWith("/status") ? Response.json(models) : Response.json({ text: "" });

    await rejectsWithCode(executeTranscription({ input, output }, { fetchImplementation: empty }), "INVALID_RESPONSE");
    await assert.rejects(readFile(output), { code: "ENOENT" });
  });
});
