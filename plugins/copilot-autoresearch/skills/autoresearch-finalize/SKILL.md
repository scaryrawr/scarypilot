---
name: autoresearch-finalize
description: Turn a completed autoresearch session into clean, independently reviewable branches. Use when asked to finalize, clean up, or prepare autoresearch results for review.
---

# Finalize autoresearch

Read `.auto/log.jsonl` (legacy: `autoresearch.jsonl`) and `.auto/prompt.md`.
Consider only experiments whose status is `keep`.

## Analyze

1. Expand every kept short SHA with `git rev-parse`.
2. Discover the repository's trunk branch and compute `git merge-base`.
3. Inspect incremental diffs: `base..<first kept>` and
   `<previous kept>..<next kept>`.
4. Group commits into logical changesets in application order.
5. Merge groups that touch the same file. Independent branches cannot safely
   own overlapping files.
6. Flag cross-file dependencies. Merge tightly coupled groups; otherwise state
   the required landing order.
7. Present proposed branch titles, commits, files, and metric changes. Obtain
   approval before creating branches.

## Execute

Write `.auto/finalize-groups.json`:

```json
{
  "base": "<full merge-base hash>",
  "trunk": "main",
  "final_tree": "<full current HEAD hash>",
  "goal": "short-slug",
  "groups": [
    {
      "title": "Switch to forks pool",
      "body": "Why and what changed.\n\nExperiments: #3, #5\nMetric: 42.3s -> 38.1s (-9.9%)",
      "last_commit": "<full hash of the last kept commit in this group>",
      "slug": "forks-pool"
    }
  ]
}
```

Use full hashes and at least one group. Then run:

```bash
bash <this-skill-directory>/finalize.sh .auto/finalize-groups.json
```

The script validates commit order and file ownership, stashes a dirty worktree,
creates every branch from the merge base, and verifies that cherry-picking all
created branches reproduces the final non-session tree.

Remove `.auto/finalize-groups.json` after success.

## Report

Report:

- each branch and its focused change;
- baseline-to-best metric improvement;
- dependencies and required landing order;
- the script's explicit cleanup commands;
- useful untried entries from `.auto/ideas.md`.

Do not include discarded experiments or unrelated commits. Preserve any
pre-existing dirty work by stashing before branch operations and restoring it
afterward. If creation fails, return to the original branch and remove only
branches created by this finalization attempt.
