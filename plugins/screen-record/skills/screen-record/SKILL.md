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
overwrite a source recording. Run `node scripts/screen-record.mjs doctor` before
the first capture in a session.

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

1. Discover inputs when needed:
   `node scripts/screen-record.mjs devices`.
2. Start a managed recording:
   `node scripts/screen-record.mjs start --output <raw.mp4>`.
   Add platform-specific input options only as documented in the current host's
   reference.
3. Drive the rehearsed shot list. Leave a short pause before the first action,
   after meaningful state changes, and before stopping.
4. Stop gracefully:
   `node scripts/screen-record.mjs stop --output <raw.mp4>`.
   If interrupted, run `status --output <raw.mp4>` before attempting another
   recording. Do not kill FFmpeg unless graceful stop has failed and the user
   approves recovery.
5. Inspect the raw file:
   `node scripts/screen-record.mjs probe --input <raw.mp4>`.

## Edit

Use `references/editing.md` for command options and subtitle/narration formats.

1. Trim setup and dead time into a new file with `trim`.
2. Use `side-by-side` only when simultaneous comparison adds meaning.
3. Add supplied or user-approved SRT captions with `subtitles`.
4. For narration, draft a short script grounded in visible behavior. Generate
   audio with `narrate`, then combine it with `dub`. On Windows, `narrate`
   defaults to local SAPI; elsewhere it defaults to FFmpeg Flite. Use `voices`
   before selecting a non-default voice. Never clone a person's voice or imply
   that synthetic narration is a real speaker.
5. Probe the final file and preview it with `ffplay <file>` when an interactive
   preview is appropriate. Confirm duration, dimensions, audio presence, and
   that no sensitive content is visible.

Preserve the raw recording, narration text, subtitle source, and final video so
the edit remains reproducible.
