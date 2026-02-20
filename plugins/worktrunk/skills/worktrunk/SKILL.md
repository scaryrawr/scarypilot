---
name: worktrunk
description: Manage parallel git worktrees with Worktrunk (`wt`) and enforce disk-fit preflight checks before creating new worktrees.
---

# Worktrunk Skill

Use this skill when users need to parallelize work into independent chunks using git worktrees managed by `wt`.

## Core commands

- `wt switch --create <chunk-branch>` (or `wt switch -c <chunk-branch>`) to create and switch to a new worktree
- `wt switch <chunk-branch>` to switch to an existing worktree
- `wt list` to inspect all managed worktrees
- `wt remove` to clean up the current worktree and branch when finished

## Mandatory preflight before creation

Before any `wt switch --create ...` command, run:

```bash
skills/worktrunk/scripts/check-disk-fit.sh -p .
```

Rules:
- If `fits=false` or the script exits non-zero, **do not create the worktree**.
- Report `estimated_total_bytes`, `free_bytes`, `safety_margin_bytes`, and `required_bytes` to the user.
- Only proceed with `wt switch --create ...` when the check exits 0.

For estimate-only requests (without creation), run:

```bash
skills/worktrunk/scripts/estimate-worktree-footprint.sh -p .
```

## Chunking guidance for parallel agents

- Split requests into narrowly scoped chunks that can be reviewed and merged independently.
- Use one branch/worktree per chunk, with clear names (e.g., `feat-auth-token-refresh`).
- Avoid overlapping edits across active chunks when possible to reduce merge conflicts.
- Keep each chunk shippable: code + tests/docs relevant to that chunk.

## Parallel execution pattern

1. Define chunk list and naming.
2. For each chunk: run disk preflight check, then create worktree.
3. Launch agent work in each chunked worktree.
4. Review and commit each chunk independently.
5. Merge and clean up completed chunks with `wt remove`.

## Prerequisite checks

Before using `wt`, verify:

```bash
command -v wt >/dev/null 2>&1
wt --help >/dev/null
```

If `wt` is missing, instruct the user to install Worktrunk first.
