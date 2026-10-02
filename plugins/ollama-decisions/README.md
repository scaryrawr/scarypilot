# Ollama decisions

Use installed Ollama decision models from Copilot for fast routing, classification, and rubric evaluation.
This standalone native extension registers two agent tools. It does not add models to Copilot's chat-model picker.
Answers remain data. Probabilities and confidence are advisory and never grant permission to act.

## Prerequisites and installation

Use Ollama 0.35.0 or later, a running local server, and an installed model advertising the `decision` capability.
Use a Copilot host with native extension support and Node.js 22.18.0 or later.

Install a decision model manually if you do not already have one:

```sh
ollama pull nimble
```

The extension never pulls models, downloads models, selects a model automatically, or retries inference.
Install the plugin:

```sh
copilot plugin marketplace add scaryrawr/scarypilot
copilot plugin install ollama-decisions@scarypilot
```

Copilot supplies the SDK at runtime. The checked-in bundle includes TypeBox, so plugin users do not run npm install.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | HTTP or HTTPS server base URL. A path prefix is supported. Embedded credentials, queries, and fragments are rejected. |
| `OLLAMA_API_KEY` | Unset | Optional bearer token for a protected server or proxy. Local Ollama does not require a key. |

Set variables before starting Copilot. The extension requests access to `OLLAMA_API_KEY` through the host's environment-variable permission flow.
When an API key is configured, remote endpoints require HTTPS before any network request.
Authenticated HTTP is allowed only for the exact URL hosts `localhost`, `127.0.0.1`, and `[::1]`.
Redirects are rejected so credentials and state cannot follow a redirect to another server.
Discovery and model verification have a 15-second total metadata deadline. Inference has a separate 120-second deadline.
Host cancellation aborts active requests, including response-body reads.
Each metadata or inference response is limited to 4 MiB. Oversized declared lengths and streamed bodies are rejected and cancelled before JSON parsing.
Request state and API keys are not logged or included in error messages.

## Tools and usage

`ollama_decision_models` takes `{}` and reads `/api/tags` on every invocation.
It returns `{"models":[{"name":"nimble:latest","capabilities":["decision", "..."]}]}` with the server's actual capability strings.
Only models advertising `decision` are included. Model names are not evidence of support.
When an installed entry omits capabilities, discovery posts `{"model":"<installed name>"}` to `/api/show`.
Explicit empty capabilities are authoritative. Failed or unresolved metadata fails discovery instead of silently omitting a model.

`ollama_decide` requires an explicit installed `model`, `state`, and 1-64 named `questions`.
Use an exact name from discovery. An untagged name can resolve to its installed `:latest` alias, but an exact installed name takes precedence.
No other aliases, substitutions, or automatic choices are made.
The tool verifies the requested model's capability before sending one request to `/v1/systemone`.

Ask Copilot to discover decision models, then classify a synthetic ticket using the exact installed model.
The tool input can combine question types:

```json
{
	"model": "nimble:latest",
	"state": {"ticket": "Synthetic example. A customer requests a refund for a duplicate charge."},
	"questions": {
		"category": {
			"type": "choice",
			"instructions": "Classify the ticket.",
			"criteria": {"billing": "Payments and refunds", "other": null}
		},
		"refund": {
			"type": "noul",
			"instructions": "Is a refund requested?",
			"criteria": {"true": "A refund is requested"}
		},
		"urgency": {
			"type": "score",
			"instructions": "Rate urgency.",
			"criteria": ["Routine", "Soon", "Immediate"]
		}
	},
	"keep_alive": "5m"
}
```

`state` is a nonempty string, a JSON object, or a JSON array. Each question needs a nonempty string `instructions`.
The complete serialized request must fit within Ollama's 64 KiB text-only JSON limit and the model's context window.
The extension checks the byte limit before inference. Input is never truncated.
`choice` has 2-26 nonempty option keys with string or null descriptions.
`noul` has optional criteria containing only `true` and `false` string descriptions. Either description can be omitted.
`score` has an array of 2-26 string descriptions, ordered from lowest to highest.
`keep_alive` is optional and accepts an Ollama duration string or a number of seconds. Negative values keep the model loaded.
Images, videos, and generation options are not accepted.

The result preserves upstream `model`, `answers`, and `usage` with integer `input_tokens` and `output_tokens`.
Each `choice` answer contains `type`, `choice`, `probabilities`, and `confidence`.
Each `noul` answer contains only `type` and `noul`, the probability of true from 0 to 1.
Each `score` answer contains `type`, `score`, `legend`, `probabilities`, and `confidence`.
Score legend and probability keys are zero-based level strings such as `"0"`, `"1"`, and `"2"`.
A three-level score is `0*P(0) + 1*P(1) + 2*P(2)`, ranging from 0 to 2, not a normalized 0-to-1 score.

## Errors

Tools return explicit failure results for invalid input, oversized requests or responses, invalid configuration, unavailable servers, rejected redirects, HTTP errors, timeouts, and cancellation.
Ollama 0.35 or later and a decision-capable installed model are required for inference.
Malformed network JSON, invalid UTF-8, failed capability lookups, and invalid answer correspondence fail instead of returning partial success.
Validation checks answer names and types, choice membership, rubric legends, probability bounds and sums, weighted scores, confidence bounds, and nonnegative integer usage.
Server error bodies are not echoed because they can contain state or credentials.
Unknown errors return a redacted failure, never a success-shaped fallback.

## Development and verification

From `extensions/ollama-decisions`, run:

```sh
npm ci
npm run build
npm run typecheck
npm test
```

Tests use synthetic data and local HTTP fixtures. Registration tests exercise both source and the built entry point.
Run repository lint and `node tools/check-extension-bundles.mjs check` from the repository root.
Keep `dist/extension.mjs`, `bundle-manifest.json`, and `package-lock.json` with source changes.

The live smoke is opt-in and requires an exact already-installed model:

```sh
OLLAMA_DECISIONS_LIVE=1 OLLAMA_DECISIONS_MODEL=nimble:latest npm run smoke:live
```

The smoke sends only synthetic public ticket data and sets `keep_alive` to zero.
It checks discovery and all answer shapes without asserting a model-specific probabilistic answer.
It never pulls a model. Live extension-host registration must be checked separately in the consuming host.

## Resources

- [Ollama decision-model announcement](https://ollama.com/blog/ollama-now-supports-jev-style-decision-models).
- [Nimble model library](https://ollama.com/library/nimble).
- [Decision capability documentation](https://docs.ollama.com/capabilities/decision).
- [System One API reference](https://docs.ollama.com/api/systemone).
- [Authoritative decision wire types](https://github.com/ollama/ollama/blob/main/decision/types.go).
- [Upstream question validation and answer construction](https://github.com/ollama/ollama/blob/main/decision/systemone.go).
