---
name: screen-record
description: >-
  Record agent-driven screen demos and edit video or audio with local FFmpeg.
  Use for screen recording or desktop capture while computer-use tools drive a
  workflow; trimming setup or dead time; putting videos side by side; adding
  captions or subtitles; generating local text-to-speech narration; or mixing
  and dubbing demo audio. Not for transcribing recordings, extracting
  documentation from meetings, or uploading and publishing media.
---

# Screen recording workflow

Keep source recordings and edited outputs in the user's workspace. Never
overwrite a source recording. Prefer the native `screen_record_*` tools for
capture. Run `screen_record_doctor` before the first capture in a session.
If native tools are unavailable, use the bundled CLI from this skill's
directory. Editing and narration remain bundled CLI commands.

Read exactly one capture reference for the current host:

- Windows: `references/windows.md`
- macOS: `references/macos.md`
- Linux: `references/linux.md`

## Prepare

1. Get the intended audience, outcome, approximate length, output path, and
   whether the demo needs microphone audio, captions, narration, or a
   side-by-side layout.
2. Write a concise shot list. Prepare and rehearse the application before
   recording. Silence notifications and remove credentials or private data.
3. Use computer-use tools for application interaction. Do not use shell or
   window-manager focus workarounds during a computer-use workflow.

## Capture

1. Discover inputs with `screen_record_devices` when needed. Device discovery
   can list audio/video inputs and may trigger an OS permission prompt. Never
   grant permissions or bypass OS privacy controls without user approval. On
   Windows, use `screen_record_windows` to choose a visible, non-minimized
   window when the user requests window capture. Pass its `windowId` to
   `screen_record_start`; titles may contain private document names. Window
   discovery does not capture or verify permissions.
2. Start with `screen_record_start` only after the user's explicit capture
   request. Set `output` and `captureApproved: true`. Set `audioDevice` and
   `audioApproved: true` only if the user requests audio. Use `videoInput`,
   `fps`, `region`, or the Windows-only `windowId` only as documented in the
   current host's reference. Keep the returned `recordingId`.
3. Drive the rehearsed shot list. Leave a short pause before the first action,
   after meaningful state changes, and before stopping.
4. Stop gracefully with `screen_record_stop`, passing `output` and
   `recordingId`. After cancellation, timeout, or extension/session restart,
   run `screen_record_status` with the same output and retained `recordingId`
   before retrying. Do not adopt a replacement recording's ID. Detached
   recordings intentionally outlive tool calls and session exit. Stale state
   or interrupted startup requires inspection and user-approved recovery.
   Never kill FFmpeg automatically.
5. Inspect the raw file:
   `node scripts/screen-record.mjs probe --input <raw.mp4>`.

Native diagnostics do not verify screen or microphone permission. A successful
start verifies process liveness, not captured frames or audio. Review the raw
file before editing or reporting success.

For the standalone fallback, use `doctor --capture-only`, `devices`, and
`start --output <raw.mp4>` and retain its returned `recordingId`. Stop with
`stop --output <raw.mp4> --recording-id <retained-id>`. After interruption, use
`status --output <raw.mp4> --recording-id <retained-id>` before retrying; do not
adopt a replacement recording's ID. Omit `--recording-id` from stop only for
legacy state that genuinely has no `recordingId`, not just state in a legacy
directory. Do not replace the managed lifecycle with an unmanaged FFmpeg process.

## Edit

Use `references/editing.md` for command options and subtitle/narration formats.

1. Trim setup and dead time into a new file with `trim`.
2. Use `side-by-side` only when simultaneous comparison adds meaning.
3. Add supplied or user-approved SRT captions with `subtitles`.
4. For narration, draft a short script grounded in visible behavior. Generate
   audio with `narrate`, then combine it with `dub`. `narrate` first checks the
   local OMLX endpoint, then falls back to SAPI on Windows, built-in `say` on
   macOS, or FFmpeg Flite on Linux. Use `voices` before selecting a non-default
   voice. Never clone a person's voice or imply that synthetic narration is a
   real speaker.
5. Probe the final file and preview it with `ffplay <file>` when an interactive
   preview is appropriate. Confirm duration, dimensions, audio presence, and
   that no sensitive content is visible.

Preserve the raw recording, narration text, subtitle source, and final video so
the edit remains reproducible.
