# Screen Record Plugin

Create polished product demos by combining agent-driven computer use with local
FFmpeg screen capture and editing. The plugin includes:

| Capability | Purpose |
| --- | --- |
| `screen-record` skill | Plan, capture, inspect, trim, caption, narrate, and compose demo videos. |
| `demo-producer` agent | Drive a rehearsed demo from capture through final review. |

## Prerequisites

- A current GitHub Copilot CLI release with plugin and skill support.
- Node.js 20 or newer.
- `ffmpeg` and `ffprobe` on `PATH`.
- Windows screen capture uses FFmpeg's `gdigrab`; microphone capture uses
  `dshow`. Linux uses `x11grab` and PulseAudio. macOS uses `avfoundation` and
  requires an explicit screen device index.
- Windows narration uses installed SAPI voices by default. Other platforms
  require an FFmpeg build with the `flite` filter.

Screen and microphone capture may require operating-system privacy permission.
The plugin does not upload recordings or narration.

The skill keeps its core workflow platform-neutral and loads only the relevant
capture reference for Windows, macOS, or Linux. Linux capture currently targets
X11; native Wayland portal capture is not yet managed.

## Installation

```sh
copilot plugin marketplace add scaryrawr/scarypilot
copilot plugin install screen-record@scarypilot
```

## Usage

- "Record a demo of this flow, drive it with computer use, and trim the setup."
- "Put these two demo clips side by side and add the supplied captions."
- "Narrate this demo with Microsoft Mark and replace the original audio."
- Run the `demo-producer` agent for an end-to-end, rehearsed recording.

The skill writes recordings and edits only to paths chosen in the user's
workspace. Recording state and FFmpeg logs are kept in the operating system's
temporary directory.

## Resources

- [FFmpeg documentation](https://ffmpeg.org/documentation.html)
- [FFmpeg devices](https://ffmpeg.org/ffmpeg-devices.html)
- [FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html)
- [Agent Skills specification](https://agentskills.io/specification)
