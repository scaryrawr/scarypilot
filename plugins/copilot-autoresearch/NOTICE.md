# Source migration record

- Source: <https://github.com/scaryrawr/copilot-autoresearch>
- Revision: `468f6ddecaa473f69ffc25243db326ba6bd5188b`
- Imported: 2026-08-25
- Original workflow: <https://github.com/davebcn87/pi-autoresearch>
- Upstream parity reviewed through: `703a8f12ce80259d65bec41029c8136ce60686ff`
  (2026-09-09; runtime remains `v1.8.1`)

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

Upstream 1.8.0 (`ab24353`) adds a "revisit discards when their assumptions
change" nudge: after each logged experiment, the agent is asked whether the
result invalidates a previous discard's rollback reason, and a retry can set
`asi.revisits_run` to badge itself as `↻ Revisiting #N` in the transcript.
Both are Copilot-native equivalents: `log_experiment`'s tool description now
carries the same nudge (the extension has no `deliverAs: "steer"` follow-up
message hook), and its `asi` schema documents `revisits_run` with the matching
badge rendered in the tool result. The commit's feature-announcement blog
post, social-preview art, and site-build changes are not part of the Copilot
plugin.

Upstream 1.8.0's release commit and 1.8.1 (`5f6efee`) are not applicable: 1.8.1
fixes a Pi-only bug where `pi.sendUserMessage()` sent the literal string
`/skill:autoresearch-create ...` to the model because Pi requires an explicit
`expandPromptTemplates` option to expand that `/skill:<name>` template syntax.
This Copilot port already sends the create-skill kickoff as a natural-language
instruction (`session.send`'s `MessageOptions` has no equivalent template
option), so the bug does not occur here.
