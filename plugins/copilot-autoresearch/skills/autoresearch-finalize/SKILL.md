---
name: autoresearch-finalize
description: Turn a completed autoresearch session into clean, independently reviewable branches. Use when asked to finalize, clean up, or prepare autoresearch results for review.
---

# Finalize autoresearch

Read `.auto/log.jsonl` (legacy: `autoresearch.jsonl`) and `.auto/prompt.md`.
Consider only experiments whose status is `keep`.

1. Expand every kept short SHA with `git rev-parse`.
2. Find the merge base with the repository’s trunk branch.
3. Inspect each kept commit’s incremental diff and group commits into logical
   changesets in application order.
4. No two groups may touch the same file. Merge overlapping or tightly
   dependent groups.
5. Present the proposed branches, files, commits, and metric changes to the
   user and obtain approval before rewriting history or creating branches.
6. Write `.auto/finalize-groups.json` with `base`, `trunk`, `final_tree`, `goal`,
   and a `groups` array containing `title`, `body`, `last_commit`, and `slug`.
7. Run
   `bash <this-skill-directory>/finalize.sh .auto/finalize-groups.json`. The script
   validates ordering and file overlap, preserves a dirty worktree, creates
   each branch from the merge base, and verifies that their union reproduces
   the final kept tree.
8. Remove `.auto/finalize-groups.json`, then report created branches, overall
   metric improvement, dependencies, and explicit cleanup commands.

Do not include discarded experiments or unrelated commits. Preserve any
pre-existing dirty work by stashing before branch operations and restoring it
afterward. If creation fails, return to the original branch and remove only
branches created by this finalization attempt.
