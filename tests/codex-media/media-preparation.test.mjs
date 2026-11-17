import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

const roots = [];
const shim = fileURLToPath(new URL("./fixtures/media-spawn.mjs", import.meta.url));

const metadata = {
  format: { duration: "12", start_time: "0" },
  streams: [
    { index: 0, codec_type: "video", width: 320, height: 180, duration: "12" },
    { index: 1, codec_type: "audio", sample_rate: "16000", duration: "12" },
  ],
};

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "media-preparation-")));
  roots.push(root);
  const plugin = path.join(root, "plugin");
  const helper = path.join(plugin, "extensions", "omlx-media", "dist", "media.mjs");
  await mkdir(path.dirname(helper), { recursive: true });
  await cp(new URL("../../plugins/omlx-media/extensions/omlx-media/dist/", import.meta.url), path.dirname(helper), { recursive: true });
  const input = path.join(root, "source.fixture");
  await writeFile(input, JSON.stringify(metadata));

  return {
    root, plugin, input,
    invoke: (operation, args, environment = {}) => spawnSync(process.execPath, [
      "--import", shim, helper, operation, "--json", JSON.stringify({ input, ...args }),
    ], {
      encoding: "utf8", timeout: 15_000,
      env: { ...process.env, OMLX_BASE_URL: "http://127.0.0.1:1", OMLX_API_KEY: "", ...environment },
    }),
  };
}

function failure(result, expected) {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, expected);
  assert.equal(result.stdout, "");
}

test("frame CLI keeps fractional timestamps, unrotated crop, bounded dimensions and JPEG compatibility", async () => {
  const { root, input, invoke } = await fixture();
  const before = await readFile(input);

  const result = invoke("prepare-frames", {
    output_dir: path.join(root, "frames"), seconds: [1.1, 1.4, 11.999], width: 160,
    crop: { x: 20, y: 10, width: 200, height: 100 }, format: "jpeg",
  });

  assert.equal(result.status, 0, result.stderr);
  const saved = JSON.parse(result.stdout);
  assert.equal(saved.classification_script_compatible, true);
  const manifest = JSON.parse(await readFile(saved.manifest, "utf8"));
  assert.deepEqual(manifest.frames.map((frame) => frame.requested_seconds), [1.1, 1.4, 11.999]);
  assert.deepEqual(manifest.dimensions, { width: 160, height: 80 });
  assert.deepEqual(manifest.frames.map((frame) => path.basename(frame.file)),
    ["t_000m01s_f0000.jpg", "t_000m01s_f0001.jpg", "t_000m12s_f0002.jpg"]);
  const extracted = JSON.parse(await readFile(manifest.frames[0].file, "utf8"));

  for (const flag of ["-n", "-noautorotate", "-noaccurate_seek", "-protocol_whitelist"]) assert.ok(extracted.request.includes(flag));
  assert.match(extracted.request[extracted.request.indexOf("-vf") + 1], /crop=200:100:20:10:exact=1,scale=160:80/);
  assert.deepEqual(await readFile(input), before);
});

test("default frame sampling is 24 start-inclusive end-exclusive samples without upscaling", async () => {
  const { root, invoke } = await fixture();
  const result = invoke("prepare-frames", { output_dir: path.join(root, "default") });
  assert.equal(result.status, 0, result.stderr);
  const saved = JSON.parse(result.stdout);
  assert.equal(saved.frames, 24);
  assert.equal(saved.format, "png");
  assert.equal(saved.classification_script_compatible, false);
  const manifest = JSON.parse(await readFile(saved.manifest, "utf8"));
  assert.deepEqual(manifest.dimensions, { width: 320, height: 180 });
  assert.equal(manifest.frames[0].requested_seconds, 0);
  assert.equal(manifest.frames.at(-1).requested_seconds, 11.5);
});

test("recording-only options, conflicting outputs and bounded frame shapes fail before side effects", async () => {
  const { root, invoke } = await fixture();

  for (const extra of [{ chunk_seconds: 60 }, { timeout_seconds: 600 }, { allow_remote: false }]) {
    failure(invoke("transcribe", { output: path.join(root, "legacy.txt"), ...extra }), /Invalid transcription arguments/);
  }

  failure(invoke("transcribe", { output: path.join(root, "x.txt"), output_dir: path.join(root, "x") }), /Invalid transcription arguments/);

  for (const args of [
    { max_frames: 0 }, { max_frames: 121 }, { seconds: [1, 1] }, { seconds: [1], start: 0 },
    { width: 4097 }, { crop: { x: 300, y: 0, width: 100, height: 10 } }, { start: 1, end: 1 },
    { seconds: [12] }, { timeout_seconds: 0 }, { format: "webp" },
  ]) {
    failure(invoke("prepare-frames", { output_dir: path.join(root, "invalid"), ...args }), /Invalid frame preparation arguments|INVALID_(INPUT|CROP|RANGE)/);
  }

  await assert.rejects(stat(path.join(root, "invalid")), { code: "ENOENT" });
});

test("fresh directories reject existing paths, dangling symlinks, traversal, plugin aliases and missing parents", async () => {
  const { root, plugin, input, invoke } = await fixture();
  const before = await readFile(input);
  const existing = path.join(root, "existing");
  await mkdir(existing);
  await writeFile(path.join(existing, "keep"), "untouched");
  const alias = path.join(root, "plugin-alias");
  await symlink(plugin, alias, "dir");
  const dangling = path.join(root, "dangling");
  await symlink(path.join(root, "missing"), dangling, "dir");

  for (const [output_dir, code] of [
    [existing, /OUTPUT_CONFLICT/], [dangling, /OUTPUT_CONFLICT/],
    [path.join(plugin, "bad"), /PLUGIN_OUTPUT_FORBIDDEN/], [path.join(alias, "bad"), /PLUGIN_OUTPUT_FORBIDDEN/],
    [root + "/parent/../bad", /INVALID_PATH/], [path.join(root, "missing", "nested"), /INVALID_OUTPUT/],
    ["relative", /ABSOLUTE_PATH_REQUIRED/],
  ]) {
    failure(invoke("prepare-frames", { output_dir, max_frames: 1 }), code);
  }

  assert.equal(await readFile(path.join(existing, "keep"), "utf8"), "untouched");
  assert.deepEqual(await readFile(input), before);
});

test("resource limits reject duration, dimensions, chunk counts, work and bytes before creating output", async () => {
  const { root, input, invoke } = await fixture();

  const cases = [
    ["prepare-frames", { ...metadata, format: { duration: "7201" } }, {}, /MEDIA_DURATION_LIMIT/],
    ["prepare-frames", { ...metadata, streams: [{ index: 0, codec_type: "video", width: 16384, height: 16384 }] }, {}, /MEDIA_DIMENSION_LIMIT/],
    ["transcribe", { format: { duration: "7200" }, streams: [{ index: 0, codec_type: "audio", duration: "7200" }] }, { chunk_seconds: 10 }, /CHUNK_COUNT_LIMIT/],
    ["prepare-frames", { format: { duration: "12" }, streams: [{ index: 0, codec_type: "video", width: 4096, height: 4096, duration: "12" }] }, { width: 4096, max_frames: 120 }, /FRAME_WORK_LIMIT/],
    ["transcribe", { ...metadata, streams: [metadata.streams[0]] }, {}, /NO_AUDIO_STREAM/],
    ["prepare-frames", { ...metadata, streams: [metadata.streams[1]] }, {}, /NO_VIDEO_STREAM/],
    ["prepare-frames", { format: { duration: "NaN" }, streams: [] }, {}, /INVALID_MEDIA/],
  ];

  for (const [operation, probe, args, code] of cases) {
    await writeFile(input, JSON.stringify(probe));
    failure(invoke(operation, { output_dir: path.join(root, "limited"), ...args }), code);
  }

  await truncate(input, 4 * 1024 ** 3 + 1);
  failure(invoke("prepare-frames", { output_dir: path.join(root, "large") }), /INVALID_INPUT/);
  await truncate(input, 0);
  failure(invoke("prepare-frames", { output_dir: path.join(root, "empty") }), /INVALID_INPUT/);
  await assert.rejects(stat(path.join(root, "limited")), { code: "ENOENT" });
});
