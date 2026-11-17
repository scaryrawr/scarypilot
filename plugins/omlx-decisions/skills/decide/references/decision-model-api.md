# OMLX decision model API

The runtime contract follows OMLX's
[SystemOne schema](https://github.com/scaryrawr/omlx/blob/e92744893724f3a8ba21a9294d82dd8155c1422e/omlx/api/systemone_models.py),
[server endpoints](https://github.com/scaryrawr/omlx/blob/e92744893724f3a8ba21a9294d82dd8155c1422e/omlx/server.py),
[Clef implementation](https://github.com/scaryrawr/omlx/blob/e92744893724f3a8ba21a9294d82dd8155c1422e/omlx/models/clef.py), and
[OpenJev implementation](https://github.com/scaryrawr/omlx/blob/e92744893724f3a8ba21a9294d82dd8155c1422e/omlx/models/openjev.py).
[Attribution](../../../ATTRIBUTION.md) records the former Codex skill's origin.

## Configuration and discovery

`OMLX_BASE_URL` defaults to `http://localhost:8000`.
It supports reverse-proxy prefixes but rejects credentials, queries, and fragments.
`OMLX_API_KEY` adds bearer authentication to discovery and inference.
Authenticated remote endpoints require HTTPS. HTTP authentication is permitted
only for exact hosts `localhost`, `127.0.0.1`, and `[::1]`.
Redirects are rejected.

`GET /v1/models/status` returns installed models with `id` and `model_type`.
Native metadata requires nonblank `engine_type` and boolean `loaded`.
The CLI accepts older metadata without either field and validates optional
`model_alias` and `unavailable_reason` fields. Native validation ignores those
fields as unrelated metadata.
Eligibility requires `model_type: "decision"` or `engine_type: "decision"`.
CLI inference accepts an explicitly supplied `model_alias` when it identifies
one installed decision model. An exact ID match always takes precedence,
including an exact ID for a non-decision model, which is rejected.
Without an exact match, aliases are matched only against installed models whose
model or engine type is decision. Multiple matches fail before inference.
The HTTP request and response validation use the resolved exact ID.
Native inference accepts exact IDs only. Neither client chooses a model automatically.
The CLI leaves an omitted loaded status unknown.
Discovery rejects duplicate IDs and malformed metadata.

Native discovery returns decision IDs and their required loaded status.
CLI `models` prints decision models followed by all models.
Neither operation downloads, selects, or infers vision support for a model.
Every inference verifies its model against fresh installed metadata.

## Request

`POST /v1/systemone` accepts an explicit model, state, named questions, optional
images, and optional truncation. No chat messages or generation options are sent.

```json
{
	"model": "exact-installed-id",
	"state": {"ticket": "I was charged twice. Please refund the extra payment."},
	"questions": {
		"team": {
			"type": "choice",
			"instructions": "Which team should handle this ticket?",
			"criteria": {"billing": "Payments and refunds", "technical": "Bugs", "other": null}
		},
		"refund": {"type": "noul", "instructions": "Is a refund explicitly requested?"},
		"urgency": {
			"type": "score",
			"instructions": "How urgent is this ticket?",
			"criteria": ["Routine", "Soon", "Urgent"]
		}
	},
	"truncate": false
}
```

The CLI accepts `run --model <installed-id-or-alias> --input <absolute-json-file>`.
Its file contains the request fields except `model`, which comes from the flag.
Unknown fields fail instead of being silently dropped.

- CLI `state` accepts text, an object, or an array. It may be omitted or empty
  when images supply the context. Native state also accepts booleans and numbers.
  Native text state must be nonblank, even with images.
- `questions` is a nonempty object of named questions with nonblank instructions.
- `choice` maps option names to string descriptions or `null`.
- `noul` returns the probability of true. Optional criteria contain only string
  descriptions under `true` and `false`.
- `score` uses an ordered array of string labels.
- The CLI retains 2 to 26 choice options or score labels. Native tools have no
  artificial count ceiling. Model-specific limits are enforced by the server.
- `truncate` defaults to false in both clients. Clef rejects overflow rather
  than trimming state unless true is explicit. OpenJev never truncates.

## Images

CLI images are supplied padded raw base64 or inline
`data:image/<subtype>;base64,...` strings, with 1 to 10 entries.
They are not URLs or local file paths. Raw base64 is wrapped with a PNG MIME
hint. The server decodes the actual bytes and verifies the format.
An existing JPEG data URI retains its supplied MIME subtype.

Native tools also accept `{"path": "/absolute/image.png"}`.
Before each file read, the real host callback asks for confirmation of the
symlink-resolved path and exact destination on that call.
Denied or missing confirmation fails closed.
Prior approval, tool arguments, and environment flags do not grant consent.
File identity, size, and timestamps are checked before and after bounded reads.
Local paths never enter the HTTP body.

The CLI rejects path strings and objects before image-file I/O or network access.
There is no approval override or file-conversion helper.
Reading and converting a file to evade missing or denied native consent is unsupported.

Clef image support requires a vision backbone.
OpenJev image support requires a vision backbone and permits at most one image.
The client does not infer that capability from the model name.
Videos are unsupported.

## Response

Native responses accept only `model`, `answers`, and `usage`.
The CLI also accepts `error: null` and preserves additional top-level fields.
`model` must match the resolved installed ID,
not the alias supplied to the CLI.
`answers` must contain exactly the requested names and answer types.
`usage.input_tokens` is a nonnegative integer and `usage.output_tokens` is zero.

`choice` contains the selected criterion, a probability for every option, and confidence.
`noul` contains a probability from zero to one.
`score` contains the weighted zero-based level, a legend, level probabilities,
and confidence. Three labels produce a score from zero to two:

```text
score = 0 * P("0") + 1 * P("1") + 2 * P("2")
```

Probability and score validation permits independent four-decimal rounding,
with a cardinality-dependent tolerance. Values are not renormalized.
OpenJev confidence has model-specific semantics and need not equal the largest
probability. Confidence and probabilities are estimates, never authority to act.

## Limits and failures

The complete UTF-8 request JSON is limited to 64 KiB for text-only requests
or 32 MiB with nonempty images. Responses are limited to 4 MiB.
These client limits include JSON overhead. No local truncation occurs.

Native metadata and inference deadlines are 15 and 120 seconds.
CLI deadlines are 10 and 300 seconds. Response-body reads share their deadline.
Native file confirmation and reads share the inference deadline.
Host cancellation aborts pending requests and native confirmation waits.

Invalid input fails before network access. The CLI exits nonzero for invalid
arguments, unreadable JSON, unsupported models, HTTP failures, late error
envelopes, malformed JSON or UTF-8, invalid answers, timeouts, or redirects.
No inference retries, chat fallback, or alternate provider is used.

Native errors redact server response bodies.
The CLI retains server error message strings and FastAPI validation `msg`
strings, not validation input values. A SystemOne 404 includes an endpoint hint.
Client-generated errors omit input JSON and keys. Server messages can contain
server-authored details and are not a redacted logging interface.
