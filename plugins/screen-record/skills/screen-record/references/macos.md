# macOS capture

The managed recorder uses FFmpeg `avfoundation`.

## Preflight

Grant Screen Recording permission to the terminal or Copilot host in **System
Settings > Privacy & Security > Screen Recording**. Grant microphone permission
only when audio is requested, then restart the affected host if macOS requires
it.

List AVFoundation screen and audio indices:

```text
node scripts/screen-record.mjs doctor
node scripts/screen-record.mjs devices
```

## Capture

An explicit screen index is required:

```text
node scripts/screen-record.mjs start --output raw.mp4 --video-input 2
```

Add an audio index from the same device list:

```text
node scripts/screen-record.mjs start --output raw.mp4 \
  --video-input 2 --audio-device 0
```

Crop a region after capture:

```text
node scripts/screen-record.mjs start --output raw.mp4 \
  --video-input 2 --region 100,80,1280,720
```

The region is `x,y,width,height` in the selected screen's coordinates. Keep
width and height even for H.264 output. Device indices can change when displays
or audio hardware are connected, so list them again before relying on a saved
command.

Reference: [FFmpeg `avfoundation` device](https://ffmpeg.org/ffmpeg-devices.html#avfoundation).
