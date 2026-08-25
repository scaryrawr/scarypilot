# Source migration record

- Source: <https://github.com/scaryrawr/copilot-autoresearch>
- Revision: `468f6ddecaa473f69ffc25243db326ba6bd5188b`
- Imported: 2026-08-25
- Original workflow: <https://github.com/davebcn87/pi-autoresearch>

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
