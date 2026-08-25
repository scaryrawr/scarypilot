# Frames & screenshots

Operational details for `sample_frames.py`, `dedupe_frames.py`,
`classify_frames.py`, and `crop_frames.py`.

## Frame extraction policy

Extract frames and classify them as images. Direct `input_video` is experimental
for real screen recordings and has produced hallucinated or degenerate output in
testing; the same moments were reliable as still images. Direct audio input is
also not part of this workflow; use the transcription pipeline instead.

## Use the vision model as a *classifier*, not a captioner

Avoid open-ended prompts ("describe this / is it useful?"). Use:

- Give the model a **short, fixed set of enum categories** relevant to the
  video (e.g. `TERMINAL,SLIDE,BROWSER,DIALOG,TALKING_HEAD,OTHER`).
- Give it **one line of context** about what the recording is.
- Ask for **exactly one label + a brief reason**, nothing else.

This turns the model into a router that can pinpoint a *specific* UI (a diff
view vs a slide vs a browser) across a dense frame sample far more reliably than
you could by eyeballing hundreds of frames. `classify_frames.py` implements
this; pass `--categories` and `--context`.

It also uses **constrained JSON output** (`response_format={"type":
"json_object"}`) and validates the returned label against the enum with Pydantic.
Note: the OMLX endpoint honors JSON *mode* but not strict `json_schema` or
`guided_choice`, so JSON mode + a schema described in the prompt + local
validation is the reliable combination. This eliminates fragile text parsing and
handles reasoning-style models that would otherwise emit label-less prose.

Always include an `OTHER`/`NONE` bucket so junk (blurry, transition,
talking-head, title-only) has somewhere to go.

## The sampling pitfall that cost real time

Scene detection with a **high threshold silently skips content.** A first pass
at `scene>0.3` missed an entire diff/terminal demo because the on-screen change
between frames was gradual. Fixes, in order:

1. **Sample low + periodic.** `sample_frames.py` defaults to `scene>0.06` plus a
   frame every `--every 4` seconds, so static slides (no scene change at all)
   are still captured.
2. **Dedupe, then classify.** Low thresholds produce many near-duplicates
   (scrolls, cursor moves). `dedupe_frames.py` removes consecutive near-dups via
   RMSE so you spend fewer (slower) vision calls:
   `uv run scripts/dedupe_frames.py --frames-dir <sampled-frames-dir> --output-dir <dedup-frames-dir>`.
3. **Targeted re-sampling.** If the transcript says an important demo happens
   around 34–38 min but you have no good frame, re-run `sample_frames.py
   --start 2040 --end 2320 --scene 0.05` on just that window and classify again.

## Timestamps

`sample_frames.py` names frames `t_<MMmSSs>_f<index>.jpg` using the real
`pts_time` parsed from ffmpeg's `showinfo` filter, so filenames are on the video
timeline and line up with transcript timestamps. Use `--start` to keep
timestamps correct when sampling a sub-window (the offset is added back).

## Getting publish-quality images

- **Re-extract at full resolution.** Sampled frames are downscaled for triage.
  Once you know the exact second, pull a crisp frame:
  `uv run scripts/extract_frame.py --input <video> --second <secs> --output <dir>/out.png`.
- **Crop overlays.** Call-shared recordings carry a participant filmstrip (right
  edge) and OS taskbar (bottom). `crop_frames.py --crop 1680x1040+0+0` removes
  both from 1920×1080 frames. Note: if the filmstrip overlaps app content, that
  content is unrecoverable — pick a frame where it does not, or accept the crop.
- **Verify before publishing.** The classifier occasionally mislabels a desktop
  app as "browser/PR". Always eyeball final picks; a contact sheet
  (`magick montage frames/*.jpg -tile 5x -geometry 320x180 sheet.jpg`) makes
  review fast.

## Speed: batch frames, don't fight concurrency

Vision calls on the local OMLX endpoint are dominated by a **large fixed
per-request cost** (~6–8 s) for prompt prefill/warmup. Things that are commonly
assumed but are **false** here, verified against the live endpoint:

- It is **not** a model reload. The model stays resident the whole run
  (`GET /v1/models/status` shows `loaded=true` and flat memory across calls);
  explicitly pre-loading or pinning it does **not** reduce the per-request cost.
- It is **not** caused by the request payload. A bare text-only `max_tokens=1`
  request costs the same as a 12B image request; it is independent of image
  vs. text, token count, `response_format`, and even `max_context_window`.
- Concurrency does **not** help: the server runs one request at a time
  (`scheduler.max_concurrent_requests=1`), so overlapping calls fail with
  **HTTP 409** (`is busy; cannot reload runtime settings variant`). This is why
  `--concurrency` stays at 1; raising it just produces 409s, not speed.

**The one lever that works is `--batch-size`.** Because the fixed cost is
per *request*, put several frames in a single request and pay it once per batch
instead of once per frame. Measured on the local endpoint, 6 frames went from
~6.8 s/frame (one request each) to ~1.9 s/frame batched — roughly a 3.6×
speedup, with labels unchanged. `classify_frames.py` implements this: it sends
the frames in order (`Image 0:`…`Image N-1:`), asks for a JSON array with one
entry per index, validates each label against the enum, and **falls back to
per-frame classification** if a batch reply is malformed or returns too few
entries (so a bad batch never silently drops frames).

Tuning:

- `--batch-size 4` (default) is a safe balance. Larger batches are faster per
  frame but can lose accuracy on dense, visually similar screen frames (the
  model may conflate adjacent images), and one failed request costs the whole
  batch. Raise it (6–8) for easy/distinct frames; drop to 1 for a maximally
  accurate (and slowest) pass.
- Dedupe aggressively first (`uv run scripts/dedupe_frames.py`) so you batch fewer frames.

When even batching makes a large frame set impractical, use the cloud fallback
below.

## Cloud fallback (privacy-gated)

Local OMLX is the **default** and stays the default — data-locality is the whole
point of this skill, and transcription still runs locally. But when the
fixed per-request cost makes classifying a large frame set impractical (hundreds
of frames × ~7 s serialized, even after batching), classification can instead be
fanned out to **cloud vision subagents**, which have no per-request floor and run
in parallel.

**Privacy gate — do not skip.** Cloud classification sends frames off the
machine. Only take this path after the user explicitly consents *for this
recording*, and never for material they've flagged as confidential. If in doubt,
stay local.

How to run it (no bundled script — the orchestrating agent drives it, since a
standalone script can't reach the Copilot model gateway):

1. Fan out `task` subagents on a vision-capable cloud model (e.g.
   `claude-haiku-4.5` or `gpt-5.4-mini`), each given a batch of frame paths.
2. Give each subagent the **same enum + one-line context** contract as the local
   classifier (`build_prompt` in `classify_frames.py`), and require exactly
   `{"file","label","reason"}` per frame, `label` from the fixed enum (else
   `OTHER`/`NONE`).
3. Merge subagent results into the same `manifest.json` shape the script emits
   (`[{"file","ts","label","reason"}]`, `ts` via the `t_<MMmSSs>` filename) and
   copy non-`OTHER`/`NONE` frames into the select dir, exactly as `--select-dir`
   would.

Keep the same "classifier, not captioner" discipline: short enum, one label,
short reason — the cloud path changes *where* inference runs, not the contract.

## Model selection

`classify_frames.py` auto-discovers a model from `/v1/models`. **All Gemma
variants accept image input**, so any of them can classify frames; the larger
Gemma models (26B+) only lack *video/audio* support, which this skill doesn't
use (we send individual extracted frames). The script prefers the efficient
multimodal variants (`12b`/`e4b`/`e2b`), then any other Gemma, then common VLM
ids (`vl`, `vision`, `llava`, `pixtral`, `internvl`). Override with `--model`.
`/v1/models` only lists ids, so if you pass `--model` yourself, confirm it
actually accepts images.

In testing, **gemma-4-12B clearly beat Qwen3.5-9B** for this frame-
classification task: gemma scored 5–6/6 on a labeled set at ~1.2 s/frame with
clean terse labels, while Qwen3.5-9B (a reasoning-style VLM that "thinks out
loud") managed ~2/6, took 9–18 s/frame, and returned label-less prose that
needed extra parsing. Prefer a compact instruct VLM like gemma over a
reasoning VLM for terse, high-volume classification.

**Don't downsize to chase speed on the local endpoint.** Because the fixed
per-request cost dominates (see above), wall-time barely tracks model size:
gemma-4-E4B (~7.2 s/frame) was only marginally faster than
gemma-4-12B (~8.7 s/frame) on the same 24-frame set, yet E4B was clearly less
accurate — it over-fired `AUTOMATIONS_LIST`, invented a `TALKING_HEAD`, and lost
every one of the 6 head-to-head disagreements. Pin the more accurate variant
(12B) locally; the smaller model buys almost no wall-time back. When you truly
need speed at volume, use the cloud fallback above rather than a weaker local
model.
