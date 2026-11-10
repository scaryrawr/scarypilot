---
name: kokoro
description: >-
  Set up and use local Kokoro ONNX neural text-to-speech, generate WAV narration
  from text or scripts, and diagnose Kokoro dependencies or Windows ARM64 runtime
  support. Use for Kokoro setup, offline speech synthesis, demo voiceovers with
  Kokoro, and checking Kokoro CPU versus GPU/NPU claims. Not for transcription,
  voice cloning, cloud speech services, generic ONNX model deployment, or screen
  capture itself.
---

# Local Kokoro speech

1. Determine whether the user needs setup, synthesis, or diagnosis. Identify the
   host architecture, intended text, model and voice paths, and a new output path.
   Do not present synthetic model voices as a real person's recording.
2. Read [setup and platform notes](references/setup.md). Check `uv --version`
   before Python work. Respect the target project's environment and dependency
   conventions. Obtain required permission for downloads, installations, and
   environment synchronization. If uv is absent, report it; do not install it
   or substitute bare pip automatically.
3. Resolve `scripts/kokoro.py` relative to this skill's installed directory.
   Keep the target workspace as the working directory. Reuse user-approved
   local assets; never commit weights or replace the user's model files.
   The helper makes no automatic downloads or remote inference calls.
4. Run `doctor` in the environment you will use for synthesis. Report the
   interpreter architecture and available runtime providers. A listed provider
   does not prove that inference uses it or measure its performance.
   The helper selects the CPU provider. Do not claim GPU or NPU use or
   compatibility with every ARM64 machine. Distinguish prior results from checks
   you ran on the current host.
5. For synthesis, use the bundled `synthesize` command with explicit `--model`,
   `--voices`, and `--output`, plus exactly one of `--text` and `--text-file`.
   Start with `--voice af_heart --lang en-us --speed 1.0` unless the user chooses
   otherwise. Check the upstream voice inventory before using other voice and
   language combinations. Keep speed within 0.5-2.0. The output directory must
   exist. The helper refuses existing files and symlinks.
6. For narration, describe the demonstrated behavior, expand
   ambiguous abbreviations, and split long scripts into short sections with
   distinct filenames. Preserve the text and prior clips. Do not assume SSML,
   word timestamps, automatic video alignment, or streaming in this helper.
7. After a successful run, report the WAV path and measured duration.
   Listen only when appropriate and permitted. Check pronunciation and pacing
   before publishing. Do not claim you listened or ran inference if you did not.
   Report errors and checks you did not run. Do not silently use a cloud
   service, alternate index, disabled TLS, or another voice engine.

To run the helper in PowerShell, replace the paths in this example:

```powershell
uv run --no-project --with kokoro-onnx --with espeakng-loader python "C:\path\to\skills\kokoro\scripts\kokoro.py" synthesize --model "C:\models\kokoro-v1.0.onnx" --voices "C:\models\voices-v1.0.bin" --text-file "C:\audio\narration.txt" --output "C:\audio\narration-01.wav"
```

In a uv project with the dependencies already declared, use
`uv run python "<absolute-helper-path>" ...`; temporary dependencies use
`uv run --with kokoro-onnx --with espeakng-loader python ...`.
Use `uv add` only for an intentional project dependency change. For an existing
virtual environment use `uv pip install`, never `--system` by default.
Use `uvx` for independent tools. Do not assume its environment contains project
packages. Never replace existing pipx installations without permission.

For dubbing, use the screen-record plugin's documented editing workflow if
installed. This skill generates the WAV only. It does not authorize capture,
microphone access, audio playback, uploads, or external posts. When posting
agent-authored descriptions externally, append `- Generated with AI 🤖` once at
the end; do not append it to the user's supplied narration text.
