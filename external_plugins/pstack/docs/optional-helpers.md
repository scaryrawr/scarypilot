# Use the optional helper CLIs

Resolve each path relative to the installed plugin root and invoke JavaScript
with Node 22.18 or later. The checked-in bundles need no dependency installation or writable
plugin cache. Both hosts use the same source and bundle for each helper.

## Watch a PR

Run `node skills/poteto-mode/scripts/watch-pr/watch-pr.mjs --help` for the
current options. The bundle is built from the current shared watcher sources,
including fork-aware stack discovery and deadline-capped sleeps. It needs Git,
authenticated `gh`, and permission for the requested forge access.

## Keep an orchestration ledger

The preserved `skills/poteto-mode/scripts/orch/orch.mjs` supports unit rows,
verification records, inbox pointers, parked gates, standing orders, and frontier
discovery. Read its help before using it. Supply `--store <approved-directory>`
or `ORCH_STORE`; it does not select or create a store unless invoked.

The store has one writer at a time and uses a PID lock. Never use `--force` to
steal a live writer's lock without explicit operator approval. Reconcile existing
records before migrating or replacing a store. A ledger entry is a claim tied to
a PR and SHA, not independent evidence that a check ran.

`frontier set --repo <checkout>` reads local Git and forge state through `gh`.
It does not merge, push, fetch, or launch agents. It records repository and head
repository identities, rejects ambiguous active PRs and non-linear chains, and
supports GitHub Enterprise hosts and configured SSH host aliases. Inspect these
reads and their required access before use. `--prs <numbers>` pins the expected
ordered chain. Saved legacy frontiers remain readable.

This helper is optional bookkeeping, not a scheduler, agent dispatcher,
permission system, or replacement for gh-stack's shipping contract. Current-base
evidence, independent review, and explicit publication or merge authority remain
mandatory in the playbooks that require them.

## Run the current statechart compiler

Use `node skills/statechart/scripts/statechart.mjs SPEC.tla` and the options in
the [statechart skill](../skills/statechart/SKILL.md). Its adjacent `worker.mjs`
is bundled from the same current compiler source. Existing Node, POSIX process
supervision, Java, and TLC are still required. A bundle does not provide TLC or
authorize downloads, renderer installation, or execution of untrusted view code.

## Use retained conversion commands

The optional `skills/statechart/scripts/legacy/` directory preserves the earlier
Codex conversion commands and their regression tests. It does not replace the
current compiler. Read the selected command's `--help` before use.

- `chart-to-tla.mjs` generates a TLA+ skeleton, config, and mapping from Mermaid.
- `tlc-to-chart.mjs` draws existing TLC output with a mapping.
- `compare-charts.mjs` compares supported Mermaid machines.
- `statechart.mjs` retains `from-chart`, `from-spec`, fixed-model and agreed-model
  comparisons, mapping-dependency fingerprints, and owned-output inventory rules.

Use new approved scratch directories. The conversion helpers can write files.
Review executable mappings and their imports before running them. Do not equate
a converted chart, replayed fixture, or bounded model pass with product proof.
The current compiler retains its separate new-or-empty output requirement.

## Rebuild and verify

Development builds use the pinned dependencies in the plugin's `package.json`
and lockfile. With installation approval, run `npm ci --ignore-scripts` in the
plugin root, then `npm run build` and `npm run check:bundles`.
The build emits worker, watcher, and compiler bundles plus `bundle-manifest.json`.
Run the retained Bun worker tests and Node helper tests after rebuilding.
Compiler fixture replays test packaging and output, not a new TLC result.
