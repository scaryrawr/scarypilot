# Worktrunk Plugin

Disk-aware parallel worktree workflows for GitHub Copilot using [Worktrunk](https://worktrunk.dev/) (`wt`).

## What This Plugin Does

- Creates and manages worktrees with `wt` for parallel agent tasks
- Enforces a preflight disk-fit check before creating a new worktree
- Estimates worktree + dependency + build-output footprint for Node, Python, and Go projects
- Hard-blocks worktree creation when estimated usage does not fit available disk space
- Promotes chunk-based workflows so each worktree can be committed independently

## Prerequisites

- **Worktrunk (`wt`)** must be installed
  - macOS/Linux (Homebrew): `brew install worktrunk && wt config shell install`
  - Cargo: `cargo install worktrunk && wt config shell install`
- Git repository with worktree workflow enabled

## Installation

```bash
copilot plugin marketplace add scaryrawr/scarypilot
copilot plugin install worktrunk@scarypilot
```

## Usage Examples

```text
"Create a new worktrunk worktree for chunk auth-session with a disk preflight check first"
"Split this feature into 3 independently committable chunks and create one worktree per chunk"
"Show remaining disk space versus estimated footprint before creating a new worktree"
```

## Included Helper Scripts

- `skills/worktrunk/scripts/estimate-worktree-footprint.sh`
  - Emits machine-readable `key=value` estimates for projected worktree footprint.
- `skills/worktrunk/scripts/check-disk-fit.sh`
  - Emits machine-readable capacity results and exits non-zero when a new worktree would not fit.

## Resources

- [Worktrunk documentation](https://worktrunk.dev/)
- [wt switch](https://worktrunk.dev/switch/)
- [wt list](https://worktrunk.dev/list/)
- [wt remove](https://worktrunk.dev/remove/)
