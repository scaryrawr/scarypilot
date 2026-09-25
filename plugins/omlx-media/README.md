# OMLX Media Plugin

Local media generation and processing workflows for GitHub Copilot CLI. The
plugin includes native image and audio tools plus three skills:

| Capability | Purpose |
| --- | --- |
| `omlx_image` tool + `image-gen` skill | Generate PNG images or edit existing images while keeping model discovery, API calls, and file handling out of the prompt workflow. |
| `omlx_speech` and `omlx_transcribe` tools + `audio` skill | Generate speech with a local TTS model or transcribe a local audio file with an STT model through OpenAI-compatible audio REST endpoints. |
| `blogify` skill | Turn video or audio recordings into transcripts, takeaways, selected frames, and grounded written content. |

## Prerequisites

- A current GitHub Copilot CLI release with plugin and skill support.
- [`uv`](https://docs.astral.sh/uv/) and Python for `blogify` and the image skill's legacy direct-install fallback.
- A running OMLX OpenAI-compatible media endpoint. Set `OMLX_BASE_URL` when it
  is not available at `http://127.0.0.1:8000`.
- `ffmpeg`, `ffprobe`, and ImageMagick for the `blogify` video workflow.

Set `OMLX_API_KEY` only when the endpoint requires authentication.

## Installation

Install the skills and native tools as a plugin from the ScaryPilot marketplace:

```sh
copilot plugin marketplace add scaryrawr/scarypilot
copilot plugin install omlx-media@scarypilot
```

Install a skill directly with GitHub CLI. Direct installation of
`image-gen` uses its legacy Python fallback because native extension tools are
available only through plugin installation; the `audio` skill requires the plugin:

```sh
gh skill install scaryrawr/scarypilot plugins/omlx-media/skills/image-gen --scope user
gh skill install scaryrawr/scarypilot plugins/omlx-media/skills/blogify --scope user
```

If either skill was previously installed from `scaryrawr/agentic`, add
`--force` once to replace its source-tracking metadata.

## Usage

Image generation and editing:

- "Generate a square PNG of a watercolor fox and save it in this workspace."
- "Edit this image to replace the background while preserving the subject."

Recording-to-document workflows:

- "Turn this demo recording into a tutorial with a transcript and selected screenshots."
- "Create release notes from this meeting recording and keep the supporting artifacts."

Standalone audio workflows:

- "Speak this paragraph using a loaded OMLX TTS model and save it as a WAV file."
- "Transcribe this local audio clip with OMLX and save the transcript."

Both skills keep inputs and outputs in the user's workspace. Plugin-based image
generation uses the native `omlx_image` tool, which discovers a capable model,
authenticates with `OMLX_API_KEY` when set, and saves fresh results without
returning image bytes to the model. `blogify` uses local models by default;
sending frames to a cloud model requires explicit user consent.

`omlx_speech` calls `POST /v1/audio/speech` and saves binary audio (WAV by
default; MP3, Opus, FLAC, and PCM are also supported by current OMLX releases).
`omlx_transcribe` uploads a local audio file to `POST /v1/audio/transcriptions`
and saves the returned text as a `.txt` file. Both prefer a loaded model of the
appropriate `audio_tts` or `audio_stt` type from `/v1/models/status`, then fall
back to an installed model that OMLX loads on demand. A specified model takes
priority. Use absolute paths for inputs/outputs; outputs must be
new files. The audio tools handle complete requests, not realtime WebSocket
transcription or streamed speech playback. For long recordings that need chunk
timestamps and silence detection, use `blogify` instead.

## Development

In `plugins/omlx-media/extensions/omlx-media`, install dependencies and run
`npm run build`, `npm run typecheck`, and `npm test` after changes. Commit the
generated `dist/` and `bundle-manifest.json`. Installed plugins use that bundle
without requiring `npm install`; Copilot supplies the SDK at runtime.

## Resources

- [OMLX repository](https://github.com/jundot/omlx)
- [FFmpeg documentation](https://ffmpeg.org/documentation.html)
- [ImageMagick documentation](https://imagemagick.org/script/command-line-processing.php)
- [Agent Skills specification](https://agentskills.io/specification)
