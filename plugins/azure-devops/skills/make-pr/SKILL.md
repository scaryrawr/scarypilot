---
name: make-pr
description: Creates an Azure DevOps pull request from current changes. Use the helper script for repo preflight, template discovery, and attachment upload before calling Azure CLI.
compatibility: "Requires Node.js >=22.18, Git, and Azure CLI with the azure-devops extension."
---

# Azure DevOps PR Creation

You are in PR creation mode. Create a well-structured Azure DevOps pull request from the current branch state.

## Safety rules

- Do not perform side effects (`git checkout -b`, `git add`, `git commit`, `git push`, `az repos pr create`) unless the user explicitly asked to create a PR or clearly confirmed the action.
- Stop immediately on detached HEAD, merge conflicts, missing `origin`, or a non-Azure-DevOps `origin` remote.
- Do not rewrite pushed history unless the user explicitly asks.

## Script-first workflow

### 1. Run preflight

Always start with the helper script so you get a structured view of git state, blockers, remote parsing, and default-branch hints:

```bash
./scripts/make-pr.mts preflight
```

If `blockers` is non-empty, stop and surface them.

### 2. Understand the changes

Use repository context from the current session when available. Otherwise inspect the diff:

```bash
git diff --stat
git diff -- path/to/file
```

### 3. Determine the source branch

If the current branch is already a non-default working branch, reuse it unless the user asks to rename or recreate it.

If you are on the default branch (for example `main` or `master`) and need to create a branch:

- Check repository guidance first and follow any documented branch naming policy.
- Inspect existing remote branches to infer the convention the repo already uses.
- For Azure DevOps repos, derive the user's alias from the configured git email by taking the part before `@`.
- If the repo has a clear convention like `users/{alias}/{topic}` or `user/{alias}/{topic}`, follow it.
- If no clearer repository convention exists, default to `{alias}/{topic}` for Azure DevOps.

Useful read-only commands:

```bash
git config user.email
git ls-remote --heads origin
```

Example fallback:

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

Use the helper script instead of manually walking the Azure DevOps template search order:

```bash
./scripts/make-pr.mts discover-template --target-branch {target_branch}
```

The script checks branch-specific templates first, then default templates, then additional template folders.

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

If auto-detection fails, use explicit org/project/repository values.

### 8. Upload attachments when needed

Use the helper script instead of reconstructing the token + binary upload flow:

```bash
./scripts/make-pr.mts upload-attachment \
  --org {org-or-url} \
  --project {project} \
  --repository-id {repositoryId} \
  --pull-request-id {prId} \
  --file /absolute/path/to/image.png
```

## PR content rules

- Prefer a ready PR unless the user explicitly requests a draft.
- Use the PR template when one exists.
- Include clear **What**, **Why**, **How**, and **Testing** sections when there is no template.
- Surface branch-policy or permissions failures verbatim instead of masking them.
