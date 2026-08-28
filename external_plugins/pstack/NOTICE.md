# pstack attribution and modifications

This plugin is adapted from
[pstack](https://github.com/cursor/plugins/tree/main/pstack) by Lauren Tan.
The adaptation originally imported upstream commit
`46125561306434d8a1d7745d540d8932ab0cd2a2` and includes the compatible
changes through upstream commit
`bdf7aa355337897f167153e05069aca505dae17c` (pstack version `0.14.3`).
The package metadata tracks upstream pstack `0.14.5`; its intervening
`make-bot-ui` feature
(`799151d91b6e12ee7dbd09f708eec108d7de9b3b` and
`6fecddba65801f9b9c08b8b328d998ee5b09d290`) remains excluded because it
depends on Cursor-only routines, secret-request cards, and UI behavior.

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

The upstream `automations/benny` pack and Cursor-specific guide are not
included. Copilot plugins do not expose Cursor Automations, and shipping those
files unchanged would imply support they do not have.
