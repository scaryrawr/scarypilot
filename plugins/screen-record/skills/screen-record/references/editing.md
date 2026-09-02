# Editing commands

All commands use `node scripts/screen-record.mjs <command>`.

## Capture options

```text
doctor
devices
start --output raw.mp4 [--fps 30] [--region x,y,width,height]
      [--audio-device "Microphone name"] [--video-input index]
status --output raw.mp4
stop --output raw.mp4 [--timeout 20]
```

Capture setup is intentionally kept in `windows.md`, `macos.md`, and `linux.md`.
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

The shorter clip determines the output duration. Audio comes from the left clip.

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
