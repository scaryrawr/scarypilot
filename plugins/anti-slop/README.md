# Anti-Slop Plugin

Anti-Slop gives Copilot durable guidance for writing precise TypeScript and
JavaScript without requiring each repository to install a linter, add a build
step, or adopt a new dependency.

The skill teaches the reasoning behind Anti-Slop findings and, more
importantly, the preferred alternatives. It emphasizes preserving type
evidence, parsing untrusted values at real I/O boundaries, using named domain
contracts, and avoiding changes that merely hide a lint pattern.

This plugin is advisory. It does not install Oxlint or modify the current
repository. Repositories that need deterministic enforcement can separately
vendor or configure the upstream Anti-Slop rules.

## Prerequisites

- GitHub Copilot CLI with plugin and Agent Skills support.
- No project dependencies or repository configuration are required.

## Installation

```bash
copilot plugin marketplace add scaryrawr/scarypilot
copilot plugin install anti-slop@scarypilot
```

## Usage

Once installed, the skill applies while writing, reviewing, or refactoring
TypeScript and JavaScript. It can also be invoked explicitly:

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

## Optional enforcement

The advisory skill and repository linting are intentionally separate:

- Install this plugin once for agent guidance across repositories.
- Install or vendor
  [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) only in
  repositories that want deterministic diagnostics and CI enforcement.

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
