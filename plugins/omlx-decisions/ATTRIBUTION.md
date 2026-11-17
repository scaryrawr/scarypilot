# Attribution

Mike Wallio authored the ScaryPilot decision plugin and the former ScaryDex
`decide` skill. The Codex publication retains its MIT license declaration.

The original skill and Node helper followed
[Ollama's Jev-style decision API announcement](https://ollama.com/blog/ollama-now-supports-jev-style-decision-models).
The repository's `docs/scarydex-provenance.json` records that origin and the
earlier vision support.
That record is historical, not the current runtime contract.

The current client uses OMLX's SystemOne API. The
[API reference](skills/decide/references/decision-model-api.md) links the pinned
request schema and the Clef and OpenJev implementations.
The shared native and CLI client replaces the former duplicated Node helper.
