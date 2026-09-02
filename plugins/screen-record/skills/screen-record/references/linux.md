# Linux capture

The managed recorder uses FFmpeg `x11grab` for video and PulseAudio for optional
audio. It requires an X11 display. Native Wayland/PipeWire portal capture is not
currently managed by this helper; use an X11 session rather than improvising an
unsafe fallback.

## Preflight

Run:

```text
node scripts/screen-record.mjs doctor
node scripts/screen-record.mjs devices
```

`devices` reports the current `$DISPLAY`. To discover PulseAudio source names,
use the host's normal audio tooling, such as `pactl list short sources`, when it
is already installed.

## Capture

Capture the current X11 display:

```text
node scripts/screen-record.mjs start --output raw.mp4
```

Override the X11 display or capture a region:

```text
node scripts/screen-record.mjs start --output raw.mp4 \
  --video-input :0.0 --region 100,80,1280,720
```

Capture the default PulseAudio source:

```text
node scripts/screen-record.mjs start --output raw.mp4 \
  --audio-device default
```

The region is `x,y,width,height`. Keep width and height even for H.264 output.
For system audio, select the monitor source corresponding to the desired sink;
for microphone audio, select the microphone source.

## Narration

Narration first checks the local OMLX endpoint at `$OMLX_BASE_URL`, defaulting
to `http://127.0.0.1:8000`. It discovers a TTS model automatically, preferring
one that is already loaded. Set `$OMLX_TTS_MODEL` to choose a specific model.
If OMLX is unavailable or generation fails, Linux falls back to FFmpeg Flite:

```text
node scripts/screen-record.mjs voices
node scripts/screen-record.mjs narrate --text-file narration.txt \
  --output narration.wav
```

Use `--engine flite` to select Flite explicitly. Flite requires an FFmpeg build
that includes the optional `flite` filter. It accepts `--voice`, but not
`--rate` or `--volume`. Narration remains local.

Reference: [FFmpeg `x11grab` and PulseAudio devices](https://ffmpeg.org/ffmpeg-devices.html).
