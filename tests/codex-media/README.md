# Portable media regressions

These tests adapt the pinned `scaryrawr/scarydex` media and recorder regressions.
The source is copyright 2026 Mike Wallio under the MIT license retained in both
plugin roots. Preparation coverage includes only the original network-free
cases. Existing Copilot extension suites retain their broader coverage.

Run from the repository root:

```text
node --test tests/codex-media/*.test.mjs
```

The tests need Node 22.18 or newer, `uv`, a locally available Python 3.11 or
newer, FFmpeg, and FFprobe. Python checks run with `UV_OFFLINE=1` and
`UV_PYTHON_DOWNLOADS=never`. Tests never run a model, capture a screen, bind a
network service, or contact an endpoint. Image and audio requests replace
`fetch` at the external boundary. Recorder fixtures replace capture processes.
Clip checks generate synthetic solid-color video locally.

Native media tests run in `plugins/omlx-media/extensions/omlx-media`. The existing
`media-tools.test.ts` also starts loopback HTTP fixtures. Do not run that full
file when network use is forbidden.

The imported recorder tests preserve ScaryPilot's state namespace and the
existing policy that refuses PowerShell enumeration under a Restricted
execution policy. They do not import Codex's execution-policy bypass.
