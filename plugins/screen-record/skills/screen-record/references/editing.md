# Editing commands

Bundled commands use `node scripts/screen-record.mjs <command>`.
The evidence recipes below use FFmpeg directly where the helper has no matching
option. Resolve helper paths from the skill directory, not the target workspace.

## Evidence-video standard

### Plan the comparison

Default to labeled BEFORE and AFTER panels when a simultaneous comparison is
useful and readable at the delivered size. If splitting the frame makes the
evidence unreadable, use sequential full-context shots or another clear layout.
An ordinary single-flow demo does not need a comparison.

Use timed callouts and focused outlines to show what to notice and when.
Strongly consider simultaneous magnified detail for small cells or text.
Derive each inset from the same source frame as its context panel. Keep the
full context visible, outline the source region, and label the detail. Do not
zoom routinely or substitute a later, clearer frame. Keep labels and insets
away from controls, results, and other evidence.

Capture the actual feature with synthetic content. Generated footage can test
an edit recipe but cannot prove application behavior. Record the exact source
revision/build, scenario, synthetic inputs, request identity and payload, raw
file identity, and available event receipts. Keep these receipts with the raw
files in the user's workspace. Do not publish private payloads or identifiers.
Keep historical receipts pinned to what was captured. Later code integration
does not make an earlier recording evidence of the integrated build.

### Preserve the operation timeline

Keep playback at real speed and preserve every meaningful operation interval,
including apparent inactivity while work is pending. Trim only irrelevant setup
or idle time outside those intervals. Never hide a failed or misleading result.
Preserve raws and old derivatives. Give each new edit a distinct output path
and retain the commands, filter files, captions, source time ranges, and offsets.
Use FFmpeg's `-n` for direct commands. Do not replace it with `-y`.

Align the first actual request-dispatch cue only when it is observable and
proven to correspond to the request in each recording. Record both source cue
times and the edit offsets. A click, spinner, or completion is not dispatch
proof. Without proof, label the panels `INDEPENDENT CLOCKS` and retain their
own elapsed times. Do not imply a shared start or measured request latency.

Preserve the interval from each operation's start through its verified result.
Do not force completion sync, change playback speed, or remove pending time to
make one side look faster. A video-only observation is not automatically a
latency measurement. State only what the captured cues and receipts establish.

Keep the longer operation visible through completion. If the shorter panel
holds its last frame, display `HELD END FRAME` on that panel for the entire
hold. A hold adds presentation time, not live observation. Visibly label any
reload, distinguish a same-document reload from a fresh scenario, and preserve
the meaningful reload interval. Never use an unlabeled reload to suggest
continuous in-place completion.

### Review the evidence

Pair the recording with independent final-state assertions, such as a model
readback, saved-state inspection, or an independently specified content/structure
check. Record their results and identify what they verify. A screenshot,
narration, or a success-shaped response alone is not an independent assertion.

Inspect raw, intermediate, and final frames at operation starts, partial states,
request cues, reloads, hold boundaries, and each final result. Review motion
through those intervals, not just a thumbnail or FFprobe metadata. Check the
delivered-size readability of panels, detail text, callouts, and outlines.
Reject black frames, private content, and unrelated or obstructing overlays.
Re-capture safely or revise the edit rather than accepting an unreadable or
misleading video. Do not publish rejected media.

This editing standard grants no capture, audio, upload, or OS permission.
Keep the skill's explicit capture/audio approval and managed recording lifecycle.

## Capture options

```text
doctor
devices
start --output raw.mp4 [--fps 30] [--region x,y,width,height]
      [--audio-device "Microphone name"] [--video-input index]
      [--window-id <id>]
status --output raw.mp4 [--recording-id <retained-id>]
stop --output raw.mp4 --recording-id <retained-id> [--timeout 20]
```

Retain the `recordingId` returned by start and use that same ID for stop and
recovery status checks; never adopt a replacement recording's ID. ID-less stop
is supported only for legacy persisted state that genuinely lacks `recordingId`.

Capture setup is intentionally kept in `windows.md`, `macos.md`, and `linux.md`.
`--window-id` is Windows-only; discover IDs with `windows --json`.
Read only the reference matching the current host.

## Inspection and trimming

```text
probe --input raw.mp4
trim --input raw.mp4 --output trimmed.mp4 --start 2.4 --end 38.7
trim --input raw.mp4 --output trimmed.mp4 --start 2.4 --duration 36.3
```

Times accept seconds or `HH:MM:SS.mmm`. Trimming re-encodes for exact cut points.
Add `--copy` only when keyframe-aligned, less accurate cuts are acceptable.

## Side-by-side comparison

```text
side-by-side --left before.mp4 --right after.mp4 --output comparison.mp4
             [--height 720]
```

This simple helper ends at the shorter video and maps only the left audio.
Its output also uses `-shortest`, so short left audio can end it earlier.
It does not add labels, holds, cue alignment, callouts, or detail insets.
Use it only when no meaningful interval will be lost. For unequal evidence
clips, use the full-duration recipe below instead.

## Full-duration comparison recipe

This video-only synthetic example has 1920x1080, 25 fps sources. Both operations
remain visible at original speed. Adapt the dimensions, times, crop regions,
and labels to inspected receipts, not to a desired outcome.

| Receipt | BEFORE | AFTER |
| --- | --- | --- |
| Raw duration | 4.40 s | 7.20 s |
| First proven visible dispatch cue | 2.60 s | 3.40 s |
| Irrelevant leading setup to trim | 0.40 s | 1.20 s |
| Verified operation completion in raw | 4.20 s | 7.00 s |
| Same-document reload in raw | None | 4.20 through 4.60 s |

Here the dispatch cues both appear at 2.20 s after trimming, frame 55 at 25 fps.
The source receipts must prove those are actual dispatch cues. These example
numbers are not defaults. If an earlier meaningful action would be cut, retain
it and choose another layout or a clearly labeled leading gap. Do not turn a
held opening frame into a false live interval.

From the workspace containing the source files, trim to fresh outputs:

```text
ffmpeg -n -i before-raw.mp4 -ss 0.40 -t 4.00 -map 0:v:0 -an -c:v libx264 -crf 18 -pix_fmt yuv420p before-cut.mp4
ffmpeg -n -i after-raw.mp4 -ss 1.20 -t 6.00 -map 0:v:0 -an -c:v libx264 -crf 18 -pix_fmt yuv420p after-cut.mp4
```

Save the following filter graph as `comparison.ffscript` beside the new outputs.
Use a UTF-8 text file rather than shell-specific inline quoting. This example
keeps each full context panel at 960x540 within a 960x1080 column. The marked
480x240 source region appears as a 480x240 inset, twice its context-panel size.
The same-frame detail and source outline appear only from 1 through 3 s.
Use it only when that region needs magnification. Otherwise remove each `split`,
the detail crop/overlay branches, and their source outline/detail labels, and
route the context panel directly to its hold or final label.

```text
[0:v]setpts=PTS-STARTPTS,split=2[lc][ld];
[lc]scale=960:540,pad=960:1080:0:80:color=0x101010,drawtext=text='BEFORE':x=24:y=20:fontsize=32:fontcolor=white,drawbox=x=320:y=260:w=240:h=120:color=yellow:t=3:enable='between(t,1,3)'[lb];
[ld]crop=480:240:640:360,scale=480:240[li];
[lb][li]overlay=x=240:y=720:enable='between(t,1,3)'[lx];
[lx]drawtext=text='SAME-FRAME DETAIL':x=240:y=670:fontsize=24:fontcolor=yellow:enable='between(t,1,3)',tpad=stop_mode=clone:stop_duration=2,drawtext=text='HELD END FRAME':x=24:y=1010:fontsize=28:fontcolor=yellow:enable='gte(t,4)'[left];
[1:v]setpts=PTS-STARTPTS,split=2[rc][rd];
[rc]scale=960:540,pad=960:1080:0:80:color=0x101010,drawtext=text='AFTER':x=24:y=20:fontsize=32:fontcolor=white,drawbox=x=320:y=260:w=240:h=120:color=yellow:t=3:enable='between(t,1,3)'[rb];
[rd]crop=480:240:640:360,scale=480:240[ri];
[rb][ri]overlay=x=240:y=720:enable='between(t,1,3)'[rx];
[rx]drawtext=text='SAME-FRAME DETAIL':x=240:y=670:fontsize=24:fontcolor=yellow:enable='between(t,1,3)',drawtext=text='SAME-DOCUMENT RELOAD':x=24:y=1010:fontsize=28:fontcolor=yellow:enable='between(t,3,3.4)'[right];
[left][right]hstack=inputs=2:shortest=0,drawtext=text='VISIBLE DISPATCH CUES ALIGNED':x=24:y=1048:fontsize=24:fontcolor=white[video]
```

Compose the full six seconds without `-shortest` or an audio-driven cutoff:

```text
ffmpeg -n -i before-cut.mp4 -i after-cut.mp4 -/filter_complex comparison.ffscript -map "[video]" -an -c:v libx264 -crf 18 -pix_fmt yuv420p -movflags +faststart comparison-v1.mp4
```

The hold starts at 4 s, after the BEFORE source ends, not at its completion cue.
AFTER completes at 5.80 s and remains visible through 6 s. There is no forced
completion alignment. Inspect frames immediately before and after the hold
boundary as well as the operation results.

Without dispatch proof, keep each clip's full meaningful source interval,
recalculate panel end/hold times, and replace the alignment claim with
`INDEPENDENT CLOCKS`. After `pad` in each context branch, add
`drawtext=text='elapsed %{pts}':x=24:y=630:fontsize=24:fontcolor=white`.
Keep this clock before any hold so it freezes with the panel's final source
frame. Retain each clock's source offset in the receipt. Do not reuse the example
offsets as guessed alignment.

This recipe intentionally omits audio. If the user wants approved source audio
or narration, select the track explicitly and document its offsets. Pad a short
track with silence to the independently established video duration and cap the
output at that duration. Do not let `-shortest` or a short narration track cut
off a meaningful operation. Keep audio permission and voice-safety requirements.

Use a current FFmpeg with the `-/filter_complex` file-input option. Older builds
may instead support `-filter_complex_script`; that option is removed in FFmpeg 9.
`drawtext` requires text/font support and an available font. Check `ffmpeg -filters`
before rendering. If the default font configuration is unavailable, put a local
font at `review-font.ttf` beside the filter file and change each `drawtext=text=`
to `drawtext=fontfile=review-font.ttf:text=`. Do not distribute the font with the
receipts unless its license permits it. Use FFmpeg-escaped paths for other
`fontfile` locations and the current shell's quoted paths for spaced filenames.

Probe the output with the bundled `probe` command. Extract review frames at
the relevant times, for example:

```text
ffmpeg -n -ss 2.20 -i comparison-v1.mp4 -frames:v 1 review-dispatch.png
ffmpeg -n -ss 3.20 -i comparison-v1.mp4 -frames:v 1 review-reload.png
ffmpeg -n -ss 4.00 -i comparison-v1.mp4 -frames:v 1 review-hold.png
ffmpeg -n -ss 5.80 -i comparison-v1.mp4 -frames:v 1 review-result.png
```

These samples supplement the [review gate](#review-the-evidence). They do not
replace review of intermediate frames and motion or independent state checks.

## Captions

```text
subtitles --input trimmed.mp4 --srt captions.srt --output captioned.mp4
```

Use UTF-8 SubRip:

```srt
1
00:00:01,000 --> 00:00:04,000
Open the command palette.
```

Captions must describe actual visible behavior. Keep lines short and avoid
covering important controls.

## Local narration and dubbing

```text
voices [--engine omlx|sapi|say|flite] [--model name]
narrate --text-file narration.txt --output narration.wav
         [--engine omlx|sapi|say|flite] [--model name] [--voice name]
         [--speed 1] [--language code] [--instructions text]
         [--rate value] [--volume 100]
dub --video captioned.mp4 --audio narration.wav --output final.mp4
dub --video captioned.mp4 --audio narration.wav --output final.mp4 --mix-original
```

Automatic narration first checks `$OMLX_BASE_URL`, defaulting to
`http://127.0.0.1:8000`, and prefers a loaded TTS model. Set `$OMLX_TTS_MODEL`
or pass `--model` to override discovery. OMLX supports `--speed`, `--language`,
and `--instructions`; set `$OMLX_API_KEY` only when required.

If OMLX is unavailable or generation fails, automatic narration falls back to
the platform engine. Read the current host's capture reference for its fallback
engine, voice options, and platform-specific rate or volume behavior. Use
`voices` to list names for the selected engine. All defaults keep narration text
local.

`dub` replaces original audio by default. `--mix-original` lowers the original
track and mixes narration over it; it requires the video to already contain
audio.
