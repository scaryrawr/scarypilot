# Setup and platform evidence

## Choose the environment

Check `uv --version`. Follow project instructions and obtain required
permissions. `uv run` may synchronize an environment, and uv can download
interpreters or packages. Do not add a uv project inside the installed plugin.

| Context | Command prefix |
| --- | --- |
| Existing uv project with speech dependencies | `uv run python` |
| Temporary speech dependencies in a project | `uv run --with kokoro-onnx --with espeakng-loader python` |
| Standalone helper | `uv run --no-project --with kokoro-onnx --with espeakng-loader python` |
| Intentional project dependency addition | `uv add kokoro-onnx espeakng-loader` |

`kokoro-onnx` brings NumPy and ONNX Runtime dependencies. `espeakng-loader`
supplies the phonemizer's native speech-engine dependency on supported hosts.
Wheel support is specific to Python version, OS, and architecture. Do not assume
an x64 wheel works in native ARM64 Python. Missing wheels may need a supported
interpreter or an approved source build. Do not download DLLs from untrusted sources.

## Acquire model and voice assets

With permission, download both upstream assets into a user-chosen model
directory, outside Git and the plugin installation:

- [kokoro-v1.0.onnx](https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/kokoro-v1.0.onnx)
- [voices-v1.0.bin](https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/voices-v1.0.bin)

Use the paired files from that release. A release URL is a source reference,
not a checksum verification. Preserve existing files; download into new paths
and check any publisher-provided integrity information before loading. Native
libraries read these files, so use only trusted model and voice files.
Do not load arbitrary attachments or untrusted replacements. The plugin does
not bundle assets.

Run `scripts/kokoro.py doctor` with the selected command prefix, then generate a
short clip using the README example. All helper paths are relative to the
installed skill directory, not the target repository. Use shell-appropriate
absolute paths. Quote Windows paths in PowerShell. Use native paths and quoting
on POSIX hosts.

## Windows ARM64: what is known

A local run reported on 2026-11-10 synthesized multiple 24000 Hz mono clips on
Windows ARM64. It used Python 3.13.17 ARM64, uv 0.13.7, and `kokoro-onnx` with
NumPy, ONNX Runtime, and `espeakng-loader`. The script called:

```python
from kokoro_onnx import Kokoro

tts = Kokoro(model_path, voices_path)
samples, sample_rate = tts.create(
    text, voice="af_heart", speed=1.03, lang="en-us"
)
```

That report describes CPU inference, not a run of the bundled helper or a
benchmark. It does not establish support for every ARM64 machine or package
release. The report did not retain exact package versions or an active-provider
trace.

The bundled helper then generated a WAV on 2026-11-10 with native ARM64
Python 3.13.17, uv 0.13.7, `kokoro-onnx` 0.6.1, NumPy 2.4.4,
ONNX Runtime 1.31.1, and `espeakng-loader` 0.2.4. It generated a 24000 Hz
mono PCM16 WAV with `af_heart`, `en-us`, speed 1.03, and only
`CPUExecutionProvider` configured. The test reused the existing model pair and
cached environment without package changes. A clean standard-PyPI setup attempt
failed with a TLS handshake error, so clean online installation remains
unverified. The check covered the audio file structure, not listening quality
or other voices.

| Capability | Evidence boundary |
| --- | --- |
| Local synthesis on native Windows ARM64 Python | Previously successful with the above stack and paired assets. Recheck installed wheels on the current host. |
| WAV conversion | The helper writes mono PCM16 using the returned sample rate, clipping finite floats to [-1, 1]. |
| CPU performance / real-time speed | No timing baseline is available. Measure clip duration and synthesis wall time before making a claim. |
| DirectML / GPU | Not verified for this model, Python stack, or host. An ONNX model alone does not establish support. |
| Qualcomm QNN / NPU | Not verified. Hardware presence or a listed provider does not prove model execution on it. |
| Other OS/architectures or voice/language pairs | Depend on upstream assets and native dependencies; not established by the Windows result. |

`doctor` prints available execution providers from the installed ONNX
Runtime. It does not create an inference session or prove a provider was used.
The helper constructs an ONNX Runtime session explicitly with
`providers=["CPUExecutionProvider"]` and passes it through `Kokoro.from_session`.
It reports configured providers after synthesis but does not let callers change
them. It ignores upstream's automatic accelerator selection and `ONNX_PROVIDER`
override. Listing a provider in a separate experiment would not prove which
model operations ran on that accelerator.
To investigate acceleration, first record a reproducible CPU baseline.
Then consult the upstream
[execution-provider documentation](https://onnxruntime.ai/docs/execution-providers/).
Before claiming GPU or NPU use, check runtime and build compatibility, model
operators, active session providers, CPU fallback, and which operations ran on
the accelerator.
Do not replace working runtime packages during routine narration setup.

## Practical narration

Use `--text-file` for UTF-8 scripts to avoid shell quoting and putting private
text in command arguments. Keep titles, Markdown bullets, URLs, and stage
directions out of spoken text unless intentional. Start with one short sentence,
then generate sections to new WAVs. Use upstream voice/language mappings, not
guessed speaker identities. Speed controls pacing but does not guarantee a
duration. The helper loads a model for each invocation. It does not stream
audio or produce word-level alignment.

Keep narration text, selected voice, language, speed, model provenance, and output
paths with the project artifacts. Review each clip before mixing or publishing.
Avoid presenting synthetic narration as a recording of someone else.

## Troubleshooting without hidden fallbacks

- If uv is missing, report the prerequisite and request installation instructions
  or permission. Do not install uv automatically.
- For TLS, certificate, or proxy failures, report the original error and use
  the organization's approved certificate/proxy configuration. A prior local
  run used an alternate PyPI mirror to work around TLS handshake failures;
  that mirror is not this plugin's default. Do not disable TLS
  verification or change indexes without approval.
- For a missing wheel, DLL, or phonemizer, compare interpreter architecture and
  installed packages using `doctor`. Check upstream native dependency support.
  Do not silently switch to x64 emulation, another runtime, or a cloud service.
- If the model or voices are missing, pass existing trusted paired files explicitly.
  The helper will not fetch them for you.
- If the output exists, choose a new name. The helper refuses existing files
  and symlinks. An interrupted write may leave a partial new file. Inspect it
  and choose another name or obtain permission before removing it.
- If a voice, language, or inference call fails, preserve the error,
  confirm the paired assets and upstream inventory, and retry only after
  identifying the cause. Never report success from a file's existence alone.
