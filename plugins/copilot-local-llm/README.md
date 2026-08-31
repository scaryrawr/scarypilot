# Copilot Local LLM

`copilot-local-llm` exposes models from local OpenAI-compatible servers in the
Copilot model picker. It adds providers only when their model-discovery
endpoint is available, so Copilot-hosted models continue to work normally.
Discovery requests time out after three seconds to bound extension startup time.
Discovered models are registered as part of the session join, so resuming the
CLI does not replay additive provider registrations. Models remain available
through `/model` as `provider/model-id` (for example,
`omlx/Qwen3.5-9B-mxfp4`).

The plugin also replaces Copilot's verbose generic coding guidance with a
compact prompt to reduce prefill time for local models. This session-wide
customization also applies to Copilot-hosted models selected in the same
session. Copilot's safety, project, runtime, and environment instructions remain
enabled. Tools remain available through their schemas with compact usage
guidance.

When a discovered local model is selected, the plugin preserves the current
tool catalog, including extension tools registered later, and disables only
subagent and factory orchestration tools because local inference generally
cannot serve concurrent agent workloads effectively. Switching back to a
Copilot-hosted model removes those exclusions.

## Prerequisites

- A current [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli)
  release with plugin extension support.
- At least one supported local model server. Unavailable servers are ignored.

## Install

```sh
copilot plugin marketplace add scaryrawr/scarypilot
copilot plugin install copilot-local-llm@scarypilot
```

Restart Copilot or run `/clear` after installing or updating the plugin.

## Usage

Start a supported local server, open Copilot, and select the discovered model
with `/model`.

| Provider  | Default URL              | Discovery endpoint  |
| --------- | ------------------------ | ------------------- |
| Ollama    | `http://localhost:11434` | `/api/tags`         |
| LM Studio | `http://localhost:1234`  | `/api/v1/models`    |
| OMLX      | `http://localhost:8000`  | `/v1/models/status` |
| OSaurus   | `http://localhost:1337`  | `/api/tags`         |
| GenieX    | `http://127.0.0.1:18181` | `/v1/models`        |

Set `<PROVIDER>_BASE_URL` to override a default server URL, and optionally set
`<PROVIDER>_API_KEY` when a local server requires authentication. Ollama and
OSaurus use `<PROVIDER>_CONTEXT_LENGTH` to override their default 131072-token
context window. GenieX uses the same setting with a 65536-token default.
`OSARAUS_*` aliases are accepted for compatibility with the original project's
spelling.

## Develop and test

```bash
cd extensions/copilot-local-llm
npm install
npm run typecheck
npm run lint
npm test
```

Copilot CLI injects its bundled `@github/copilot-sdk` when it loads the
extension. The package dependency pins the SDK version used for local
development and tests; plugin users do not need to run `npm install`.

## Resources

- [Copilot CLI plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference)
- [Source migration record](./NOTICE.md)

This plugin was migrated from
[`scaryrawr/copilot-local-llm`](https://github.com/scaryrawr/copilot-local-llm)
at the revision recorded in `NOTICE.md`.
