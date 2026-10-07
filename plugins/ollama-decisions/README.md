# Ollama decisions

Use installed Ollama decision models from Copilot for fast routing, classification, and rubric evaluation, including images with Clef and Clef Flash.
This standalone native extension registers two agent tools. It does not add models to Copilot's chat-model picker.
Answers remain data. Probabilities and confidence are advisory and never grant permission to act.

## Prerequisites and installation

Use Ollama 0.35.0 or later, a running local server, and an installed model advertising the `decision` capability.
Use a Copilot host with native extension support and Node.js 22.18.0 or later.
Local image file inputs also require a host supporting SDK confirmation dialogs (elicitation).

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

Set variables before starting Copilot. The extension requests `OLLAMA_BASE_URL` and `OLLAMA_API_KEY` through the host's environment-variable permission flow.
The host prompts only for configured variables it filters from extensions. Tools read configuration after `joinSession` grants access.
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
Image requests also require the installed model to advertise `vision`. Discovery preserves that capability.

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
The complete serialized request must fit within Ollama's 64 KiB text-only JSON limit, or 32 MiB when the `images` array is nonempty, and the model's context window.
The image limit includes base64 data and JSON overhead. An omitted or empty `images` array uses the text-only limit.
The extension checks UTF-8 byte limits before inference. Input is never truncated.
`choice` has 2-26 nonempty option keys with string or null descriptions.
`noul` has optional criteria containing only `true` and `false` string descriptions. Either description can be omitted.
`score` has an array of 2-26 string descriptions, ordered from lowest to highest.
`keep_alive` is optional and accepts an Ollama duration string or a number of seconds. Negative values keep the model loaded.
Numeric seconds must be finite and at most `9223372036.854774`, the greatest binary64 value whose multiplication by `1e9` stays below `2^63`.
That bound is exactly `9223372036.85477447509765625` seconds. The next binary64 value, `9223372036.854776`, multiplies to `2^63` and is rejected before any fetch.
All finite negative numeric values remain valid because Ollama handles them before duration conversion.
Duration strings use Go's `time.ParseDuration` syntax, including signs, compound values such as `"1h30m"`, fractions such as `".5s"`, and `"0"`.
Supported units are `ns`, `us`, both Unicode microsecond spellings, `ms`, `s`, `m`, and `h`.
Strings must parse successfully under Go's signed 64-bit nanosecond rules. Invalid strings fail locally before any metadata or inference request.
Zero unloads the model after the request. The string `"-0.1ns"` parses as zero and does not keep the model loaded indefinitely.
Videos and generation options are not accepted.

### Image decisions

Use an installed model with both `decision` and `vision` capabilities, such as `clef-flash:latest`.
The optional `images` array is shared by all questions, in array order.
Each entry is either a raw padded base64 string or `{"path": "/absolute/path/to/image.png"}`.
Local paths refer to files on the extension host, not the Ollama server. They are read with bounded, cancellable I/O and encoded before inference.
Before opening each file, the host asks for one-time confirmation showing its symlink-resolved path and the exact Ollama destination URL.
Approve only files whose complete contents you intend to share with that endpoint, including when using a remote server.
Denial, cancellation, an unavailable confirmation dialog, or a changed file fails closed without transmitting its contents.
Denied or unavailable approval also prevents reading the file.
Symlinks are resolved before confirmation; file identity and metadata are checked after opening the approved path.
Reads are bounded to the approved file size, then checked against final descriptor metadata and the exact byte count before encoding.
Host cancellation and the inference deadline also interrupt an unanswered confirmation; a late approval cannot resume the request.
The approval is never taken from tool arguments or cached for subsequent calls. Direct `DecisionClient` users must supply an `approveImage` callback; without it, local paths are rejected.
Only the encoded bytes are sent; local file paths are not included in the request body or errors.
URLs and data URLs are rejected, not downloaded. Unreadable, empty, non-regular, or oversized files fail explicitly.
Ollama validates the actual image format. Use an Ollama release supporting Clef vision requests.

For example, ask Copilot to classify a supplied image:

```json
{
	"model": "clef-flash:latest",
	"state": "Identify the food in the supplied image.",
	"images": [{"path": "/absolute/path/to/food.png"}],
	"questions": {
		"food": {
			"type": "choice",
			"instructions": "Is this a hotdog or taco?",
			"criteria": {"hotdog": null, "taco": null}
		}
	},
	"keep_alive": 0
}
```

The direct Ollama API accepts only base64 strings in `images`; file objects are a convenience provided by this Copilot tool.

The result preserves upstream `model`, `answers`, and `usage` with integer `input_tokens` and `output_tokens`, plus the optional nonnegative integer `prompt_eval_cached_count` returned by newer Ollama releases.
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
- [Clef Flash model library](https://ollama.com/library/clef-flash).
- [Decision capability documentation](https://docs.ollama.com/capabilities/decision).
- [System One API reference](https://docs.ollama.com/api/systemone).
- [Authoritative decision wire types](https://github.com/ollama/ollama/blob/main/decision/types.go).
- [Upstream question validation and answer construction](https://github.com/ollama/ollama/blob/main/decision/systemone.go).
- [Ollama duration decoding](https://github.com/ollama/ollama/blob/main/api/types.go).
- [Go duration syntax](https://pkg.go.dev/time#ParseDuration).
