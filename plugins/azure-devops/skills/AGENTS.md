# Azure DevOps Skills Guide

## Scope

This subtree contains marketplace skill Markdown plus the repo's only executable TypeScript helpers (`*.mts`). Root guidance still applies.

## Script Conventions

- Direct Node execution must work on the repo runtime floor: `package.json#engines.node` (`>=22.18.0`). Keep ESM `.mts` patterns compatible with `module: nodenext` and erasable TypeScript syntax.
- Reuse `plugins/azure-devops/skills/shared/azure-devops.mts` when URL, organization, project, repository, payload, or attachment logic overlaps.
- Helper scripts should be non-interactive: structured JSON on stdout, diagnostics on stderr, and useful `--help` output.
- Keep `SKILL.md` examples in sync with skill-local `scripts/` paths.

## Validation

After `.mts` edits, run from the repo root:

```bash
npm install
npm run typecheck
```

When smoke testing scripts that call Azure DevOps, use the full plugin environment and authenticated Azure CLI setup; partial setup is not a valid check.

## Safety

Do not run side-effecting commands such as PR creation, merge/approve, work item updates, attachment uploads, branch changes, commits, or pushes unless the user explicitly requested or confirmed the action. Stop on detected blockers such as detached HEAD, merge conflicts, missing remotes, or unauthenticated Azure CLI state.
