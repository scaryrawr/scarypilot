# Azure DevOps PR Creation

## Safety rules

- Do not perform side effects (`git checkout -b`, `git add`, `git commit`, `git push`, `az repos pr create`) unless the user explicitly asked to create a PR or clearly confirmed the action.
- Stop immediately on detached HEAD, merge conflicts, missing `origin`, or a non-Azure-DevOps `origin` remote.
- Do not rewrite pushed history unless the user explicitly asks.

## Available scripts

Run these non-interactive helpers with `uv run` from the skill directory using the `./scripts/...` paths shown below. The helpers print JSON to stdout and diagnostics to stderr. Run `uv run ./scripts/make-pr.py --help` to confirm flags or subcommands.

### `preflight`

Always start here so you have a structured view of git state, blockers, remote parsing, and default-branch hints:

```text
uv run ./scripts/make-pr.py preflight
```

Use these fields directly:

- `blockers`: stop immediately when non-empty
- `warnings`: surface them, but do not treat them as blockers
- `repoRoot`: run later `git` and `az` commands from this repository root
- `parsedRemote`: source of truth for Azure DevOps org/project/repository context
- `defaultBranch` and `isOnDefaultBranch`: decide whether to reuse the current branch or create a new one
- `statusLines`: summarize uncommitted changes when needed

### `discover-template`

Use the helper instead of manually walking the Azure DevOps template search order:

```text
uv run ./scripts/make-pr.py discover-template --target-branch {target_branch}
```

Use these fields directly:

- `selectedPath`: the chosen template path when one is found
- `selectedContent`: the template body to reuse in the PR description
- `checked`: which paths were examined
- `additionalTemplates`: extra candidates when no single template could be selected automatically

### `upload-attachment`

Use the helper instead of rebuilding token lookup and binary upload flow inline:

```text
uv run ./scripts/make-pr.py upload-attachment --org {org-or-url} --project {project} --repository-id {repositoryId} --pull-request-id {prId} --file {absolute_path_to_image}
```

Use `id`, `url`, `fileName`, and `filePath` from the JSON response.

### `create-pr`

Use the helper when the PR description comes from a template or file. It creates the PR through the Azure DevOps REST API so multiline descriptions are preserved and the 4000-character description limit is checked before submission:

```text
uv run ./scripts/make-pr.py create-pr --org {org-or-url} --project {project} --repository-id {repositoryId} --source-branch "{source_branch}" --target-branch "{target_branch}" --title "<title>" --description-file {absolute_path_to_description}
```

Use `--repository {repoName}` instead of `--repository-id` only when the ID is unavailable. Use `--description "<text>"` for short inline descriptions. Add `--draft` only when the user requested a draft.

## Workflow

1. Run `uv run ./scripts/make-pr.py preflight`.
2. If `blockers` is non-empty, stop and surface them verbatim.
3. Understand the changes from `repoRoot` with `git diff --stat` and targeted `git diff -- path/to/file`.
4. Reuse a non-default current branch unless the user asks to rename or recreate it.
5. If currently on the default branch and a new working branch is needed, check repository guidance first, inspect existing remote branches, derive the user alias from the configured git email local part, follow existing `users/{alias}/{topic}` or `user/{alias}/{topic}` conventions when present, and otherwise fall back to `{alias}/{topic}`.
6. Create focused commits when needed.
7. Push the source branch.
8. Run `discover-template` and reuse `selectedContent` when present.
9. Create the PR with `create-pr` when using template/file descriptions; otherwise `az repos pr create --detect true --source-branch "{source_branch}" --target-branch "{target_branch}" --title "<title>" --description "<description>"` is acceptable for short inline descriptions.
10. If auto-detection fails, use explicit org/project/repository values from `preflight.parsedRemote` or user-supplied inputs.
11. Upload attachments only after PR creation and only when needed.

## PR content rules

- Prefer a ready PR unless the user explicitly requests a draft.
- Use the PR template when one exists.
- Include clear **What**, **Why**, **How**, and **Testing** sections when there is no template.
- Surface branch-policy or permissions failures verbatim instead of masking them.
- Keep example commands shell-neutral: use single-line commands and avoid POSIX-only temp paths, Bash parameter expansion, and shell-specific quoting when a helper can provide structured output.

## Template discovery details

`discover-template` checks branch-specific template paths first, then default template files, then additional template directories.

Use `selectedContent` when it is present. If no template is selected automatically, inspect `checked` to see what was examined, inspect `additionalTemplates` to understand the remaining candidates, and write a manual PR description when there is no unambiguous template to reuse.

## Failure handling

- Stop immediately when `blockers` is non-empty.
- Surface branch-policy and permissions failures verbatim instead of paraphrasing them away.
- When `--detect true` fails, rerun with explicit org/project/repository values from `preflight.parsedRemote` or user-supplied values.
