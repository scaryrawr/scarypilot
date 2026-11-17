# Scarydex consolidation

Scarypilot publishes native marketplaces for Copilot and Codex. Both catalogs
use the name `scarypilot`. Matching plugin names point at the same directory
and skills. Native manifests select the runtime components each client supports.

## Source and attribution

Codex content comes from [scarydex commit
8dc6a9c8179f496d156c70f743df6aa1b7f8b721](https://github.com/scaryrawr/scarydex/commit/8dc6a9c8179f496d156c70f743df6aa1b7f8b721).
The import record is [scarydex-provenance.json](scarydex-provenance.json).
Plugin notices retain upstream authorship and licenses.

Riverkids is excluded from the current marketplace. Its entries in the historical
source inventory and provenance record remain for reference.

The old scarydex-to-scarypilot review registry is historical. It is not an
active sync mechanism inside this repository. Shared content now changes in
one place. Pstack's existing upstream review policy remains responsible for
its Cursor upstream.

## Shared content and native contracts

Pstack workflows describe actions such as delegating bounded work, collecting
worker results, querying scoped history, and requesting approval. An agent
must resolve each action against the actual host's advertised capabilities
and schemas. Action descriptions are not executable aliases or permission
grants. A missing required capability remains a reported limitation.

Better-init selects instruction destinations for the requested client.
Portable facts belong in `AGENTS.md`. Copilot-specific instruction files and
Codex-specific project skills retain their actual discovery rules.

Anti-slop shares its rules, scanner, and edit analysis. Copilot uses
`hooks/copilot.json`; Codex uses `hooks/hooks.json` and the Codex payload
adapter. Codex requires explicit Oxlint setup and never installs dependencies
from an edit hook. Copilot retains its existing cache bootstrap.
Codex cache and reflection state use the `scarypilot` namespace. Existing
`scarydex` caches are not migrated or removed; run the new anti-slop setup with
the hook's `PLUGIN_DATA` or `CODEX_HOME` environment.

Digivolution shares its reflection skill. Copilot uses the native in-memory
turn monitor. Codex uses command hooks with minimized per-session, per-turn state.
Neither integration stores prompt text as reflection evidence.

Media and recording retain native Copilot tools and packaged command helpers
for clients without those tools. Discovery never proves capture permission
or model availability. Existing recording identities and source files must
survive interruption and recovery.

Pstack preserves the optional Codex orchestration ledger and legacy statechart
helpers without replacing the newer watcher or compiler. Its checked-in Node
bundles run without Bun or package installation; rebuilds use the plugin-local
locked development dependencies. The ledger records work but grants no
permissions and does not launch workers.

Codex's `decide` and Copilot's `omlx-decisions` share one plugin root and
decision-model execution code. The CLI accepts text and supplied base64 images;
unlike the former scarydex CLI, it refuses local image paths. Do not encode
local files as a workaround for missing approval. File uploads remain available
through native tools with their per-call path-and-destination confirmation.

Codex's `autoresearch` shares the `copilot-autoresearch` plugin root. Experiment
commands are portable; Copilot's dashboard, session hooks and auto-resume remain
native features. A CLI command does not create a host session or schedule an
agent wake-up. The [experiment CLI guide](../plugins/copilot-autoresearch/docs/cli.md)
documents manual and automatic Git policies, durable receipts, and interrupted-run
recovery. Automatic Git requires ignored, untracked `.auto/cli*` control files.

## Validation

`node --test tools/plugin-manifests.test.mjs` checks both catalogs and enforces
one shared root for overlapping names. Native adapters and helpers have
focused offline tests. `node tools/smoke-codex-plugins.mjs` installs and discovers
the Codex inventory in a temporary home without model requests or changes to
the user's installed plugins.

`node --test tests/codex-media/*.test.mjs` checks installed-copy media and recorder
execution with fixtures. `node external_plugins/pstack/build.mjs --check`
checks reproducible portable helpers; `node tools/check-extension-bundles.mjs check`
checks native extension bundles. See each package's tests for runtime contracts.

Manifest checks and discovery do not prove model behavior. Skill evaluation
selection uses `node tools/skill-evals.mjs select --base main`. Model-backed
execution requires separate approval under the repository's evaluation policy.
