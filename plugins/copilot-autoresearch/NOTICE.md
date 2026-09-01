# Source migration record

- Source: <https://github.com/scaryrawr/copilot-autoresearch>
- Revision: `468f6ddecaa473f69ffc25243db326ba6bd5188b`
- Imported: 2026-08-25
- Original workflow: <https://github.com/davebcn87/pi-autoresearch>
- Upstream parity reviewed through: `dab7046feedfcc47b406eef36e59a3f4a0d9e508`
  (`v1.7.0`, 2026-08-31)

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
