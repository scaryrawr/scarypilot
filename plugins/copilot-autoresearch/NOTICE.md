# Source migration record

- Source: <https://github.com/scaryrawr/copilot-autoresearch>
- Revision: `468f6ddecaa473f69ffc25243db326ba6bd5188b`
- Imported: 2026-08-25
- Original workflow: <https://github.com/davebcn87/pi-autoresearch>
- Upstream parity reviewed through: `04b8a50dac7efe80ffc91648bd00ed9b022e24c2`
  (2026-10-07; upstream release `v1.9.0`)

The extension runtime, tests, and three bundled skills were imported into
ScaryPilot. Marketplace metadata and installation documentation were added,
plugin-level skill discovery replaced extension-level skill registration, the
development SDK dependency was pinned, and the upstream private-feed lockfile
and standalone setup script were not copied. The finalization skill now keeps
its generated groups file in the repository's `.auto/` directory instead of a
hard-coded `/tmp` path.

No separate license file was present in the intermediate Copilot port at the
imported revision. Files subsequently synchronized or adapted directly from
`davebcn87/pi-autoresearch` remain under its MIT license, reproduced in
`LICENSE.pi-autoresearch`. The upstream project is credited for the original
concept, workflow design, file format, skills, and hook examples.

The upstream 1.7.0 release makes Pi keyboard shortcuts opt-in and adds a
fullscreen-dashboard slash subcommand. Copilot CLI extensions cannot register
keyboard shortcuts or terminal overlays, so those changes do not apply to this
port. The release's portable browser-launcher hardening was already present:
launcher errors are ignored while the loopback dashboard URL remains available
for manual opening.

The commits after 1.7.0 add the upstream project's GitHub Pages website and
social-preview assets. The website is linked from this plugin's documentation,
but its Pi-specific site build, deployment workflow, and generated assets are
not part of the Copilot plugin.

Upstream 1.8.0 ("revisit discards when their assumptions change", `#94`) adds
a nudge after every logged experiment asking the agent whether the result
invalidates a previous discard's rollback reason, plus an `asi.revisits_run`
field and a `↻ Revisiting #N` badge for intentional retries. This behavior is
adapted here: `log_experiment`'s tool result carries the same reminder and
badge, `asi.revisits_run` is validated and persisted in `.auto/log.jsonl`, and
the live dashboard renders the badge per run. The upstream commit's feature
blog post, social-preview art, and site-generation script changes are
Pi-specific site content and were not copied; the `autoresearch-create` skill's
"What's Been Tried" guidance was updated to mention discarded ideas and their
rollback rationale, matching the upstream `SKILL.md` wording.

Upstream 1.8.1 (`#95`) fixes a Pi-specific bug where `pi.sendUserMessage()`
skipped skill/template expansion, causing a raw `/skill:autoresearch-create`
string to reach the model instead of the expanded `SKILL.md`. This port never
relied on prompt-template expansion for its kickoff: the Copilot extension's
`/autoresearch` command sends a plain-English instruction telling the agent to
invoke the `autoresearch-create` skill itself, so the underlying bug does not
apply and no change was needed.

Upstream `#96` (docs: fix README startup instructions) corrects the Pi
`pi-autoresearch` README's install/quickstart snippets for the standalone npm
package; it does not describe the Copilot plugin's install or slash-command
workflow, which already document activation correctly, so it was not ported.

Upstream 1.9.0 (`#100`, `#101`) adds `/autoresearch finalize`, `help`/`--help`/`-h`
aliases, and subcommand autocomplete. `finalize` and the help aliases are
adapted: `finalize` stops the loop like `off` and then asks the agent to invoke
the `autoresearch-finalize` skill, reporting an error when no experiment is
logged. Subcommand autocomplete depends on Pi's command-completion API, which
Copilot CLI extensions lack, so it was not ported; the dashboard-hint fix and
the publish workflow changes are Pi-only.
