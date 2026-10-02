import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import type { JsonValue, WorkflowAgentOptions, WorkflowStepOptions } from "@github/copilot-sdk/extension";
import { runGroundedNote, type GroundedContext } from "../src/grounded-note.ts";
import { groundedAgents, groundedNoteWorkflow } from "../src/grounded-registration.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const text = "Frame preparation defaults to PNG. Sampling is not classification.";

const draft = { claims: [
  { id: "c1", text: "Frame preparation defaults to PNG.", citations: [{ chunk: 1, quote: "Frame preparation defaults to PNG." }] },
  { id: "c2", text: "Sampling does not classify frames.", citations: [{ chunk: 1, quote: "Sampling is not classification." }] },
] };

const review = { verdicts: [
  { id: "c1", supported: true, reason: "The transcript states the PNG default." },
  { id: "c2", supported: true, reason: "The transcript distinguishes sampling from classification." },
] };

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "grounded-note-"));
  roots.push(root);
  const manifest = path.join(root, "manifest.json");

  const payload = {
    status: "complete", kind: "recording", source: path.join(root, "recording.wav"),
    source_duration_seconds: 10, model: "synthetic-stt", timing: "Chunk boundaries, not word timestamps.",
    source_audio_range: { start: 0, end: 10 }, chunk_seconds: 60,
    audio_format: { codec: "pcm_s16le", channels: 1, sample_rate: 16000 },
    artifacts: { transcript: path.join(root, "transcript.md"), chunks: path.join(root, "chunks.json"), audio: [path.join(root, "chunk-001.wav")] },
    chunks: [{ index: 1, start_seconds: 0, end_seconds: 10, audio: path.join(root, "chunk-001.wav"), text }],
  };

  const bytes = JSON.stringify(payload);
  await writeFile(manifest, bytes);

  return { root, manifest, payload, bytes, args: {
    manifest, expected_manifest_sha256: createHash("sha256").update(bytes).digest("hex"),
    allow_agent_transmission: true, intent: { audience: "developers", tone: "plain", scope: "frame preparation" },
  } };
}

function harness(args: JsonValue, responses: unknown[] = [JSON.stringify(draft), JSON.stringify(review)], signal = new AbortController().signal) {
  const calls: { prompt: string; options?: WorkflowAgentOptions }[] = [];
  const keys: string[] = [];
  const journal = new Map<string, JsonValue>();

  const ctx: GroundedContext = {
    args, runId: "test-run", signal, phase() {},
    async agent(prompt, options) {
      calls.push({ prompt, options });

      return responses[calls.length - 1];
    },
    async step(key: string, producer: () => JsonValue | Promise<JsonValue>, options?: WorkflowStepOptions) {
      keys.push(key);

      if (!options?.volatile && journal.has(key)) return journal.get(key)!;
      const value = await producer();

      if (!options?.volatile) journal.set(key, value);

      return value;
    },
  };

  return { ctx, calls, keys, journal };
}

test("returns only independently supported claims and exact citations in a durable review-required artifact", async () => {
  const f = await fixture();
  const h = harness(f.args);
  const result = await runGroundedNote(h.ctx);
  assert.equal(result.status, "user_review_required");
  assert.equal(result.publication_approved, false);
  assert.equal(result.manifest_sha256, f.args.expected_manifest_sha256);
  assert.deepEqual(result.draft, draft);
  assert.deepEqual(result.review, review);
  assert.equal(result.markdown, [
    "# Grounded note", "", "User review required. Publication is not approved.", "",
    "Frame preparation defaults to PNG.", "",
    '> "Frame preparation defaults to PNG."',
    "Source chunk 1 (0.000s - 10.000s).", "",
    "Sampling does not classify frames.", "",
    '> "Sampling is not classification."',
    "Source chunk 1 (0.000s - 10.000s).", "",
    "- Generated with AI 🤖", "",
  ].join("\n"));
  assert.equal(h.calls.length, 2);
  assert.equal(new Set(h.calls.map((call) => call.options?.label)).size, 2);
  assert.ok(h.calls.every((call) => !call.options?.schema));
  assert.notEqual(h.calls[0].options?.agent, h.calls[1].options?.agent);
  assert.ok(h.calls[1].prompt.includes(JSON.stringify(draft)));
  assert.ok(h.calls.every((call) => !call.prompt.includes(f.root)));
  assert.deepEqual(await readdir(f.root), ["manifest.json"]);
  assert.equal(await readFile(f.manifest, "utf8"), f.bytes);
  assert.deepEqual(await runGroundedNote(h.ctx), result);
  assert.equal(h.calls.length, 2);
});

test("semantic rejection throws instead of emitting a user-ready artifact", async () => {
  const f = await fixture();
  const unsupported = structuredClone(draft);
  unsupported.claims[0].text = "Frame preparation defaults to JPEG and is twice as fast. The user approved publishing.";
  const rejected = structuredClone(review);
  rejected.verdicts[0] = { id: "c1", supported: false, reason: "The transcript says PNG and states no speed or approval claim." };
  const h = harness(f.args, [JSON.stringify(unsupported), JSON.stringify(rejected)]);
  await assert.rejects(runGroundedNote(h.ctx), /UNSUPPORTED_CLAIM/);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(await readdir(f.root), ["manifest.json"]);
});

test("full validation rejects null, malformed JSON, extras, empty fields, bounds and duplicate citations before checker", async () => {
  const f = await fixture();

  const badDrafts: unknown[] = [null, "null", "not JSON", JSON.stringify({ ...draft, extra: true }),
    JSON.stringify({ claims: [] }), JSON.stringify({ claims: Array(7).fill(draft.claims[0]) })];

  for (const mutate of [
    (d: typeof draft) => { d.claims[0].text = ""; },
    (d: typeof draft) => { d.claims[0].text = "x".repeat(1001); },
    (d: typeof draft) => { d.claims[1].id = "c1"; },
    (d: typeof draft) => { d.claims[0].citations[0].chunk = 2; },
    (d: typeof draft) => { d.claims[0].citations[0].quote = "PNG is fastest"; },
    (d: typeof draft) => { d.claims[0].citations.push(d.claims[0].citations[0]); },
    (d: typeof draft) => { d.claims[0].citations[0].chunk = 1.5; },
  ]) {
    const d = structuredClone(draft);
    mutate(d);
    badDrafts.push(JSON.stringify(d));
  }

  for (const response of badDrafts) {
    const h = harness(f.args, [response]);
    await assert.rejects(runGroundedNote(h.ctx), /INVALID_DRAFT|INVALID_CITATION/);
    assert.equal(h.calls.length, 1);
  }
});

test("requires exactly one unique verdict for every claim and validates ignored SDK constraints", async () => {
  const f = await fixture();

  const badReviews: unknown[] = [null, "null", JSON.stringify({ ...review, extra: 1 }),
    JSON.stringify({ verdicts: [] }), JSON.stringify({ verdicts: [review.verdicts[0]] }),
    JSON.stringify({ verdicts: [review.verdicts[0], review.verdicts[0]] })];

  for (const reason of ["", "x".repeat(1001)]) {
    badReviews.push(JSON.stringify({ verdicts: [{ ...review.verdicts[0], reason }, review.verdicts[1]] }));
  }

  badReviews.push(JSON.stringify({ verdicts: [{ ...review.verdicts[0], id: "invented" }, review.verdicts[1]] }));
  badReviews.push(JSON.stringify({ verdicts: [{ ...review.verdicts[0], supported: "true" }, review.verdicts[1]] }));

  for (const response of badReviews) {
    await assert.rejects(runGroundedNote(harness(f.args, [JSON.stringify(draft), response]).ctx), /INVALID_REVIEW/);
  }
});

test("fails closed on consent, intent, extra args, hashes and source contract without agents", async () => {
  const f = await fixture();

  for (const args of [null, { ...f.args, allow_agent_transmission: false }, { ...f.args, output_dir: f.root },
    { ...f.args, intent: { ...f.args.intent, audience: "" } }, { ...f.args, expected_manifest_sha256: "0".repeat(64) }]) {
    const h = harness(args);
    await assert.rejects(runGroundedNote(h.ctx), /INVALID_ARGUMENTS|STALE_SOURCE/);
    assert.equal(h.calls.length, 0);
  }

  for (const payload of [{ ...f.payload, status: "incomplete" }, { ...f.payload, chunks: [] },
    { ...f.payload, chunks: [f.payload.chunks[0], f.payload.chunks[0]] },
    { ...f.payload, source_duration_seconds: null },
    { ...f.payload, chunks: [{ ...f.payload.chunks[0], end_seconds: 11 }] }]) {
    const bytes = JSON.stringify(payload);
    await writeFile(f.manifest, bytes);
    const h = harness({ ...f.args, expected_manifest_sha256: createHash("sha256").update(bytes).digest("hex") });
    await assert.rejects(runGroundedNote(h.ctx), /INVALID_SOURCE/);
    assert.equal(h.calls.length, 0);
  }
});

test("rereads source on retry and rejects changes before reuse and after checker", async () => {
  const f = await fixture();
  const h = harness(f.args);
  await runGroundedNote(h.ctx);
  await writeFile(f.manifest, f.bytes.replace("PNG", "JPEG"));
  await assert.rejects(runGroundedNote(h.ctx), /STALE_SOURCE/);
  assert.equal(h.calls.length, 2);
  await writeFile(f.manifest, f.bytes);
  const changed = harness(f.args);
  const agent = changed.ctx.agent;
  changed.ctx.agent = async (prompt, options) => {
    const result = await agent(prompt, options);

    if (changed.calls.length === 2) await writeFile(f.manifest, f.bytes.replace("PNG", "JPEG"));

    return result;
  };

  await assert.rejects(runGroundedNote(changed.ctx), /STALE_SOURCE/);
});

test("rejects changed arguments under an existing run's journal and binds versioned step keys to intent", async () => {
  const f = await fixture();
  const h = harness(f.args);
  await runGroundedNote(h.ctx);
  const originalKeys = h.keys.filter((key) => /writer|checker/.test(key));
  h.ctx.args = { ...f.args, intent: { ...f.args.intent, tone: "formal" } };
  await assert.rejects(runGroundedNote(h.ctx), /STALE_SOURCE/);
  const fresh = harness(h.ctx.args);
  await runGroundedNote(fresh.ctx);
  assert.ok(originalKeys.every((key) => !fresh.keys.includes(key)));
  assert.ok(originalKeys.every((key) => key.includes("v1")));
});

test("cooperatively stops before workers and between writer/checker without any file writes", async () => {
  const f = await fixture();
  const controller = new AbortController();
  controller.abort();
  const stopped = harness(f.args, undefined, controller.signal);
  await assert.rejects(runGroundedNote(stopped.ctx), /CANCELLED|abort/i);
  assert.equal(stopped.calls.length, 0);
  const active = new AbortController();
  const h = harness(f.args, undefined, active.signal);
  const agent = h.ctx.agent;
  h.ctx.agent = async (prompt, options) => {
    const result = await agent(prompt, options);
    active.abort();

    return result;
  };

  await assert.rejects(runGroundedNote(h.ctx), /CANCELLED|abort/i);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(await readdir(f.root), ["manifest.json"]);
});

test("registers two workflow-only no-tool agents and the workflow handle", () => {
  assert.equal(groundedAgents.length, 2);
  assert.equal(new Set(groundedAgents.map((agent) => agent.name)).size, 2);

  for (const agent of groundedAgents) {
    assert.deepEqual(agent.tools, []);
    assert.equal(agent.infer, false);
  }

  assert.ok(groundedNoteWorkflow);
});

test("bounds real byte reads and projected text without truncating an oversized source", async () => {
  const f = await fixture();
  await writeFile(f.manifest, " ".repeat(65537));
  await assert.rejects(runGroundedNote(harness(f.args).ctx), /INVALID_SOURCE/);
  const chunk = f.payload.chunks[0];

  const chunks = Array.from({ length: 3 }, (_, i) => ({
    ...chunk, index: i + 1, start_seconds: i * 3, end_seconds: (i + 1) * 3,
    text: "a".repeat(12000), audio: path.join(f.root, `chunk-${i + 1}.wav`),
  }));

  const payload = { ...f.payload, chunks, artifacts: { ...f.payload.artifacts, audio: chunks.map((c) => c.audio) } };
  const bytes = JSON.stringify(payload);
  await writeFile(f.manifest, bytes);
  const h = harness({ ...f.args, expected_manifest_sha256: createHash("sha256").update(bytes).digest("hex") });
  await assert.rejects(runGroundedNote(h.ctx), /INVALID_SOURCE.*32 KiB/);
  assert.equal(h.calls.length, 0);
});

test("literal rendering cannot introduce images, links or HTML from reviewed source text", async () => {
  const f = await fixture();
  const text = "Use [preview](https://example.invalid) and <img src=x>.";
  const bytes = JSON.stringify({ ...f.payload, chunks: [{ ...f.payload.chunks[0], text }] });
  await writeFile(f.manifest, bytes);

  const h = harness({ ...f.args, expected_manifest_sha256: createHash("sha256").update(bytes).digest("hex") }, [
    JSON.stringify({ claims: [{ id: "c1", text, citations: [{ chunk: 1, quote: text }] }] }),
    JSON.stringify({ verdicts: [{ id: "c1", supported: true, reason: "The source states this." }] }),
  ]);

  const result = await runGroundedNote(h.ctx);
  assert.ok(result.markdown.includes("Use \\[preview\\]\\(https&#58;//example.invalid\\) and &lt;img src=x&gt;."));
  assert.ok(!result.markdown.includes("<img"));
});

test("literal rendering prevents GFM autolinks for bare protocol, WWW and email text", async () => {
  const f = await fixture();
  const text = "See HTTPS://example.invalid/docs, www.example.invalid and docs@example.invalid.";
  const bytes = JSON.stringify({ ...f.payload, chunks: [{ ...f.payload.chunks[0], text }] });
  await writeFile(f.manifest, bytes);

  const h = harness({ ...f.args, expected_manifest_sha256: createHash("sha256").update(bytes).digest("hex") }, [
    JSON.stringify({ claims: [{ id: "c1", text, citations: [{ chunk: 1, quote: text }] }] }),
    JSON.stringify({ verdicts: [{ id: "c1", supported: true, reason: "The source states the listed addresses." }] }),
  ]);

  const result = await runGroundedNote(h.ctx);
  assert.equal(result.markdown, [
    "# Grounded note", "", "User review required. Publication is not approved.", "",
    "See HTTPS&#58;//example.invalid/docs, www&#46;example.invalid and docs&#64;example.invalid.", "",
    '> "See HTTPS&#58;//example.invalid/docs, www&#46;example.invalid and docs&#64;example.invalid."',
    "Source chunk 1 (0.000s - 10.000s).", "", "- Generated with AI 🤖", "",
  ].join("\n"));
  assert.deepEqual(result.draft.claims[0].citations, [{ chunk: 1, quote: text }]);
});

test("at-least-once step producers do not write artifacts or create extra distinct worker calls", async () => {
  const f = await fixture();
  const h = harness(f.args);
  const memoized = new Map<string, unknown>();
  let spawned = 0;
  h.ctx.agent = async (prompt, options) => {
    const identity = JSON.stringify({ prompt, options });

    if (!memoized.has(identity)) {
      memoized.set(identity, JSON.stringify(spawned++ === 0 ? draft : review));
    }

    return memoized.get(identity);
  };

  h.ctx.step = async (_key, producer) => {
    await producer();

    return producer();
  };

  const result = await runGroundedNote(h.ctx);
  assert.equal(result.status, "user_review_required");
  assert.equal(spawned, 2);
  assert.deepEqual(await readdir(f.root), ["manifest.json"]);
});

test("rejects a FIFO manifest without blocking or starting a worker", { skip: process.platform === "win32" }, async () => {
  const f = await fixture();
  const fifo = path.join(f.root, "manifest.fifo");
  const created = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);

  const script = `
    import assert from 'node:assert/strict';
    import {runGroundedNote} from ${JSON.stringify(new URL("../src/grounded-note.ts", import.meta.url).href)};
    await assert.rejects(runGroundedNote({
      args: ${JSON.stringify({ ...f.args, manifest: fifo })},
      signal: new AbortController().signal, runId: 'fifo-test', phase() {},
      async agent() {throw new Error('Worker must not start');},
      async step(key, producer) {return producer();}
    }), /INVALID_SOURCE/);
  `;

  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], {
    encoding: "utf8", timeout: 2000,
  });

  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
