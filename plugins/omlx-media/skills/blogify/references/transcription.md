# Transcription

Operational details for `scripts/transcribe.py`, including tuning knobs,
limitations, and attribution constraints.

## Pipeline

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
  `--chunk-sec` (more, smaller chunks = finer timestamps) at the cost of more
  requests.
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
- **Silence threshold.** If chunks are getting cut mid-sentence, lower the
  sensitivity (`--silence-dur 2.0`) or raise `--silence-db` toward `-25`. If
  long monologues never split, do the opposite.
- **Chunk length.** 90–120 s balances timestamp granularity against request
  count. Very long chunks can exceed model context or produce run-on text.
- **Empty/echoed chunks.** A chunk that is almost all silence can transcribe to
  a stray word ("Hello?") or repeat filler. Skipping silence (the default)
  largely avoids this; if you still see it, tighten the silence detection.

## Model selection

`transcribe.py` auto-discovers a model from `/v1/models`, preferring an id
containing `parakeet`, then `asr` / `whisper` / `canary`. Override with
`--model`. Parakeet is fast and accurate for English talks; a whisper-class
model may diarize or timestamp better if available.

## Parakeet vs. gemma `input_audio`

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
