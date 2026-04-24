---
name: make-pr
description: Creates an Azure DevOps pull request from current changes. Use the helper script for repo preflight, template discovery, and attachment upload before calling Azure CLI.
compatibility: "Requires Node.js >=22.18, Git, and Azure CLI with the azure-devops extension."
---

# Azure DevOps PR Creation

You are in PR creation mode. Create a well-structured Azure DevOps pull request from the current branch state.

## Script execution model

- Run the bundled helpers via the skill-relative paths shown below (`./scripts/...` resolves from this skill directory).
- The helper scripts are non-interactive. Read structured JSON from stdout and treat stderr as diagnostics.
- If you need to confirm flags or subcommands, run `./scripts/make-pr.mts --help`.

## Safety rules

- Do not perform side effects (`git checkout -b`, `git add`, `git commit`, `git push`, `az repos pr create`) unless the user explicitly asked to create a PR or clearly confirmed the action.
- Stop immediately on detached HEAD, merge conflicts, missing `origin`, or a non-Azure-DevOps `origin` remote.
- Do not rewrite pushed history unless the user explicitly asks.

## Available scripts

### `preflight`

Always start here so you have a structured view of git state, blockers, remote parsing, and default-branch hints:

```bash
./scripts/make-pr.mts preflight
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

```bash
./scripts/make-pr.mts discover-template --target-branch {target_branch}
```

Use these fields directly:

- `selectedPath`: the chosen template path when one is found
- `selectedContent`: the template body to reuse in the PR description
- `checked`: which paths were examined
- `additionalTemplates`: extra candidates when no single template could be selected automatically

### `upload-attachment`

Use the helper instead of rebuilding token lookup and binary upload flow inline:

```bash
./scripts/make-pr.mts upload-attachment \
  --org {org-or-url} \
  --project {project} \
  --repository-id {repositoryId} \
  --pull-request-id {prId} \
  --file /absolute/path/to/image.png
```

Use these fields directly:

- `id`: Azure DevOps attachment identifier
- `url`: attachment URL to place in the PR description or a follow-up comment
- `fileName` and `filePath`: confirmation of what was uploaded

## Workflow

### 1. Run preflight

Always begin with:

```bash
./scripts/make-pr.mts preflight
```

If `blockers` is non-empty, stop and surface them verbatim.

### 2. Understand the changes

Use repository context from the current session when available. Otherwise inspect the diff from `repoRoot`:

```bash
git diff --stat
git diff -- path/to/file
```

### 3. Determine the source branch

If the current branch is already a non-default working branch, reuse it unless the user asks to rename or recreate it.

If you are on the default branch (for example `main` or `master`) and need to create a branch, follow repository guidance first, then existing remote naming conventions. See `references/REFERENCE.md` for the detailed fallback rules.

Useful read-only commands when you need to confirm the convention:

```bash
git config user.email
git ls-remote --heads origin
```

Example fallback if no clearer convention exists:

```bash
git checkout -b alias/feature-name
```

### 4. Create commits when needed

Group changes into focused commits:

```bash
git add path/to/file
git commit -m "Short, descriptive summary"
```

### 5. Push the branch

```bash
git push -u origin {source_branch}
```

If push or PR creation fails because of an Azure DevOps branch naming policy, surface the policy failure verbatim and adjust the branch name to match the repository convention.

### 6. Discover the PR template

Run:

```bash
./scripts/make-pr.mts discover-template --target-branch {target_branch}
```

If `selectedContent` is present, use it directly. If no template is selected, fall back to a manually written description.

### 7. Create the PR

Prefer `--detect true` when you are inside the repository:

```bash
az repos pr create \
  --detect true \
  --source-branch "{source_branch}" \
  --target-branch "{target_branch}" \
  --title "<title>" \
  --description "<description>"
```

If auto-detection fails, use explicit org/project/repository values from `preflight.parsedRemote` or user-supplied inputs.

Capture the created PR metadata so later steps can reuse the returned `pullRequestId` and repository details.

### 8. Upload attachments when needed

Use the helper after PR creation when you need an attachment URL:

```bash
./scripts/make-pr.mts upload-attachment \
  --org {org-or-url} \
  --project {project} \
  --repository-id {repositoryId} \
  --pull-request-id {prId} \
  --file /absolute/path/to/image.png
```

Use `preflight.parsedRemote` for `--org`/`--project`, and the PR creation output for `--repository-id`/`--pull-request-id`.

## PR content rules

- Prefer a ready PR unless the user explicitly requests a draft.
- Use the PR template when one exists.
- Include clear **What**, **Why**, **How**, and **Testing** sections when there is no template.
- Surface branch-policy or permissions failures verbatim instead of masking them.
- See `references/REFERENCE.md` for branch naming heuristics, template discovery notes, and attachment usage details.
