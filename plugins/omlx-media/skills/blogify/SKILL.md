---
name: blogify
description: >-
  Use this skill to turn a video or audio recording (a talk, meeting, or demo)
  into written content: documentation, a blog post, tutorial, changelog, or
  notes. Handles transcription, takeaway synthesis, screenshot/frame selection,
  and grounded drafting from local OpenAI-compatible media models. Not for
  real-time transcription, generic video editing, or non-generative media
  processing.
allowed-tools: omlx_transcribe omlx_prepare_frames Bash(mkdir:*) Bash(uv run scripts/transcribe.py:*) Bash(uv run scripts/classify_frames.py:*) Bash(uv run scripts/sample_frames.py:*) Bash(uv run scripts/dedupe_frames.py:*) Bash(uv run scripts/extract_frame.py:*) Bash(uv run scripts/crop_frames.py:*)
---

# Blogify workflow

Produce four reviewable artifacts from the recording: transcript, takeaways,
selected frames, and final prose. Run the audio and frame tracks in parallel when
the input is video.

## Requirements

- `$OMLX_BASE_URL` should point at the OpenAI-compatible media endpoint (defaults
  to `http://127.0.0.1:8000` if unset); set `$OMLX_API_KEY` only if the
  endpoint requires auth (otherwise an empty key is assumed).
- `ffmpeg` and `ffprobe` for native recording preparation.
- For direct skill installation or optional classification, `uv` runs the
  bundled Python scripts. Legacy deduplication and cropping also need
  ImageMagick (`magick`/`convert`).
- Keep inputs and outputs in the user's workspace. Pass absolute paths and
  choose a fresh output directory for each preparation call. Never overwrite
  a source recording or an earlier run.
- Create the common parent directory with `mkdir -p <parent>` if needed.
  Leave each native tool's `output_dir` nonexistent. Native tools require its
  parent to exist and refuse writes anywhere inside the plugin.
- Native tools come from plugin installation. If they are unavailable, use the
  bundled scripts explicitly. Do not switch to scripts to bypass a native
  validation, privacy, dependency, or output-conflict error.
- Before using a script, check `OMLX_BASE_URL`. A remote endpoint transmits
  audio or frames off the machine. Require explicit consent for this recording
  before any remote request, including a configured nonlocal endpoint.

## First: get the intent

Collect the **output type, audience, tone, and scope** from the prompt or user
before drafting. Use `references/authoring.md` for the authoring checklist.

## Workflow

1. **Transcribe.** Prefer `omlx_transcribe` with `input` and a fresh
   `output_dir` for a video or audio recording. Read the returned manifest and
   `transcript.md`. The native tool extracts fixed-length audio chunks and
   records their offsets on the original timeline. These are chunk boundaries,
   not word timestamps or speaker labels. For a short audio file needing only
   text, use the same tool's `output` mode with a new `.txt` path. Do not pass
   both `output` and `output_dir`. See `references/transcription.md`.
   When native tools are unavailable, run `uv run scripts/transcribe.py --input
   <file> --output-dir <fresh-dir>` for silence-aware transcription.
2. **Mine takeaways.** From the transcript, synthesize per-topic takeaways in
   the reader's voice. Correct mistranscribed jargon against ground truth
   (slides, repo names). Stay grounded. Never invent claims. For long
   recordings, fan out per-topic synthesis to sub-agents.
3. **Prepare candidate frames** (in parallel with transcription). Prefer
   `omlx_prepare_frames` with `input` and a fresh `output_dir`. It samples a
   bounded set of frames or extracts explicit `seconds`. Read `manifest.json`
   for source timestamps and paths. Sampling does not rank frames, detect
   scenes, or deduplicate them. Use transcript offsets to request a narrower
   window or explicit timestamps when a brief demo is missed. See
   `references/frames.md`. When native tools are unavailable, run
   `uv run scripts/sample_frames.py --input <video> --output-dir <fresh-dir>`.
   If you plan to use the bundled classifier or deduplication script, request
   `format: "jpeg"` for the candidate frames. Native extraction defaults to PNG,
   which those scripts do not discover.
   If candidates contain near-duplicates, optionally run
   `uv run scripts/dedupe_frames.py --frames-dir <sampled> --output-dir
   <fresh-dedup-dir>`.
4. **Classify frames only when useful.** Inspect a small candidate set directly.
   For a larger set, use the optional local vision script:
   `uv run scripts/classify_frames.py --frames-dir <candidates>
   --output <dir>/classification.json --context "<one line about the video>"
   --categories "<A,B,...,OTHER>" --batch-size 4 --select-dir <fresh-selected-dir>`.
   Keep the preparation manifest separate. Use a short enum of categories.
   The vision model is a reliable *classifier*, a poor open-ended captioner. It
   returns constrained JSON labels (validated against the enum). `--batch-size`
   classifies several frames per request to amortize the endpoint's large fixed
   per-request cost (~6–8 s); 4 is a safe default, raise it for distinct frames.
   For sampling pitfalls, batching, and targeted re-sampling, use `references/frames.md`. The local OMLX
   model is the default; if its per-request cost makes a large frame set
   impractical even when batched, `references/frames.md` documents a **privacy-gated cloud-subagent
   fallback** (only with explicit user consent, since frames leave the machine).
   Merge any approved cloud results into a separate classification manifest
   with `file`, `ts`, `label`, and `reason` per frame. Never replace the native
   preparation manifest with classifier output.
5. **Pick + polish images.** Choose frames yourself against the transcript and
   output intent. Re-extract chosen `seconds` with `omlx_prepare_frames` into
   a fresh directory. Use its typed `crop` geometry to remove overlays. For
   source-resolution images within the native width limit, pass the source
   width explicitly. For limits and fallback details, see
   `references/frames.md`. When
   native tools are unavailable, use `uv run scripts/extract_frame.py` and
   `uv run scripts/crop_frames.py` with fresh output paths. Verify picks
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
  workspace. Deliver the artifacts, not just the final prose.
- The transcript and the frame filenames share the video timeline, so you can
  line up "demoed at 34:59" with the frame captured at 34:59.
- Run only the scripts bundled here; do not copy them elsewhere.
- A preparation manifest proves which input and timestamps produced an
  artifact. It does not establish the truth of a transcript or the usefulness
  of a frame. Keep audience, tone, jargon correction, grounded drafting, and
  final editorial selection in this skill.
