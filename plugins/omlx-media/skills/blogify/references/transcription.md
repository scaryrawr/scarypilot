# Transcription

Native recording preparation and the optional `scripts/transcribe.py` fallback.

## Native recording preparation

Prefer `omlx_transcribe` with `input` and a fresh `output_dir` when the plugin
is installed. The same tool's `output` mode preserves standalone audio-to-text
behavior. `output` and `output_dir` are mutually exclusive.

The recording mode extracts mono 16 kHz WAV chunks and transcribes them
serially through the existing local OMLX client. It writes a timestamped
`transcript.md` and machine-readable chunk metadata and manifest. Read the
returned paths rather than guessing output names.

Native model discovery uses `/v1/models/status`. It prefers a loaded STT model,
then an installed STT model for on-demand loading. A valid explicit `model`
takes priority. Unlike standalone text mode, recording mode rejects malformed
discovery rather than falling back to an unverified explicit model.

Fixed chunks preserve original offsets but may split a word or sentence.
There is no silence removal, word alignment, or speaker diarization.
Do not infer speaker names from chunk boundaries. Correct jargon against
supplied source material without adding unsupported claims.

| Option or limit | Recording mode |
| --- | --- |
| `chunk_seconds` | Integer from 10 to 120. Defaults to 60. At most 120 chunks. |
| `timeout_seconds` | Total deadline from 1 to 1800 seconds. Defaults to 600. |
| Per-request deadline | 120 seconds, including response reads. |
| Source | Nonempty local file, at most 4 GiB and 2 hours. Must contain an audio stream. |
| Response limits | At most 1 MiB per JSON response and 8 MiB accumulated transcript text. |
| `model`, `language`, `prompt` | Optional model selection and recognition guidance. |
| `allow_remote` | Defaults to false. Literal `127.0.0.0/8` and `::1` endpoints are allowed. No redirects. Set true only with explicit recording-specific consent. |
| Artifacts | `transcript.md`, `chunks.json`, per-chunk WAV files, and final `manifest.json`. |

The manifest records the canonical source path, source duration, model, audio
range, audio format, artifact paths, and each chunk's actual extracted offsets
and text. `status: "complete"` appears only after all chunks succeed.
Chunks cover the selected audio stream, not a longer video or container.
When stream duration metadata is absent, a local decode measures its extent
within the same total deadline before scheduling chunks.

Use absolute paths and a new output directory outside the plugin. Create its
parent first, not the output directory itself. A failed run
can leave extracted audio for inspection. Never treat a partial run as a
completed transcript or retry into its directory.

The native recording mode defaults to a loopback OMLX endpoint. Do not enable
remote transmission without the user's explicit consent for this recording.
There is no automatic cloud fallback.

## Legacy silence-aware pipeline

If native tools are unavailable, run `uv run scripts/transcribe.py --input
<absolute-recording> --output-dir <fresh-absolute-dir>`. This script needs `uv`,
Python, `ffmpeg`, and `ffprobe`. Unlike native recording preparation, the script
does not enforce fresh directories, bounded work, or a loopback-only endpoint.
Check its destination and `OMLX_BASE_URL` before running it.

### Pipeline

1. **Extract audio** — 16 kHz mono WAV. ASR models want mono 16 kHz; anything
   else wastes bytes and can hurt accuracy.
2. **Silence map** — `silencedetect=noise=-30dB:d=1.5` finds pauses. This is
   used to *skip* dead air and to place chunk cuts at natural pauses.
3. **Chunk plan** — `plan_chunks.py` merges speech into ~120 s windows, cutting
   only at silence so no word is split. Pure-silence spans are dropped.
4. **Parallel transcription** — each chunk is sliced and POSTed to
   `/v1/audio/transcriptions`. ~3 concurrent requests is a good default; OMLX
   tends to serialize heavy work, so more concurrency yields little.
5. **Assembly** — chunks are ordered and prefixed with `[mm:ss–mm:ss]`.

## The two big limitations (plan around them)

- **No timestamps.** parakeet returns `{"text": ...}` with no word/segment
  timings. Reconstruct timestamps from chunk offsets. For tighter timing, shrink
  native `chunk_seconds` or legacy `--chunk-sec` at the cost of more requests.
  Native recording mode still enforces its 120-chunk limit.
- **No speaker diarization.** The transcript cannot tell you *who* spoke. For a
  multi-person meeting, attribution must come from another source (the Teams
  meeting chat, calendar attendees, or on-screen name tags). Do not invent
  speaker labels.

## Quality tips

- **Jargon errors are normal.** Expect product names, acronyms, and code terms
  to be mistranscribed (e.g. "agenic", "1.js", garbled tool names). Correct
  them against ground truth — the slide deck, repo names, or a known glossary —
  before publishing. Never "clean up" a transcript into claims it does not
  support.
- **Legacy silence threshold.** If script chunks are getting cut mid-sentence, lower the
  sensitivity (`--silence-dur 2.0`) or raise `--silence-db` toward `-25`. If
  long monologues never split, do the opposite.
- **Chunk length.** 90–120 s balances timestamp granularity against request
  count. Very long chunks can exceed model context or produce run-on text.
- **Empty/echoed chunks.** A chunk that is almost all silence can transcribe to
  a stray word ("Hello?") or repeat filler. Skipping silence (the default)
  in the legacy script largely avoids this. Native fixed chunks do not skip
  silence and reject empty model responses instead of publishing a partial
  transcript as complete.

## Model selection

`transcribe.py` auto-discovers a model from `/v1/models`, preferring an id
containing `parakeet`, then `asr` / `whisper` / `canary`. Override with
`--model`. This script's name-based discovery differs from native capability
discovery. Neither pipeline publishes speaker labels or word timestamps.

## Parakeet vs. gemma `input_audio`

This comparison concerns manual model-specific workflows, not native tool
routing. `omlx_transcribe` uses `/v1/audio/transcriptions`, not chat `input_audio`.

OMLX gemma-4 also accepts an `input_audio` part and can transcribe. In testing
it was genuinely good — comparable accuracy on both clear speech and jargon
(`x64`, `ARM64`, `GitHub`), with **cleaner punctuation and capitalization**
(e.g. "DevBoxes"). But **parakeet remains the default** for bulk transcription:

- **Faster** (sub-second vs 2–4 s per clip) — compounds across many chunks.
- **Simpler, scalable API** — multipart file upload with no size ceiling.
  gemma needs base64-in-JSON (~1 MB per 25 s), so a full talk can't go in one
  call; you'd have to chunk anyway.
- **More literal** — gemma occasionally smooths or drops a word, or hallucinates
  a phrase; parakeet stays closer to the raw utterance.

Use gemma `input_audio` when you want **cleaner short-clip transcription**, or to
**reason about audio directly** (summarize, answer a question, gauge tone) in a
single call — something parakeet (pure ASR) can't do.

## Cross-referencing frames

Because both the transcript timestamps and the frame filenames (see
`references/frames.md`) are on the original video timeline, you can line up "the
speaker demos X at 34:59" with the frame captured at 34:59. Keep timelines
aligned — do not silence-*remove* the audio, only skip silence for
transcription.
