# Kokoro local speech

A skill and Python helper for local neural text-to-speech with
[`kokoro-onnx`](https://github.com/thewh1teagle/kokoro-onnx). Generate spoken
explanations, accessibility readouts, and demo narration as mono PCM16 WAV files.
It needs no server, API key, Copilot extension host, or cloud speech service.
It uses synthetic model voices and does not clone real speakers.

## Install

```sh
copilot plugin install kokoro@scarypilot
```

Requires uv, a compatible Python interpreter, and wheels for `kokoro-onnx`,
`onnxruntime`, NumPy, and `espeakng-loader`. Check `uv --version` first. Initial
package and model downloads need network access and disk space. Inference uses
local files. Obtain permission for installation or downloads when required.
Do not change an existing project's dependencies just to run this helper.

## Setup and first clip

Read [setup and platform notes](skills/kokoro/references/setup.md) for asset
downloads, environment choices, Windows ARM64 evidence, and troubleshooting.
Keep models and outputs outside the installed plugin and Git checkout.

Find `scripts/kokoro.py` in the installed skill directory. Replace the quoted
absolute paths below with the helper, model, voice, and output paths on your
machine. Do not copy the helper into the target project.

```powershell
uv --version
uv run --no-project --with kokoro-onnx --with espeakng-loader python "C:\path\to\skills\kokoro\scripts\kokoro.py" doctor
uv run --no-project --with kokoro-onnx --with espeakng-loader python "C:\path\to\skills\kokoro\scripts\kokoro.py" synthesize --model "C:\models\kokoro-v1.0.onnx" --voices "C:\models\voices-v1.0.bin" --text "A local voice, without a speech service." --voice af_heart --lang en-us --speed 1.03 --output "C:\audio\intro.wav"
```

The helper does not download assets, create output directories, play audio,
upload content, or overwrite existing files. `doctor` reports interpreter and
installed runtime information. Available providers do not prove which provider
ran a model. Synthesis selects `CPUExecutionProvider` and passes the session to
Kokoro. The helper does not use an accelerator.
Success prints the output path, sample rate, frame count, duration, and session
providers. Session providers alone do not prove accelerator execution coverage.

For private or longer input, use `--text-file "C:\audio\intro.txt"` instead of
`--text`. The helper treats UTF-8 input as plain text, not Markdown or SSML.
Generate short sections into separate files, check pronunciation and pacing,
and keep the scripts alongside the audio. Use the resulting WAV with the
screen-record plugin's documented dubbing workflow. Generating speech does not
authorize recording, microphone capture, publishing, or replacing video audio.

Example requests:

- "Set up Kokoro locally on this Windows ARM64 machine."
- "Use Kokoro to narrate this approved demo script into a new WAV."
- "Explain whether this Kokoro setup really uses the NPU."

## Development

Run dependency-free helper tests with
`uv run --no-project python -m unittest discover -s plugins\kokoro\tests -v`.
These tests do not run inference or evaluate voice quality or hardware acceleration.
Behavioral task and trigger cases live under `skills/kokoro/evals/`; model-backed
evals require separate model and spending approval.

The bundled helper also generated a WAV using the CPU on Windows ARM64 on
2026-11-10; [the setup reference](skills/kokoro/references/setup.md#windows-arm64-what-is-known)
records the tested versions and evidence limits. Standard PyPI access on that
host failed with a TLS handshake error; validation reused an existing cached
environment, not a clean online install.

## Resources and attribution

- [kokoro-onnx implementation and examples (MIT)](https://github.com/thewh1teagle/kokoro-onnx)
- [Upstream model-file release](https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.1)
- [Kokoro-82M model card (Apache-2.0)](https://huggingface.co/hexgrad/Kokoro-82M)
- [Voice and language inventory](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md)
- [ONNX Runtime execution providers](https://onnxruntime.ai/docs/execution-providers/)
- [uv documentation](https://docs.astral.sh/uv/)

The helper uses the public `kokoro-onnx` API. No model weights, voice data,
upstream source, or speech-engine binaries ship with this plugin. Review the
upstream package, model, voice, and eSpeak NG license terms before redistribution;
this plugin does not relicense those assets.
