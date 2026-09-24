---
name: audio
description: Use this skill for local OMLX text-to-speech generation or speech-to-text transcription of an audio file. Saves speech audio or a plain-text transcript. Not for realtime microphone streaming or long-form video-to-document workflows.
allowed-tools: omlx_speech omlx_transcribe
---

# OMLX Audio

Use the plugin's native tools for OpenAI-compatible audio REST requests:

1. For text to speech, call `omlx_speech` with the text in `input` and a new absolute `.wav` `output` path. Optionally specify `model`, `voice`, `language`, `speed`, or `instructions`. To save another format, set `response_format` and use the matching `.mp3`, `.opus`, `.flac`, or `.pcm` extension. Voice names depend on the loaded model; do not assume a voice is available.
2. For speech to text, call `omlx_transcribe` with an existing absolute audio `input` path and a new absolute `.txt` `output` path. Optionally specify `model`, `language`, or a vocabulary `prompt`. The transcript is saved and returned as text.
3. Let the tools prefer a loaded audio model and otherwise select an installed model that OMLX loads on demand, unless the user names one. Report the chosen model and saved file path. Keep files in the user's workspace.

For a long recording requiring silence-aware chunking and approximate timestamps, use the `blogify` skill instead. Realtime WebSocket ASR and streamed playback are not supported by these tools.
