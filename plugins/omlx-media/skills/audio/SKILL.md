---
name: audio
description: Use this skill for local OMLX text-to-speech generation or speech-to-text transcription of an audio file. Saves speech audio or a plain-text transcript. Not for realtime microphone streaming or long-form video-to-document workflows.
---

# OMLX Audio

Choose capabilities through [the shared media actions](../../references/actions.md).
Discover a native capability by its advertised action description. If none is
available, use the bundled CLI operation with the same arguments.

1. Generate speech with the text in `input` and a new absolute `.wav` `output` path. The CLI operation is `speech`. Optionally specify `model`, `voice`, `language`, `speed`, or `instructions`. To save another format, set `response_format` and use the matching `.mp3`, `.opus`, `.flac`, or `.pcm` extension. Voice names depend on the loaded model; do not assume a voice is available. Never impersonate a real speaker.
2. Transcribe audio with an existing absolute audio `input` path and a new absolute `.txt` `output` path. The CLI operation is `transcribe`. Optionally specify `model`, `language`, or a vocabulary `prompt`. The transcript is saved and returned as text.
3. Let the tools prefer a loaded audio model and otherwise select an installed model that OMLX loads on demand, unless the user names one. Report the chosen model and saved file path. Keep files in the user's workspace.

For a recording requiring chunk offsets, frame preparation, or written content,
use the `blogify` skill. It uses the recording preparation action
with a fresh `output_dir` instead of `output`. Silence-aware chunking remains an
optional legacy script workflow. Realtime WebSocket ASR and streamed playback
are not supported by these tools.
