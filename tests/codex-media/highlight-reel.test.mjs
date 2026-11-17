import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

const skill = fileURLToPath(new URL("../../plugins/omlx-media/skills/highlight-reel/", import.meta.url));
const roots = [];
const uv = spawnSync("uv", ["--version"], { encoding: "utf8" });

assert.equal(uv.status, 0, "Highlight helper tests require uv");

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "highlights-"));
  roots.push(root);
  const transcript = path.join(root, "transcript.md");
  const highlights = path.join(root, "highlights.json");
  const takeaways = path.join(root, "takeaways.md");
  await writeFile(transcript, "# Transcript\n\n## 0.000s - 2.000s\n\nWe keep the source recording intact.\n");
  await writeFile(highlights, JSON.stringify([{ title: "Keep originals", start_sec: 0, end_sec: 1 }]));
  await writeFile(takeaways, '"We keep the source recording intact."\n');

  return { root, transcript, highlights, takeaways };
}

function invoke(script, args, environment = {}) {
  return spawnSync("uv", ["run", "--no-project", "python", path.join(skill, "scripts", script), ...args], {
    encoding: "utf8", timeout: 30_000,
    env: { ...process.env, UV_OFFLINE: "1", UV_PYTHON_DOWNLOADS: "never", ...environment },
  });
}

test("highlight verification accepts shared native transcripts and rejects altered quotes or invalid intervals", async () => {
  const { root, transcript, highlights, takeaways } = await fixture();
  await writeFile(path.join(root, "chunks.json"), JSON.stringify({
    chunks: [{ start_seconds: 0, end_seconds: 2 }],
  }));
  const args = ["--transcript", transcript, "--highlights", highlights, "--takeaways", takeaways];
  const fixed = invoke("verify_reel.py", [...args, "--fix"]);
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.equal(JSON.parse(await readFile(highlights, "utf8"))[0].verified, true);
  assert.match(fixed.stdout, /quotes: 1\/1 verbatim/);
  await writeFile(takeaways, '"We delete the source recording."\n');
  const altered = invoke("verify_reel.py", args);
  assert.equal(altered.status, 1, altered.stderr);
  assert.match(altered.stdout, /QUOTE not verbatim/);
  await writeFile(highlights, JSON.stringify([{ start_sec: 1, end_sec: 0 }]));
  const reversed = invoke("verify_reel.py", ["--transcript", transcript, "--highlights", highlights, "--fix"]);
  assert.equal(reversed.status, 1);
  assert.equal(JSON.parse(await readFile(highlights, "utf8"))[0].verified, false);
});

test("legacy timestamp verification still snaps metadata without repairing quotes", async () => {
  const { transcript, highlights } = await fixture();
  await writeFile(transcript, "## [00:30-01:00]\n\nKeep this exact phrase intact.\n");
  await writeFile(highlights, JSON.stringify([{ start_sec: 100, end_sec: 120 }]));
  const result = invoke("verify_reel.py", ["--transcript", transcript, "--highlights", highlights, "--fix"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(highlights, "utf8")), [{ start_sec: 30, end_sec: 60, verified: true }]);
});

test("scene comparison reports unchanged PNG footage without a model", async () => {
  const { root } = await fixture();
  const frames = path.join(root, "frames");
  await mkdir(frames);
  const source = new URL("../../plugins/omlx-media/skills/image-gen/evals/files/edit-base.png", import.meta.url);
  await copyFile(source, path.join(frames, "t_000m00s_f0000.png"));
  await copyFile(source, path.join(frames, "t_000m01s_f0001.png"));
  const result = invoke("scene_diff.py", ["--frames-dir", frames]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.uniform, true);
  assert.equal(report.frames_compared, 1);
  assert.equal(report.candidates[0].est_second, 1);
});

test("clip export cuts synthetic video, verifies duration and refuses to replace an earlier run", async () => {
  const { root, highlights } = await fixture();
  await writeFile(highlights, JSON.stringify([{ title: "Keep originals", start_sec: 0, end_sec: 1, verified: true }]));
  const input = path.join(root, "source.mp4");

  const generated = spawnSync("ffmpeg", [
    "-nostdin", "-v", "error", "-n", "-f", "lavfi", "-i", "color=c=navy:s=64x64:r=10:d=2",
    "-an", "-c:v", "libx264", input,
  ], { encoding: "utf8", timeout: 15_000 });

  assert.equal(generated.status, 0, generated.stderr);
  const source = await readFile(input);
  const output = path.join(root, "clips");
  const args = ["--input", input, "--highlights", highlights, "--output-dir", output];
  const cut = invoke("cut_clips.py", args);
  assert.equal(cut.status, 0, cut.stderr);
  const manifest = JSON.parse(await readFile(path.join(output, "clips-manifest.json"), "utf8"));
  assert.equal(manifest.length, 1);
  assert.equal(manifest[0].ok, true);
  assert.ok((await stat(manifest[0].file)).size > 0);
  const repeated = invoke("cut_clips.py", args);
  assert.equal(repeated.status, 1);
  assert.match(repeated.stderr, /must be fresh/);
  assert.deepEqual(await readFile(input), source);
});

test("model probes reject nonlocal transmission and existing outputs before inference", async () => {
  const { root, highlights } = await fixture();

  const remote = invoke("probe_models.py", ["--output", path.join(root, "probe.json")], {
    OMLX_BASE_URL: "https://not-called.invalid",
  });

  assert.equal(remote.status, 1);
  assert.match(remote.stderr, /explicit --allow-remote consent/);
  const existing = invoke("probe_models.py", ["--output", highlights]);
  assert.equal(existing.status, 1);
  assert.match(existing.stderr, /must be new/);
});
