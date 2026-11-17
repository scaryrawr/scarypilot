# Choose a media action

Resolve this plugin's installed root from the loaded skill's absolute path.
Each skill lives at `<plugin-root>/skills/<name>/SKILL.md`. Do not assume a
checkout, current working directory, Copilot home, or Codex cache path.

Discover the host's advertised capabilities by action description. Keywords
identify intent, not a tool name or permission. Read the actual schema before
calling a native capability. Unknown capabilities are unavailable.

| Action keywords | Required behavior | Bundled CLI operation |
| --- | --- | --- |
| Generate or edit an image | Save new PNG files and preserve source images. | `image` |
| Generate speech or narration | Save new audio and report the selected model. | `speech` |
| Transcribe audio | Save a new text transcript. | `transcribe` with `output` |
| Prepare a recording | Save bounded audio chunks, transcript offsets, and a manifest. | `transcribe` with `output_dir` |
| Extract or prepare frames | Save bounded samples, requested timestamps, and a manifest. | `prepare-frames` |

Prefer a matching native capability when the host actually advertises it.
Otherwise run the bundled, dependency-free Node helper:

```text
node "<plugin-root>/scripts/media.mjs" --help
node "<plugin-root>/scripts/media.mjs" <operation> --input-json "<absolute-arguments.json>"
```

The CLI and Copilot extension call the same media execution source. Codex
installation needs Node 22.18 or newer, not npm, Bun, or the Copilot SDK.
Recording and frame preparation also need FFmpeg and FFprobe.
JSON argument names match the shared execution contracts.

Keep all source files and outputs in the user's workspace. Use new absolute
output paths outside the installed plugin. Preparation requires a fresh
directory whose parent already exists. Preserve partial artifacts on failure
and retry into a new directory. Never use a fallback to bypass a validation,
privacy, dependency, or output-conflict error.

Check `OMLX_BASE_URL` before any request. It defaults to
`http://127.0.0.1:8000`. `OMLX_API_KEY` is optional and must not appear in reports.
Require explicit consent for transmission to a nonlocal endpoint, including
legacy image and audio operations. Recording preparation enforces literal
loopback endpoints and refuses redirects unless recording-specific
`allow_remote` consent permits a nonlocal endpoint. It still refuses redirects.
No action authorizes capture, upload, hosted agent transmission, model
downloads, or voice impersonation.

Use Python scripts only for their additional behavior, such as silence-aware
chunking, classification, or highlight verification. Resolve each script from
its installed skill directory and check `uv --version` first. Invoke standalone
scripts with `uv run --no-project python "<absolute-script>" ...`. Scripts with
inline dependency metadata use `uv run --script "<absolute-script>" ...`.
Obtain approval for missing dependencies or network access when required.
