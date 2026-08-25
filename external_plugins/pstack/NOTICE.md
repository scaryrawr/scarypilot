# pstack attribution and modifications

This plugin is adapted from
[pstack](https://github.com/cursor/plugins/tree/main/pstack) by Lauren Tan.
The imported source was based on upstream commit
`46125561306434d8a1d7745d540d8932ab0cd2a2` and pstack version `0.14.2`.

The original and adapted files are distributed under the MIT License in
[`LICENSE`](./LICENSE).

ScaryPilot changed the integration layer for GitHub Copilot:

- Converted Cursor model, subagent, and background-execution instructions to
  Copilot Task conventions.
- Moved generated project skills and pstack configuration under `.github/`.
- Replaced Cursor transcript paths with scoped Copilot session-history tools.
- Replaced dependencies on Cursor-only built-ins and companion plugins with
  Copilot-native tools or project verification skills.
- Added Copilot review-bot recognition to the PR watcher.
- Removed Cursor transcript scanning from the worktree audit.

The upstream `automations/benny` pack and Cursor-specific guide are not
included. Copilot plugins do not expose Cursor Automations, and shipping those
files unchanged would imply support they do not have.
