# oMLX decisions

Use installed oMLX decision models, including Clef Flash, for routing, classification,
and rubric evaluation through **SystemOne**. This standalone native extension registers
two agent tools; it does not add decision models to Copilot's chat-model picker.
Answers are data. Probabilities and confidence are advisory, never permission to act.

## Prerequisites and installation

Use a running [oMLX server](https://github.com/scaryrawr/omlx) with
`GET /v1/models/status` and `POST /v1/systemone` support, and an installed decision
checkpoint such as Clef Flash. The server discovers decision checkpoints by their
model files; install/download them separately through your existing oMLX workflow.
There is no `/v1/decisions` endpoint in the supported server contract.

Use a Copilot host with native extensions and Node.js 22.18.0 or later.
Local image paths also require SDK confirmation dialogs (elicitation).

```sh
copilot plugin marketplace add scaryrawr/scarypilot
copilot plugin install omlx-decisions@scarypilot
```

Restart Copilot or start a new session after replacing the previous decisions plugin.
Remove the previous plugin from the host so its obsolete tools do not remain registered.
No legacy tool names, environment variables, or backend compatibility layer are retained.
Copilot supplies the SDK at runtime; the checked-in bundle includes TypeBox.
Plugin users do not run npm install.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `OMLX_BASE_URL` | `http://localhost:8000` | HTTP(S) server base URL. Path prefixes work; embedded credentials, queries, and fragments are rejected. |
| `OMLX_API_KEY` | Unset | Optional bearer token for a protected server or proxy. |

Set variables before starting Copilot. The host's environment permission flow grants
configured variables before tools read them. Authenticated remote endpoints require
HTTPS; HTTP authentication is allowed only for exact hosts `localhost`, `127.0.0.1`,
and `[::1]`. Redirects are rejected. State, image contents, keys, and server error
bodies are not echoed in failures.

Discovery/model verification has a 15-second deadline; inference has a separate
120-second deadline, including image approval and reading. Host cancellation aborts
requests and response-body reads. JSON responses are capped at 4 MiB.
The client limits complete UTF-8 request JSON to **64 KiB text-only** or **32 MiB
with nonempty images**, including data-URI and JSON overhead. These are client safety
limits, not claims about server limits. Inputs are not truncated locally.

## Tools and usage

`omlx_decision_models` takes `{}` and reads `/v1/models/status` on every invocation:

```json
{"models":[{"id":"Clef-Flash","loaded":false}]}
```

Use the actual ID returned by your server, not the illustrative ID above.
Eligibility comes from `model_type: "decision"` or `engine_type: "decision"`,
not model-name guesses or capability strings. Empty capabilities are normal.
Discovery does not expose local server paths. Malformed metadata and duplicate IDs
fail explicitly instead of producing incomplete discovery.

`omlx_decide` requires an exact installed `model`, non-null `state`, and nonempty
named `questions`. No tag aliases, substitutions, automatic selection, downloads,
or inference retries are performed. An unloaded discovered model is valid:
oMLX loads it on demand and manages retention/eviction itself.

```json
{
  "model": "Clef-Flash",
  "state": {"ticket": "Synthetic example: a refund for a duplicate charge."},
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
  "truncate": false
}
```

`state` accepts a nonblank string, boolean, finite number, JSON object, or JSON array.
Each question requires nonblank string `instructions`.
`choice` requires a nonempty object of nonblank option keys to string/null descriptions.
`noul` optionally accepts only `true` and `false` string descriptions.
`score` requires a nonempty ordered array of string descriptions.
There are no artificial question/option/level count ceilings; byte and model-context
limits still apply. Model-specific restrictions, including OpenJev's stricter rubric
and image rules, are enforced by the server.

`truncate` defaults to **false**, overriding oMLX's truncating default so context
overflow fails instead of silently dropping state. Set `true` only when truncation
is intended. `keep_alive`, videos, and generation options are not accepted.
Server model TTL/pinning settings control retention, not decision requests.

### Image decisions

`images` is shared by all questions in array order. Entries can be padded raw base64,
inline `data:image/<subtype>;base64,...` strings, or `{"path": "/absolute/image.png"}`.
Raw base64 and local bytes are wrapped as `data:image/png;base64,...`; oMLX identifies
the actual format from the bytes using its image decoder, not that MIME hint.
Image URLs are never fetched. The server verifies actual image/model compatibility:
decision status does not advertise vision, so the client does not invent a vision gate.

Before reading each local file, the host asks for one-time confirmation of its
symlink-resolved path and the exact SystemOne destination. Approve only contents
you intend to send to that endpoint. Denied, missing, cancelled, or late approval
fails closed; tool arguments cannot supply approval.
Files must be nonempty regular files. Bounded, cancellable reads verify descriptor
identity, size, and timestamps before and after reading. Changed files fail without
inference. Local paths are never included in the server request.
Direct `DecisionClient` callers must provide an `approveImage` callback for paths.

```json
{
  "model": "Clef-Flash",
  "state": "Identify the food in the supplied image.",
  "images": [{"path": "/absolute/path/to/food.png"}],
  "questions": {
    "food": {
      "type": "choice",
      "instructions": "Which food is pictured?",
      "criteria": {"hotdog": null, "taco": null}
    }
  }
}
```

### Results and failures

Results preserve `model`, `answers`, and `usage` with nonnegative integer
`input_tokens` and **zero `output_tokens`**: SystemOne scores rather than generating text.
`choice` answers contain `type`, `choice`, `probabilities`, and `confidence`.
`noul` answers contain only `type` and `noul`, the probability of true.
`score` answers contain `type`, `score`, `legend`, `probabilities`, and `confidence`.
Score keys are zero-based level strings. A three-level score ranges from 0 to 2:
`0*P(0) + 1*P(1) + 2*P(2)`, not a normalized 0-to-1 value.

Validation checks response/model/question correspondence, option and legend keys,
finite probability/confidence bounds, score range and weighted arithmetic, and usage.
Clef rounds numbers independently to four decimals; sum and weighted-score checks
allow only the resulting cardinality-dependent rounding error, without renormalizing.
HTTP errors, context overflow, late error envelopes, malformed JSON/UTF-8, invalid
metadata, oversized bodies, timeouts, and cancellation return explicit redacted failures.

## Development and verification

From `extensions/omlx-decisions`:

```sh
npm ci
npm run build
npm run typecheck
npm test
```

Tests use synthetic local fixtures and exercise both source and shipped registration.
Run repository lint and `node tools/check-extension-bundles.mjs check` from the root.
Keep source, lockfile, `dist/extension.mjs`, and `bundle-manifest.json` together.

The optional live smoke requires an exact already-installed decision model:

```sh
OMLX_DECISIONS_LIVE=1 OMLX_DECISIONS_MODEL=Clef-Flash npm run smoke:live
```

It sends only synthetic public ticket data, disables truncation, and checks all
three answer shapes without assuming model-specific answers. It does not download
models or alter server retention settings. Check live extension-host registration separately.

## Resources

- [oMLX integration source](https://github.com/scaryrawr/omlx).
- [SystemOne request contract](https://github.com/scaryrawr/omlx/blob/main/omlx/api/systemone_models.py).
- [Decision engine](https://github.com/scaryrawr/omlx/blob/main/omlx/engine/decision.py).
- [Clef inference and answer construction](https://github.com/scaryrawr/omlx/blob/main/omlx/models/clef.py).
- [Image input decoder](https://github.com/scaryrawr/omlx/blob/main/omlx/utils/image.py).
