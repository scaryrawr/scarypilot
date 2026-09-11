# pstack attribution and modifications

This plugin is adapted from
[pstack](https://github.com/cursor/plugins/tree/main/pstack) by Lauren Tan.
The adaptation originally imported upstream commit
`46125561306434d8a1d7745d540d8932ab0cd2a2` and had included the compatible
changes through upstream repository commit
`7366ac128bdf95f45e6734f412b49a4031800169` (pstack version `0.15.1`). The
last commit in that range that changes the `pstack/` subtree is
`f8abeddd1862dc73704e3d719dd73df0d51b8c71`.

The reviewed range starts after
`23a56e2dac2efd54788056db8eced26e371d7b5e`, the last upstream content commit
included by the previous Copilot adaptation. The machine-readable boundary,
ownership rules, and exclusions live in [`upstream-sync.json`](./upstream-sync.json).

The `make-bot-ui` feature remains excluded because it depends on Cursor-only
routines, secret-request cards, and UI behavior. Cursor's `automations/benny`
pack and marketplace logo are also excluded. The upstream
`disable-model-invocation` guard is not carried into Copilot because Copilot
filters guarded skills from its model-facing skill tool.

The original and adapted files are distributed under the MIT License in
[`LICENSE`](./LICENSE).

ScaryPilot changed the integration layer for GitHub Copilot:

- Converted Cursor model, subagent, and background-execution instructions to
  Copilot Task conventions.
- Moved generated project skills under `.github/` and pstack's user-level
  configuration into Copilot home.
- Replaced Cursor transcript paths with scoped Copilot session-history tools.
- Replaced dependencies on Cursor-only built-ins and companion plugins with
  Copilot-native tools or project verification skills.
- Added Copilot review-bot recognition to the PR watcher.
- Removed Cursor transcript scanning from the worktree audit.
- Ported upstream's verified multi-PR checklist and added a Copilot-compatible
  plan checker.
- Added a native Copilot extension with versioned projected status, capability
  reporting, structured verification receipts, durable handoffs, plan
  profiles, and read-only worktree inspection.
- Added versioned JSON contracts and trigger evals for Copilot-specific
  workflow surfaces.
- Bundled the `deslop` skill from
  [cursor-team-kit](https://github.com/cursor/plugins/tree/main/cursor-team-kit).
- Added an executable sync checker that validates upstream provenance,
  exclusions, inventory, links, extension registration, and model-callable
  skill metadata.

The upstream guide is included with Copilot-specific installation, agent,
automation, path, and verification instructions. Cursor-only screenshots and
unsupported runtime promises are omitted.
