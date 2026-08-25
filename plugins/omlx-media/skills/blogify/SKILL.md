---
name: blogify
description: >-
  Use this skill to turn a video or audio recording (a talk, meeting, or demo)
  into written content: documentation, a blog post, tutorial, changelog, or
  notes. Handles transcription, takeaway synthesis, screenshot/frame selection,
  and grounded drafting from local OpenAI-compatible media models. Not for
  real-time transcription, generic video editing, or non-generative media
  processing.
allowed-tools: Bash(uv run scripts/transcribe.py:*) Bash(uv run scripts/classify_frames.py:*) Bash(uv run scripts/sample_frames.py:*) Bash(uv run scripts/dedupe_frames.py:*) Bash(uv run scripts/extract_frame.py:*) Bash(uv run scripts/crop_frames.py:*)
---

# Blogify workflow

Produce four reviewable artifacts from the recording: transcript, takeaways,
selected frames, and final prose. Run the audio and frame tracks in parallel when
the input is video.

## Requirements

- `$OMLX_BASE_URL` should point at the OpenAI-compatible media endpoint (defaults
  to `http://127.0.0.1:8000` if unset); set `$OMLX_API_KEY` only if the
  endpoint requires auth (otherwise an empty key is assumed).
- `uv` (runs the bundled Python scripts and auto-installs declared
  dependencies), `ffmpeg`, `ffprobe`, and ImageMagick (`magick`/`convert`) must
  be available.
- Keep all inputs and outputs in the user's workspace. Pass absolute paths; the
  scripts refuse to write inside the skill directory.

## First: get the intent

Collect the **output type, audience, tone, and scope** from the prompt or user
before drafting. Use `references/authoring.md` for the authoring checklist.

## Workflow

1. **Transcribe.** Run `uv run scripts/transcribe.py --input <file> --output-dir
   <dir>`. Produces `transcript.md` (timestamped) and `chunks.json`. The model is
   auto-discovered (prefers parakeet); override with `--model`. For tuning and
   limitations, use `references/transcription.md` (no timestamps, no diarization
   — reconstruct/attribute accordingly).
2. **Mine takeaways.** From the transcript, synthesize per-topic takeaways in
   the reader's voice. Correct mistranscribed jargon against ground truth
   (slides, repo names). Stay grounded — never invent claims. For long
   recordings, fan out per-topic synthesis to sub-agents.
3. **Sample frames** (in parallel with 1–2). `uv run scripts/sample_frames.py --input
   <video> --output-dir <sampled-frames-dir>` grabs scene-change + periodic
   frames named by timestamp. Then run `uv run scripts/dedupe_frames.py --frames-dir
   <sampled-frames-dir> --output-dir <dedup-frames-dir>` to drop
   near-duplicates.
4. **Classify frames.** `uv run scripts/classify_frames.py --frames-dir <dedup>
   --output <dir>/manifest.json --context "<one line about the video>"
   --categories "<A,B,...,OTHER>" --batch-size 4 --select-dir <selected-dir>`. Use a SHORT enum of categories —
   the vision model is a reliable *classifier*, a poor open-ended captioner. It
   returns constrained JSON labels (validated against the enum). `--batch-size`
   classifies several frames per request to amortize the endpoint's large fixed
   per-request cost (~6–8 s); 4 is a safe default, raise it for distinct frames.
   For sampling pitfalls, batching, and targeted re-sampling, use `references/frames.md`. The local OMLX
   model is the default; if its per-request cost makes a large frame set
   impractical even when batched, `references/frames.md` documents a **privacy-gated cloud-subagent
   fallback** (only with explicit user consent, since frames leave the machine).
5. **Pick + polish images.** For chosen frames, re-extract at full resolution
   with `uv run scripts/extract_frame.py --input <video> --second <secs> --output
   <dir>/shot.png` and crop overlays with `uv run scripts/crop_frames.py`. Verify picks
   visually before using them.
6. **Author the output.** Draft the doc/blog per the requested intent. Add a
   screenshot only where it makes the text easier to understand, placed next to
   the concept, with descriptive alt text. Use `references/authoring.md`.
7. **If in a repo, wire and validate.** Follow the repo's image/LFS conventions,
   optionally embed the recording/slides, run its markdown lint / link / TOC
   checks, and respect its PR conventions (some repos want changes left in the
   working tree). Use `references/authoring.md`.

## Notes

- Keep the transcript, takeaways, frame manifest, and selected frames in the
  workspace — deliver the artifacts, not just the final prose.
- The transcript and the frame filenames share the video timeline, so you can
  line up "demoed at 34:59" with the frame captured at 34:59.
- Run only the scripts bundled here; do not copy them elsewhere.
