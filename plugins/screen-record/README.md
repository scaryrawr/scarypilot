# Screen Record Plugin

Create polished product demos by combining agent-driven computer use with local
FFmpeg screen capture and editing. The plugin includes:

| Capability | Purpose |
| --- | --- |
| `screen-record` skill | Plan, capture, inspect, trim, caption, narrate, and compose demo videos. |
| `demo-producer` agent | Drive a rehearsed demo from capture through final review. |
| Native recording tools | Check capture dependencies, discover inputs, and start, inspect, or gracefully stop a detached recording. |

## Prerequisites

- A current GitHub Copilot CLI release with plugin, skill, and native extension support.
- Node.js 22.18 or newer on `PATH` for the native tools. The standalone CLI supports Node.js 20 or newer.
- `ffmpeg` and `ffprobe` on `PATH`.
- Windows screen capture uses FFmpeg's `gdigrab`; microphone capture uses
  `dshow`. Linux uses `x11grab` and PulseAudio. macOS uses `avfoundation` and
  requires an explicit screen device index.
- Narration first checks a local OMLX endpoint from `OMLX_BASE_URL`, defaulting
  to `http://127.0.0.1:8000`. Set `OMLX_TTS_MODEL` to override automatic model
  discovery. Fallbacks use SAPI on Windows, built-in `say` on macOS, and
  FFmpeg's `flite` filter on Linux.

Screen and microphone capture may require operating-system privacy permission.
The plugin does not upload recordings or narration.

This plugin uses Copilot's legacy manifest format because native extension paths
are legacy component fields. Agent Plugins 1.0 uses `extensions` for namespace
metadata, not executable extension paths. Omitting its canonical `$schema`
keeps the recording tools and existing agent paths discoverable.

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

## Recording tools

Prefer these tools for capture. Keep shot planning, rehearsal, application
interaction, privacy review, and editing in the skill.

| Tool | Contract |
| --- | --- |
| `screen_record_doctor` | Bounded local FFmpeg and FFprobe checks. No narration discovery or network request. |
| `screen_record_devices` | Bounded device listing, or X11/PulseAudio input guidance on Linux. Discovery can trigger an OS permission prompt. |
| `screen_record_start` | Takes `output`, `captureApproved: true`, and optional `fps`, `videoInput`, `audioDevice`, and `region`. Audio requires `audioApproved: true`. |
| `screen_record_status` | Takes `output` and an optional `recordingId`. Reports recording, stopping, stopped, failed, stale, or not-recording state. |
| `screen_record_stop` | Takes `output` and the returned `recordingId`. Requests graceful stop with an optional `timeoutSeconds`, at most 120. |

`captureApproved` and `audioApproved` attest to the user's explicit request.
They do not grant privacy permissions. Neither diagnostics nor device discovery
proves that capture is allowed. Do not bypass OS prompts or privacy controls.

Choose an output inside the current workspace. The native tools reject parent
directory and symlink escapes, including dangling output leaf symlinks. They
pass validated canonical paths to the recorder so in-workspace aliases share
recording identity. Windows lifecycle keys conservatively ignore path casing,
including before the output exists, so `Raw.mp4` and `raw.mp4` cannot claim
separate locks. Case-distinct files in an explicitly case-sensitive Windows
directory also share a lifecycle key; use distinct names rather than casing
alone. Stop recordings started with earlier pre-release Windows lifecycle
keys before upgrading this increment; it does not migrate their persisted state.
`region` contains integer `x`, `y`, `width`, and
`height` fields. Width and height must be positive even numbers. On macOS,
`videoInput` is the explicit AVFoundation screen index, and region offsets
cannot be negative. Device indices can change between captures.

Start returns a `recordingId`, output, worker and FFmpeg PIDs, timestamps, and
state/log paths. The worker is detached from the tool and extension. A recording
continues after cancellation, extension reload, or session exit until stopped
or FFmpeg exits. After an interrupted start or stop, query status with the same
output before retrying. Stop checks the recording identity so a delayed call
cannot stop a replacement recording.

Stop sends `q` through FFmpeg's stdin and retains the final stopped or failed
state. Repeating a successful stop is safe. A timeout never force-kills the
worker. Stale state and interrupted startup locks require inspection and
user-approved recovery, not automatic PID-based killing or deletion.
State writes are atomic, and active workers refresh their state. FFmpeg uses
no-overwrite mode even if another file appears after startup validation.
Worker startup waits for the spawn result before readiness polling. A confirmed
spawn failure reports the original error and releases only its own startup lock.
Successful startup means the FFmpeg process is running, not that the first
frame or requested audio has been verified. Probe and review the resulting file.

The standalone helper remains at
`skills/screen-record/scripts/screen-record.mjs`. From the skill directory,
run `node scripts/screen-record.mjs <command>`. The existing `doctor`, `devices`,
`start`, `status`, and `stop` commands remain available. `doctor --capture-only`
and `devices --json` provide the native tools' machine-readable results.
CLI `status` and `stop` also accept `--recording-id`. Native stop requires an ID;
for a legacy recording without one, use the standalone CLI's graceful stop.
Editing, media probing, voices, and narration remain standalone commands.
The extension invokes `node` from `PATH`, not its host's `process.execPath`.
Packaged Copilot hosts can use the Copilot executable as `process.execPath`.

## Extension development

From `extensions/screen-record`, run `npm install`, `npm run build`,
`npm test`, `npm run typecheck`, and `npm run check:bundle`.
Commit generated `dist/` and `bundle-manifest.json` with source changes.
The local bundle check includes the reused CLI and SAPI helper in its freshness
inputs. Process tests use fixture media subprocesses and never capture screen
or audio. Real capture requires explicit user approval and OS permission.

The dedicated [screen recording CI workflow](../../.github/workflows/screen-record-ci.yml)
runs the capture-free contract suite on Ubuntu, macOS, and Windows with pinned
Node.js 22.18.0. It checks locked dependencies, types, shipped helper-aware bundle
freshness, rebuilds, and reproducible generated artifacts. Pull requests and
pushes touching this plugin or its workflow trigger the matrix. Manual dispatch
is also available. The workflow token is read-only.

The suite starts the real native tool adapter, CLI, and detached worker.
A test-only Node preload replaces only FFmpeg/FFprobe execution with real Node
subprocesses that return deterministic device listings, media output, and exit
codes. The preload is inherited by worker processes. No FFmpeg installation,
display, microphone, PowerShell, or Unix executable wrapper is required.
All hosts run lifecycle, cancellation, timeout, identity, lock, stale-state,
source safety, and failure regression cases without blanket platform skips.
`npm test` fails if the suite skips or cancels any test and caps the whole
subprocess run at two minutes. It uses an explicit test path, not shell globbing.
Platform-specific argument assertions cover AVFoundation, X11/PulseAudio, and
GDI/DirectShow on their respective hosts. Symlink tests require file-symlink
privileges on Windows and fail explicitly if the runner lacks them.

These tests validate process contracts, not actual AVFoundation, X11, or Windows
capture, codec behavior, OS privacy grants, or real video/audio finalization.
Native capture still requires an explicitly approved smoke test on each OS.

## Resources

- [FFmpeg documentation](https://ffmpeg.org/documentation.html)
- [FFmpeg devices](https://ffmpeg.org/ffmpeg-devices.html)
- [FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html)
- [Agent Skills specification](https://agentskills.io/specification)
