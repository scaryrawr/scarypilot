# make-pr reference

## Run follow-up commands from the preflight repo root

`preflight` returns `repoRoot`. Use that as the working directory for later `git` and `az` commands so branch state, template discovery, and `--detect true` all run against the same repository.

## Branch naming fallback when starting from the default branch

If the current branch matches the default branch and a new working branch is needed:

1. Check repository guidance first.
2. Inspect existing remote branches to infer the naming convention already in use.
3. For Azure DevOps repositories, derive the user alias from the configured git email local part.
4. If the repository already uses `users/{alias}/{topic}` or `user/{alias}/{topic}`, follow that convention.
5. If no clearer convention exists, fall back to `{alias}/{topic}`.

Useful read-only commands:

```bash
git config user.email
git ls-remote --heads origin
```

## Template discovery details

`discover-template` checks branch-specific template paths first, then default template files, then additional template directories.

Use `selectedContent` when it is present. If no template is selected automatically:

- inspect `checked` to see what was examined
- inspect `additionalTemplates` to understand the remaining candidates
- write a manual PR description when there is no unambiguous template to reuse

## Attachment usage notes

`upload-attachment` requires:

- `--org` and `--project`, which usually come from `preflight.parsedRemote`
- `--repository-id` and `--pull-request-id`, which usually come from the PR creation output
- an absolute path for `--file`

Use the returned `url` in the PR description or a follow-up PR comment.

## Failure handling

- Stop immediately when `blockers` is non-empty.
- Surface branch-policy and permissions failures verbatim instead of paraphrasing them away.
- When `--detect true` fails, rerun with explicit org/project/repository values from `preflight.parsedRemote` or user-supplied values.
