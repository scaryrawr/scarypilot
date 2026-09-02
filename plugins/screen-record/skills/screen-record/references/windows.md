# Windows capture

The managed recorder uses FFmpeg `gdigrab` for the screen and DirectShow
(`dshow`) for optional audio.

## Preflight

Run:

```text
node scripts/screen-record.mjs doctor
node scripts/screen-record.mjs devices
```

`devices` prints DirectShow device names. Copy an audio device name exactly.
Windows may prompt for microphone privacy permission. `gdigrab` does not require
a camera device.

## Capture

Capture the full virtual desktop:

```text
node scripts/screen-record.mjs start --output raw.mp4
```

Capture a region:

```text
node scripts/screen-record.mjs start --output raw.mp4 --region 100,80,1280,720
```

Capture a microphone:

```text
node scripts/screen-record.mjs start --output raw.mp4 \
  --audio-device "Microphone (device name)"
```

The region is `x,y,width,height` in virtual-desktop coordinates. Keep width and
height even for H.264 output. A negative x-coordinate can address a monitor to
the left of the primary display.

DirectShow audio captures the named input. Desktop/system audio requires a
loopback device exposed by the installed audio driver; do not assume one exists.

## Narration

Narration first checks the local OMLX endpoint. When OMLX is unavailable,
Windows falls back to installed SAPI voices:

```text
node scripts/screen-record.mjs voices
node scripts/screen-record.mjs narrate --text-file narration.txt \
  --output narration.wav --voice "Microsoft Mark" --rate 1
```

Use `--engine sapi` to select SAPI explicitly. The system default voice is used
when `--voice` is omitted. SAPI narration is local and does not send text to a
service.

Reference: [FFmpeg `gdigrab` and `dshow` devices](https://ffmpeg.org/ffmpeg-devices.html).
