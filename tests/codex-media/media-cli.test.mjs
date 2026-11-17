import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

const roots = [];

afterEach(async () => { for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function fixture() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "scarypilot-media-cli-")); roots.push(cwd);
  const plugin = path.join(cwd, "plugin");
  const helper = path.join(plugin, "extensions", "omlx-media", "dist", "media.mjs");
  await mkdir(path.dirname(helper), { recursive: true });
  await cp(new URL("../../plugins/omlx-media/extensions/omlx-media/dist/", import.meta.url), path.dirname(helper), { recursive: true });
  const shim = path.join(cwd, "fetch.mjs");
  await writeFile(shim, `
    globalThis.fetch = async (url, init = {}) => {
      if (init.headers?.Authorization !== 'Bearer fixture-key') throw new Error('Missing auth');
      if (String(url).endsWith('/v1/models/status')) return Response.json({ models: [
        { id: 'fixture-image', engine_type: 'image', loaded: true },
        { id: 'fixture-tts', model_type: 'audio_tts', loaded: true },
        { id: 'fixture-stt', model_type: 'audio_stt', loaded: true }
      ] });
      if (String(url).endsWith('/v1/images/generations') || String(url).endsWith('/v1/images/edits')) {
        const body = JSON.parse(init.body);
        if (body.model !== 'fixture-image') throw new Error('Wrong model');
        return Response.json({ data: Array.from({length: body.n}, () => ({ b64_json: Buffer.from('fixture-png').toString('base64') })) });
      }
      if (String(url).endsWith('/v1/audio/speech')) return new Response('fixture-wav', {headers: {'content-type': 'audio/wav'}});
      if (String(url).endsWith('/v1/audio/transcriptions')) {
        if (!(init.body.get('file') instanceof Blob)) throw new Error('Missing audio upload');
        return Response.json({text: 'A grounded fixture transcript.'});
      }
      throw new Error('Unexpected request');
    };
  `);

  return { cwd, helper, invoke: (operation, args) => spawnSync("node",
    ["--import", shim, helper, operation, "--json", JSON.stringify(args)],
    { cwd, encoding: "utf8", env: { ...process.env, OMLX_BASE_URL: "http://fixture.invalid", OMLX_API_KEY: "fixture-key" } }) };
}

test("self-contained helper generates variants without workspace dependencies", async () => {
  const { cwd, invoke } = await fixture();
  const result = invoke("image", { prompt: "A fixture", output: path.join(cwd, "picture.png"), variants: 2 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { operation: "generate", model: "fixture-image", files: [path.join(cwd, "picture_0.png"), path.join(cwd, "picture_1.png")] });

  for (const file of JSON.parse(result.stdout).files) assert.equal(await readFile(file, "utf8"), "fixture-png");
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-key/);
});

test("helper edits without modifying sources and refuses overwrite", async () => {
  const { cwd, invoke } = await fixture(); const input = path.join(cwd, "source.png"), output = path.join(cwd, "edit.png");
  await writeFile(input, "original");
  const args = { prompt: "Keep the subject", output, sources: [input], strength: 0.3 };
  const first = invoke("image", args); assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).operation, "edit");
  assert.equal(await readFile(input, "utf8"), "original");
  const second = invoke("image", args); assert.equal(second.status, 1); assert.match(second.stderr, /already exists/);
  assert.equal(await readFile(output, "utf8"), "fixture-png");
});

test("helper generates speech and transcribes local files", async () => {
  const { cwd, invoke } = await fixture(); const speech = path.join(cwd, "narration.wav"), transcript = path.join(cwd, "transcript.txt");
  const tts = invoke("speech", { input: "Hello", output: speech }); assert.equal(tts.status, 0, tts.stderr);
  assert.deepEqual(JSON.parse(tts.stdout), { model: "fixture-tts", file: speech });
  assert.equal(await readFile(speech, "utf8"), "fixture-wav");
  const stt = invoke("transcribe", { input: speech, output: transcript }); assert.equal(stt.status, 0, stt.stderr);
  assert.equal(JSON.parse(stt.stdout).text, "A grounded fixture transcript.");
  assert.match(await readFile(transcript, "utf8"), /grounded fixture/);
});

test("malformed CLI arguments fail before network or file writes", async () => {
  const { cwd, invoke } = await fixture();

  for (const [operation, args, expected] of [
    ["speech", { input: 123, output: path.join(cwd, "bad.wav") }, /Invalid speech arguments/],
    ["speech", { input: "hello", output: "relative.wav" }, /Path must be absolute/],
    ["speech", { input: "hello", output: path.join(cwd, "bad.wav"), speed: 0 }, /Invalid speech arguments/],
    ["image", { prompt: "test", output: path.join(cwd, "bad.png"), mask: "source.png" }, /require source images/],
    ["image", { prompt: "test", output: path.join(cwd, "bad.png"), variants: 8 }, /Invalid image arguments/],
    ["transcribe", { input: "", output: path.join(cwd, "bad.txt") }, /Invalid transcription arguments/],
    ["transcribe", { input: path.join(cwd, "missing.wav"), output: "" }, /Invalid transcription arguments/],
    ["transcribe", { input: path.join(cwd, "missing.wav"), output: path.join(cwd, "bad.txt"), model: "" }, /Invalid transcription arguments/],
    ["unknown", {}, /Unknown operation/],
  ]) {
    const result = invoke(operation, args); assert.equal(result.status, 1); assert.match(result.stderr, expected); assert.equal(result.stdout, "");
  }
});
