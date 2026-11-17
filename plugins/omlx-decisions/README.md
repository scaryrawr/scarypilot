# oMLX decisions

Use installed oMLX decision models, including Clef and OpenJev, for routing,
classification, and rubric evaluation through **SystemOne**. One shared client
powers two native tools and a bundled Node CLI. It does not add decision models
to Copilot's chat-model picker.
Answers are data. Probabilities and confidence are advisory, never permission to act.

## Prerequisites and installation

Use a running [oMLX server](https://github.com/scaryrawr/omlx) with
`GET /v1/models/status` and `POST /v1/systemone` support, and an installed decision
checkpoint such as Clef Flash. The server discovers decision checkpoints by their
model files; install/download them separately through your existing oMLX workflow.
There is no `/v1/decisions` endpoint in the supported server contract.

Local oMLX inference requires **macOS on Apple Silicon**. The HTTP client can run
on Windows or Linux against an explicitly configured remote oMLX server.
Local image files still require per-call approval for the resolved path and
destination; remote configuration does not grant transmission consent.

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

### Codex and CLI installation

Both publications use this plugin root and the same `decide` skill.
Copilot keeps its native publication name `omlx-decisions`.
Codex keeps publication name `decide` and skill invocation `$decide:decide`.
This publication-name aliasing does not rename native tools.
The shared skill discovers advertised capabilities and inspects their schemas
instead of assuming tool names or host protocols.

```sh
codex plugin marketplace add scaryrawr/scarypilot
codex plugin add decide@scarypilot
```

Codex and standalone CLI users need only Node.js 22.18.0 or later.
The shipped CLI loads neither the Copilot SDK nor npm dependencies.
Resolve paths from the installed plugin, even when the workspace has spaces:

```sh
node "/absolute/installed/plugin/skills/decide/scripts/decide.mjs" models
node "/absolute/installed/plugin/skills/decide/scripts/decide.mjs" run \
	--model "<installed-id-or-alias>" --input "/absolute/workspace/decision.json"
```

`models` preserves the old decision and all-model sections, aliases, and
unavailability messages. CLI inference accepts an exact installed ID or an
explicitly supplied alias for one installed decision model.
Exact IDs take precedence, even when the same string is another model's alias.
Ambiguous aliases fail before inference. The client sends the resolved exact ID
and validates the response against that ID, without choosing a model or retrying.
Native inference keeps exact-ID semantics and does not resolve aliases.
Both clients verify the model through metadata before every request.
The CLI accepts older metadata that omits `engine_type` or `loaded`.
Omitted loaded status stays unknown rather than becoming false.
The CLI preserves additional top-level response fields, including `error: null`,
along with all answers and usage. Native responses accept only `model`, `answers`,
and `usage`.

### Breaking change for former Codex decide users

Codex `decide` is now version 1.0.0. CLI `images` no longer accepts local paths.
It accepts only supplied padded base64 or inline image data URIs.
Path strings and `{"path": "..."}` objects fail before image-file I/O or HTTP.
There is no approval flag, environment boolean, stdin confirmation, or conversion
helper. Do not convert a local file to bypass missing or denied native consent.
Native file uploads still require the real host callback for every resolved path
and destination on every call.

The CLI keeps `models` and `run --model ... --input ...`, text and JSON state,
image-only supplied data, and the 2 to 26 choice and score criterion contract.
Unknown input fields now fail instead of being discarded.
Truncation now defaults to false instead of inheriting the server's trimming
default. Set `truncate: true` only when dropping context is intended.
OpenJev never truncates and its vision checkpoints accept at most one image.
Confidence remains model-specific, not necessarily the largest probability.
Redirects fail and authenticated remote HTTP is rejected, matching native safety.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `OMLX_BASE_URL` | `http://localhost:8000` | HTTP(S) server base URL. Path prefixes work; embedded credentials, queries, and fragments are rejected. |
| `OMLX_API_KEY` | Unset | Optional bearer token for a protected server or proxy. |

Set variables before starting Copilot. The host's environment permission flow grants
configured variables before tools read them. Authenticated remote endpoints require
HTTPS; HTTP authentication is allowed only for exact hosts `localhost`, `127.0.0.1`,
and `[::1]`. Redirects are rejected.
Native failures omit state, image contents, keys, and server error bodies.

Native discovery/model verification has a 15-second deadline; inference has a separate
120-second deadline, including image approval and reading. Host cancellation aborts
requests and response-body reads. JSON responses are capped at 4 MiB.
The client limits complete UTF-8 request JSON to **64 KiB text-only** or **32 MiB
with nonempty images**, including data-URI and JSON overhead. These are client safety
limits, not claims about server limits. Inputs are not truncated locally.
The CLI retains 10-second metadata and 300-second inference deadlines.
Both clients enforce the same byte and response limits.

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
Native metadata requires both `engine_type` and boolean `loaded` for every model.
Native validation ignores unrelated metadata, including alias and unavailability
fields. The CLI validates those fields when supplied.

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
Native text state must remain nonblank even when images are supplied.
An empty string is also accepted when nonempty images supply the context.
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
metadata, oversized bodies, timeouts, and cancellation return explicit failures.
Native failures keep server bodies redacted. The CLI preserves server error
messages, including late keepalive errors and FastAPI validation `msg` strings,
but does not include validation input fields.
Server messages can contain server-authored details. Treat CLI stderr accordingly.

## Development and verification

From `extensions/omlx-decisions`:

```sh
npm run build
npm run typecheck
npm test
npm run bundle:check
```

Tests use synthetic local fixtures and exercise both source and shipped registration.
Run repository lint and `node tools/check-extension-bundles.mjs check` from the root.
Restore locked development dependencies with `npm ci` if they are missing.
Keep source, lockfile, all `dist/` entries, and `bundle-manifest.json` together.
The local build records the same input and output hashes as the root bundle checker.
Tests execute a source-free, SDK-free installed CLI copy in paths with spaces.
Native registration tests exercise the host confirmation callback in source and bundle.

The optional live smoke requires an exact already-installed decision model:

```sh
OMLX_DECISIONS_LIVE=1 OMLX_DECISIONS_MODEL=Clef-Flash npm run smoke:live
```

It sends only synthetic public ticket data, disables truncation, and checks all
three answer shapes without assuming model-specific answers. It does not download
models or alter server retention settings. Check live extension-host registration separately.

## Resources

- [Shared decision skill](skills/decide/SKILL.md).
- [CLI and SystemOne reference](skills/decide/references/decision-model-api.md).
- [Attribution and historical provenance](ATTRIBUTION.md).
- [oMLX integration source](https://github.com/scaryrawr/omlx).
- [SystemOne request contract](https://github.com/scaryrawr/omlx/blob/main/omlx/api/systemone_models.py).
- [Decision engine](https://github.com/scaryrawr/omlx/blob/main/omlx/engine/decision.py).
- [Clef inference and answer construction](https://github.com/scaryrawr/omlx/blob/main/omlx/models/clef.py).
- [Image input decoder](https://github.com/scaryrawr/omlx/blob/main/omlx/utils/image.py).
