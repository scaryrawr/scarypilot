# Historical local model routing evidence

These are upstream observations dated 2026-10-04, not a current capability or
performance claim for this installation. Discover advertised capabilities or
run an authorized fresh probe before selecting a model.

Benchmark harness: a 65-minute split-screen podcast livestream (1080p VP9/webm,
`Poteto on shipping 1,000's of PRs a month at SpaceX`), 66 minute-spaced frames,
25-second audio/video probe clips, and a 38-chunk nemotron transcript. Reproduce
the modality matrix with the installed `scripts/probe_models.py --include-stt
--output <new-absolute-report.json>` through `uv run --no-project python`
(probe-report.json is the machine-readable output).

## Modality matrix (chat completions unless noted)

| Model | image | audio | video | notes |
|---|---|---|---|---|
| `Qwen3.5-9B-oQ4e-mtp` | OK (~10–15 s) | **500 reject** | OK (~47 s / 20 s clip) | leaks chain-of-thought into answers unless `chat_template_kwargs: {"enable_thinking": false}`; with thinking off: clean JSON in 1.9 s |
| `Qwen3.6-35B-A3B-oQ5e-mtp` | OK | 500 reject | OK | ~27 GB — keep out of routine probes (`probe_models.py` skips >12 GB by default) |
| `Qwen3.8-Flash-Next-oQ4e-mtp` | OK | 400 reject | 400 reject | image-only multimodal on this build |
| `gemma-4-12B-it-qat-oQ4e-mtp` | OK (2–6 s after load) | **OK (4 s / 25 s clip)** | **400 reject** | unified audio+vision; punctuation-preserving transcripts; contract-compliant JSON |
| `gemma-4-26B-A4B-it-qat-oQ4e-mtp` | 400 | 400 | 400 | text-only on this build — do not route media here |
| `nemotron-3.5-asr-streaming-0.6b` | — | OK via `/v1/audio/transcriptions` (~1 s / 25 s clip) | — | batch STT only; never via chat completions (400) |

First-call latency includes model load (~0.56 s/GB on this host; oMLX
auto-loads/unloads). Two models resident plus a big multimodal prefill can
trip the prefill memory guard (observed rejection at ~105 GB against a ~101 GB
ceiling): keep sub-agent contexts small, frames <=640px, and one model hot at
a time.

## Head-to-head agent runs (same prompt, same inputs)

| Metric | Qwen3.5-9B | Gemma-4-12B |
|---|---|---|
| Completed all three tasks (takeaways/highlights/frames) | yes | partially — failed `view_image`, reported the failure honestly, then claimed files it never wrote |
| Frame inspection quality | accurate detail (noticed pen, bottle, badges) | n/a this run |
| Quote fidelity vs transcript | 1/12 verbatim (aggressively "cleans" disfluencies, one stitched quote) | 7/13 verbatim (keeps disfluencies, occasional word swaps) |
| Clip bounds inside cited chunk windows | 6/10 (4 snapped by `verify_reel.py`) | 2/6 (rounded 60s clips; 4 snapped) |
| Hallucination style | paraphrases confidently | guesses plausible causes ("watching a video") when unseen |

## Routing verdict

- **Batch STT ground truth:** nemotron via `/v1/audio/transcriptions`. Cheap,
  fast, disfluency-preserving.
- **Anything with audio content beyond transcription** (summarize a clip,
  answer questions about what was said): gemma-4-12B via `input_audio` —
  currently the only small model that accepts audio in chat.
- **Native short-clip video:** Qwen-family VLMs (`Qwen3.5-9B` verified);
  always `enable_thinking: false` for structured output.
- **Frame classification/OCR/constrained JSON:** gemma-4-12B (fast, honest,
  contract-following). Qwen works but needs thinking off.
- **Highlight mining:** structure/insight favors Qwen; quote fidelity favors
  gemma. Ship both, then run `verify_reel.py --fix` and re-extract any
  flagged quote verbatim from the transcript text. Never trust model-written
  files until read back.
