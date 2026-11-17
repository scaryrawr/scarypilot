---
name: highlight-reel
description: >-
  Turn a long recording into timestamped highlight clips, key-frame candidates,
  and takeaways with quotes checked against the transcript. Use for podcast,
  livestream, or meeting highlights. Not for image generation, speech synthesis,
  or polished document authoring.
---

# Highlight reel workflow

Deliver clips, a clip manifest, candidate frames, and grounded takeaways.
Use `blogify` when the requested output is a document instead.

Read [the shared media actions](../../references/actions.md). Discover native
recording transcription and frame extraction by action description. Otherwise
use the shared Node CLI. Keywords do not grant permission or prove that a
capability exists.

Resolve each script from this installed skill's absolute directory. Resolve
`../blogify/` from that directory, not the current working directory. Keep source
recordings and all outputs in the user's workspace. Preserve originals and
previous derivatives. Choose fresh output directories outside the plugin.
Check `uv --version` before running Python scripts.

## Choose models from observed capabilities

Use the host's advertised model metadata when available. Do not assume a model
accepts audio, frames, or video because its name appears in an example.
[Historical model-routing evidence](references/model-routing.md) is not a
current availability guarantee.

An optional probe sends synthetic image, audio, and video fixtures to installed
models and may load them. Run it only when those inference calls are authorized:

```text
uv run --no-project python "<skill>/scripts/probe_models.py" --include-stt --output "<workspace>/new-probe-report.json"
```

The probe requires FFmpeg. It uses private temporary fixtures and refuses
redirects. Non-loopback endpoints require explicit consent and `--allow-remote`.
It does not download models. Route batch speech recognition to a transcription
endpoint, not chat completions. Route media understanding only to a model that
accepted the required content type in the current environment.

## Prepare and mine highlights

1. Transcribe the recording with `input` and a fresh `output_dir`. Read its
   manifest and transcript before mining. Chunk boundaries are not word or
   speaker timestamps. Select a smaller `chunk_seconds` only within the shared
   120-chunk and two-hour limits. For optional silence-aware chunking, use
   blogify's `scripts/transcribe.py` after checking its dependencies, endpoint
   consent, and fresh output paths.
2. Prepare a bounded candidate frame set. Use the frame extraction action,
   then run `scripts/scene_diff.py --frames-dir <absolute-frame-directory>`.
   It supports JPEG and PNG. If `uniform` is true, prioritize the transcript
   and inspect only a few candidates. Scene difference ranks visual changes,
   not highlight quality.
3. Mine short transcript sections for takeaways and clip bounds. Keep each clip
   inside a cited chunk window. Require quotes of at most 15 words copied
   exactly, including disfluencies, or omit the quote. Never invent speaker
   attribution. Hosted agents require separate explicit consent before any
   transcript or frames leave the machine. Use them only when actually available.
4. Save a JSON array with `title`, `start_sec`, and `end_sec` for each highlight.
   Keep takeaways in Markdown. Verify through the bundled deterministic helper:

   ```text
   uv run --no-project python "<skill>/scripts/verify_reel.py" --transcript "<transcript>" --highlights "<highlights.json>" --takeaways "<takeaways.md>"
   ```

   Native second-based headers and legacy minute-based headers are supported.
   The checker compares quotes with transcript text, not the original speech.
   Fix mistranscriptions against the recording before presenting quotes as true.
   Use `--fix` only on a working copy of highlight metadata. It adds `verified`
   flags and can snap out-of-window bounds. It never repairs quotes. Read the
   result, fix flagged quotes yourself, and rerun without `--fix`.
5. Cut verified clips into a fresh output directory:

   ```text
   uv run --no-project python "<skill>/scripts/cut_clips.py" --input "<video>" --highlights "<verified-highlights.json>" --output-dir "<new-clips-directory>"
   ```

   The helper tries stream copy, checks duration with FFprobe, and re-encodes
   when duration differs by more than 2.5 seconds. It reports failed clips
   instead of treating process exit alone as success.
6. Re-extract chosen frame timestamps into a fresh directory. Inspect the
   actual clips and frames for content, timing, privacy, and readability.
   Preserve the transcript, source manifest, takeaways, verified highlights,
   `clips-manifest.json`, and clips. Deliver the artifacts without uploading
   or publishing them unless separately requested.
