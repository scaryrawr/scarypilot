### Worktree and simulator cleanup

**You own the disk and the safety gate.** Prune merged or abandoned git worktrees and stale iOS simulators to reclaim space. Deletion is irreversible, so every step guards against deleting something in use or holding uncommitted work.

1. Snapshot and audit. Record disk usage, then invoke the POSIX helper with `bash "<absolute-skill-path>/scripts/worktree-audit.sh" --base <local-base-ref>` to select a known base; otherwise it detects the locally recorded remote default and conventional fallback refs without fetching. It derives paths from `git worktree list` and performs no deletion. A missing base is an error, not a reason to fetch or assume `main`. On a host without a POSIX shell, inspect equivalent read-only Git facts with the available tools or report the audit blocked.
2. The disposition is advice, not permission. The helper cannot prove active Copilot session use or App sidebar state. When scoped session or App tools are available, query them and cross-check every candidate. Otherwise get the active or pinned set from the user before deletion.
3. Verify usage before deleting. Do not assume transcript files or sidebar access exists. Use scoped session-history tools only when the current host exposes them. A session may spawn arena and repro trees into sibling worktrees, so any unresolved ownership keeps the worktree held.
4. Pause on irreversible loss. `wip:N` is N tracked uncommitted edits. Show the diff and get a decision first, since removing a clean worktree is recoverable from its branch but uncommitted work is gone. `scratch:N` is untracked throwaway, safe to drop, but name the files. Per Autonomy, clean and merged and not-in-use proceeds. `wip` and in-use pause.
5. Prune the confirmed set. Per path, `git worktree remove --force <path>`. If the dir survives on ignored build artifacts, `rm -rf` it, then `git worktree prune`. Branch refs survive, so no commits are lost. Confirm with `df -h /` and re-list.
6. Simulators and other reclaimers. Simulators are usually the next-biggest win. `xcrun simctl --set testing delete all` (XCTestDevices clones), `xcrun simctl delete unavailable`, and `xcrun simctl runtime list` then `runtime delete <id>` for old runtimes. More when needed: Xcode `DerivedData` and `iOS DeviceSupport`, then package caches such as pnpm, uv, brew, and yarn. Clear only caches the user has not said to keep.

This is the one playbook that deletes user state with no code review to catch a slip, so the gates above are the review.

**Reply:** `df -h /` before and after with space reclaimed, the worktrees pruned, and a one-line reason for each held back (in-use by which chat, or uncommitted work).
