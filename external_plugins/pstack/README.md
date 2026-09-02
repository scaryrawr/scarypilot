# pstack for GitHub Copilot

This is a GitHub Copilot adaptation of
[pstack](https://github.com/cursor/plugins/tree/main/pstack), Lauren Tan's
workflow toolkit for writing less, higher-quality code through deliberate
planning, delegation, review, and verification.

## What this plugin provides

- 45 Agent Skills, including `poteto-mode`, `how`, `why`, `architect`,
  `arena`, `swarm`, `interrogate`, `tdd`, `unslop`, and the pstack principles.
- The `poteto-agent` and `comment-sicko` custom agents.
- Native `pstack_status`, capability, plan-validation, verification-receipt,
  handoff, and worktree-inspection tools plus the `/pstack` command.
- PR watching, orchestration, decision-log, and worktree-audit helpers used by
  advanced playbooks.
- Verified multi-phase planning with an executable checklist checker.
- Compatible upstream changes through pstack 0.14.7, with Cursor-only features
  intentionally excluded.
- User-level model configuration through `/setup-pstack`.

## Prerequisites

- GitHub Copilot CLI with plugin and Agent Skills support.
- Git and GitHub CLI for GitHub and PR workflows.
- Bun only for the legacy `poteto-mode` PR watcher and orchestration CLIs.
- Graphite CLI only for playbooks that explicitly use stacked PRs.

The native extension and core skills need no extra runtime. Optional host
capabilities are reported as available, unavailable, or unknown instead of
being assumed.

## Installation

```sh
copilot plugin marketplace add scaryrawr/scarypilot
copilot plugin install pstack@scarypilot
```

## Usage

Invoke a focused skill:

```text
/how explain how authentication flows through this repository
/architect design the boundary for this new cache
/interrogate stress-test this diff
/unslop tighten this PR description
```

Use the full workflow style:

```text
/poteto-mode implement this feature and prove it works
```

Inspect native state and capabilities:

```text
/pstack status
/pstack capabilities
/pstack resume
```

The status tool builds a versioned `PstackSnapshot` from existing orch,
watch-pr, handoff, and Git facts. It is a read-only projection, not another
state database. Verification receipts and handoffs are durable JSON artifacts
under the repository Git state directory. Their schemas live in
[`contracts/`](./contracts/).

Configure Task models across Copilot projects:

```text
/setup-pstack
```

The setup skill writes `instructions/pstack-models.instructions.md` in
`$COPILOT_HOME`, defaulting to `$HOME/.copilot`. Copilot loads this user
instruction across repositories. Without it, pstack lets Copilot select each
Task agent's default model.

## Copilot adaptation

The upstream skills use the Agent Skills format, but their orchestration layer
assumes Cursor-specific model IDs, cloud-agent parameters, transcript paths,
commands, and companion plugins. This adaptation maps those assumptions to
Copilot Task agents, scoped session history, background completion
notifications, `.github/skills/`, and available browser, computer-use,
terminal, and project verification tools.

The native extension centralizes capability detection and deterministic state
access. Host-controlled surfaces such as Task agents, session history, browser
automation, MCP tools, and App sidebar state remain conditional until the host
proves they are available.

Cursor's `automations/benny` pack is not included because Copilot plugins do
not provide the Cursor Automations runtime. See [`NOTICE.md`](./NOTICE.md) for
the exact upstream revision and modification summary.

## License and resources

- Original author: [Lauren Tan](https://github.com/poteto)
- Upstream source:
  [cursor/plugins/pstack](https://github.com/cursor/plugins/tree/main/pstack)
- License: [MIT](./LICENSE)
- Adaptation notes: [NOTICE.md](./NOTICE.md)
