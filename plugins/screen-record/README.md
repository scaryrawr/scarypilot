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
- Windows window capture also requires PowerShell and FFmpeg 7.0 or newer with
  `gdigrab` HWND input support. Full-desktop capture does not require HWND
  support.
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
| `screen_record_windows` | On Windows, list visible, non-minimized, non-cloaked windows for selection. Returns titles, process metadata, and bounds to disambiguate choices; titles may contain private document names. Does not capture, change focus, or verify capture permission. |
| `screen_record_devices` | Bounded device listing, or X11/PulseAudio input guidance on Linux. Discovery can trigger an OS permission prompt. |
| `screen_record_start` | Takes `output`, `captureApproved: true`, and optional `fps`, `videoInput`, `audioDevice`, `region`, or Windows-only `windowId`. A window target cannot be combined with `videoInput` or `region`. Audio requires `audioApproved: true`. |
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

On Windows, call `screen_record_windows` when the user wants a particular
application window. It lists visible, non-minimized, non-cloaked top-level
windows. Select using a returned opaque `windowId`, not its title.
The ID identifies the current window observation and must be rediscovered if
the window closes or its identity changes. Window capture targets the selected
window's client area; odd dimensions are padded by at most one pixel for H.264.
It does not activate or restore the window. Omit `windowId` to keep capturing
the desktop. Desktop `region` coordinates retain
their existing virtual-desktop meaning and cannot be combined with `windowId`.
The list is metadata only and does not verify that FFmpeg can capture every
window or that capture permissions are available.

Recording state lives in a user-scoped temporary directory (UID on Unix, user identity
hash on Windows). On Unix, existing UID-verified same-owner legacy state for that
output remains readable in its original directory. Windows does not automatically
adopt the fixed legacy directory because Node cannot establish its owner here.
Stop existing Windows legacy recordings with their installed pre-upgrade recorder
before upgrading; no recording is killed or state migrated by this update.
Legacy lookup also recognizes the original resolve-based path key for recordings
started through a symlinked parent on Unix; supply that original path to status/stop.
PowerShell candidate probes have a one-second timeout and 16 KiB output bound;
non-missing probe errors are reported before trying the next candidate.

Controller state-write or stop-request-read failures trigger graceful FFmpeg
shutdown before further persistence attempts. If terminal state can be saved, it
reports `failed` even when FFmpeg exits cleanly; if storage remains unavailable,
status may remain `stale`. Inspect the controller log and retained output rather
than assuming a successful recording. No process is force-killed.
The controller keeps its ownership lock until log-close handling and all terminal
state writes finish. Stop waits for ownership release, not just terminal state, so
its successful return includes final cleanup.
If the controller exits with its ownership lock retained, stop reports incomplete
finalization rather than success. Inspect the named lock and log before approved
recovery; stop does not remove abandoned locks. Concurrent normal lock deletion
is treated as ownership release; other lock-read failures remain explicit errors.

Start returns a `recordingId`, output, worker and FFmpeg PIDs, timestamps, and
state/log paths. The worker is detached from the tool and extension. A recording
continues after cancellation, extension reload, or session exit until stopped
or FFmpeg exits. After an interrupted start or stop, query status with the same
output and retained recordingId when available before retrying. Do not adopt a
replacement recording's ID. Stop checks the recording identity so a delayed
call cannot stop a replacement recording.

Stop sends `q` through FFmpeg's stdin and retains the final stopped or failed
state. Repeating a successful stop is safe. A timeout never force-kills the
worker. A failed startup lock write or close releases only the lock file
created by that attempt; replacement ownership is preserved and cleanup errors
are reported. Stale state and interrupted startup locks require inspection and
user-approved recovery, not automatic PID-based killing or deletion.
State writes are atomic, and active workers refresh their state. FFmpeg uses
no-overwrite mode even if another file appears after startup validation.
Worker startup waits for the spawn result before readiness polling. Failures
during stale-artifact cleanup, configuration encoding, or worker spawn report
the original error and release only the startup lock with the same file identity
and recording UUID. Replacement locks are preserved; rollback errors are
reported alongside the original failure.
Successful startup means the FFmpeg process is running, not that the first
frame or requested audio has been verified. Probe and review the resulting file.

The standalone helper remains at
`skills/screen-record/scripts/screen-record.mjs`. From the skill directory,
run `node scripts/screen-record.mjs <command>`. The existing `doctor`, `devices`,
`windows`, `start`, `status`, and `stop` commands remain available. The
`doctor --capture-only`, `devices --json`, and Windows-only `windows --json`
invocations provide the native tools' machine-readable results.
Retain the `recordingId` returned by CLI `start`. CLI `stop` requires
`--recording-id <retained-id>` whenever persisted state has an ID, including
terminal state and state in a legacy directory. Use that same ID with
`status --output <raw.mp4> --recording-id <retained-id>` before retrying after
interruption; do not adopt a replacement recording's ID. Native stop always
requires an ID. Only for legacy persisted state genuinely lacking `recordingId`,
use the standalone CLI's ID-less `stop --output <raw.mp4>`.
Editing, media probing, voices, and narration remain standalone commands.
The extension invokes `node` from `PATH`, not its host's `process.execPath`.
Packaged Copilot hosts can use the Copilot executable as `process.execPath`.

## Extension development

From `extensions/screen-record`, run `npm install`, `npm run build`,
`npm test`, `npm run typecheck`, and `npm run check:bundle`.
Commit generated `dist/` and `bundle-manifest.json` with source changes.
The local bundle check includes the reused CLI, Windows window enumerator, and
SAPI helper in its freshness inputs. Process tests use fixture media
subprocesses and never capture screen or audio. Real capture requires explicit
user approval and OS permission.

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
Persistence-failure tests delay controller cleanup after terminal state
publication and require both fixture media and controller processes to exit
within a bounded wait; terminal state alone is not proof of process exit.
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
