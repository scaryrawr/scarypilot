# Windows capture

The managed recorder uses FFmpeg `gdigrab` for the screen and DirectShow
(`dshow`) for optional audio.

## Preflight

Run:

```text
node scripts/screen-record.mjs doctor
node scripts/screen-record.mjs devices
node scripts/screen-record.mjs windows --json
```

`devices` prints DirectShow device names. Copy an audio device name exactly.
`windows --json` lists visible, non-minimized, non-cloaked top-level windows,
their titles, process names, outer bounds, client sizes, and opaque selection
IDs. Titles may contain private document names. Window discovery does not
capture or change focus.

Selected-window capture requires PowerShell and FFmpeg 7.0 or newer with
`gdigrab` HWND input support. The probe uses an invalid handle and does not
capture a window. Windows may prompt for microphone privacy permission when
listing DirectShow audio devices or starting audio capture; window discovery
does not verify screen/audio permissions.

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

Capture a selected window:

```text
node scripts/screen-record.mjs windows --json
node scripts/screen-record.mjs start --output raw.mp4 --window-id <windowId>
```

Use an ID from the current window listing. IDs are ephemeral; rediscover if a
window closes or its title/process identity changes. Capture targets the
window's client area, not its title bar. Odd dimensions are padded by at most
one pixel for H.264. Capture does not activate or restore the window.
`--window-id` cannot be combined with `--region` or `--video-input`. If a
selected window becomes stale or unavailable, capture fails rather than falling
back to the desktop.

Window lifecycle is not monitored after recording starts. Closing, minimizing,
or resizing the target may end or degrade the capture; probe and review the
recording. The opaque ID is not a permission grant.

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
