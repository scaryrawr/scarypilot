# Anti-Slop Plugin

Anti-Slop gives Copilot durable guidance for writing precise TypeScript and
JavaScript without requiring each repository to install a linter, add a build
step, or adopt a new dependency.

The skill teaches the reasoning behind Anti-Slop findings and the preferred
alternatives. A `preToolUse` hook checks proposed file edits before they are
applied and rejects two high-confidence patterns. After successful edits,
a `postToolUse` hook runs the complete parser-backed Anti-Slop rule set against
the resulting file and advises the agent about findings in newly edited code.
Neither hook modifies repository configuration.

## Prerequisites

- GitHub Copilot CLI with plugin, hooks, and Agent Skills support.
- Node.js 20.19+ (or 22.12+) and npm on the machine running Copilot CLI.
- Registry access the first time the post-edit hook runs, to install pinned
  Oxlint 1.83.0 into the user's Copilot cache. Subsequent runs are offline.
- No project dependencies or repository configuration are required.

## Installation

```bash
copilot plugin marketplace add scaryrawr/scarypilot
copilot plugin install anti-slop@scarypilot
```

## Usage

Once installed, the skill applies while writing, reviewing, or refactoring
TypeScript and JavaScript. The hooks run automatically when Copilot proposes
`apply_patch`, `create`, `edit`, or `str_replace_editor` calls on source files.
The pre-edit hook checks added lines only, and blocks newly introduced chained assertions
(`as unknown as`) and unknown-only type aliases (`type Json = unknown`).
Comments, string literals, generated files, vendor/build output, and files
outside the current workspace are excluded. A denial gives the agent a short
reason and remediation rather than adding guidance to every tool call.

The post-edit hook uses bundled copies of the 18 generic upstream Anti-Slop
rules plus Oxlint's `no-accumulating-spread`, and enables the five optional
Effect rules when the nearest package declares `effect`. It also flags new
generic `value is Record<string, unknown>` predicates (including renamed
`is*Record` helpers) and `is*Record` functions with generic object checks.
It reads the full file to analyze syntax and context, but reports only
diagnostics on the edited lines (and adjacent spacing diagnostics). Output is
bounded to four findings plus a count, returned as `additionalContext`; it
does not block or rewrite the successful tool result. A real I/O boundary
can legitimately use a guard, so the agent must judge the finding in context.
Existing findings do not trigger repeated advice on unrelated edits.

The skill can also be invoked explicitly:

- "Use anti-slop while implementing this."
- "Review this change for low-evidence TypeScript patterns."
- "Unslop this module without adding wrapper guards."
- "Fix these Anti-Slop findings at their actual boundaries."

The skill directs the agent to:

1. Preserve precise inferred and schema-derived types.
2. Parse external data once at its I/O boundary.
3. Prefer dependency injection over module mocking.
4. Replace assertion chains and open dictionaries with concrete contracts.
5. Avoid generic wrappers, `any`, or trivial guards created only to silence a
   diagnostic.
6. Use repository lint tooling when present without onboarding tooling unless
   the user asks for it.

For repositories without Anti-Slop tooling, the skill also includes a
dependency-free, read-only heuristic scanner:

```bash
node scripts/scan.mjs [paths...]
```

The scanner identifies a deliberately small set of high-confidence candidates,
supports JSON output, and skips conventional generated and build-output
directories. Repeat `--ignore DIR` to exclude repository-specific output such
as `lib` or `packages/api/generated`; ambiguous directory names are not ignored
by default. It is a review aid, not a replacement for parser-backed linting.

## Scope and enforcement

Installing the standalone plugin opts into its hooks across CLI workspaces.
Pstack's `/deslop` remains a separate, general code-cleanup skill and does
not install or run Anti-Slop. Disable the standalone plugin with
`copilot plugin disable anti-slop` to stop its hooks and skill. Neither hook
intercepts shell-written files or edits from other tools. Copilot cloud agent
jobs do not load installed local plugins. Only the two pre-edit patterns above
block edits; the complete Oxlint checks are advisory and cannot undo a write.
The skill's separate dependency-free scanner covers a smaller heuristic
subset for read-only use.

Plugin hook scripts run relative to `${PLUGIN_ROOT}` so installation paths
need no repository-specific setup. The first post-edit check downloads Oxlint
into `$COPILOT_HOME/anti-slop/` (or `~/.copilot/anti-slop/`), never into the
target repository. If it cannot run, the agent receives an explicit failure
message rather than a claim that the file is clean. Repositories needing
deterministic CI enforcement can separately install or vendor
[dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop).

## Maintaining the bundled rules

After changing the vendored rules in `tools/oxlint/anti-slop/`, run
`npm run build:anti-slop` and commit the generated `dist/` bundles. This
builds both the generic and optional Effect rule sets. The runtime installs
only the platform-appropriate native Oxlint package; it does not run a
repository build or install packages in a user's project.

## Validating agent behavior

The hook tests check detection and feedback delivery. The paired behavioral
eval in [`evals/`](evals/README.md) runs the same scratch task with and without
hooks, grades the resulting code, and records whether feedback actually
reached the agent. Use multiple repetitions to evaluate recovery, false
positive rewrites, and changes in task completion.

## Attribution

This guidance is adapted from the rule set and remediation philosophy in
[dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), reviewed at commit
`c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`. The upstream project is Copyright
(c) 2026 Dillon Mulroy and licensed under the MIT License. See
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

This plugin was imported into this branch from the ScaryPilot source snapshot
`be2124bd00fd82a9b8274fdc4a1429d6e7034d34`; that repository revision is
distinct from the upstream Anti-Slop revision above.

## Resources

- [Upstream Anti-Slop project](https://github.com/dmmulroy/anti-slop)
- [Agent Skills specification](https://agentskills.io/specification)
- [Creating a plugin for GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-creating)
