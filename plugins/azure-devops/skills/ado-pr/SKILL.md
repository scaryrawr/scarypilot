---
name: ado-pr
description: When users share Azure DevOps pull request links or ask about an Azure DevOps PR, inspect and manage the PR with Azure CLI plus the local PR helper script.
compatibility: "Requires Node.js >=22.18, Azure CLI with the azure-devops extension, and Git for checkout flows."
user-invocable: false
---

# Azure DevOps Pull Request Operations

Use this skill for existing Azure DevOps pull requests.

## Script-first workflow

### 1. Resolve PR context

Start with the helper script so you have normalized IDs and branch metadata before composing follow-up commands:

```bash
./scripts/ado-pr.mts context --id {prId} --detect true
```

Use `--org {orgUrl}` instead of `--detect true` when auto-detection is unavailable.

### 2. Retrieve threads

Use the thread helper instead of hand-building the `az devops invoke` call each time:

```bash
./scripts/ado-pr.mts list-threads --id {prId} --status active --detect true
```

Omit `--status` when you need all threads.

### 3. Build thread payloads

Never hand-write review thread JSON when the helper can do it for you:

```bash
./scripts/ado-pr.mts thread-payload \
  --content "Your comment" \
  --file-path /src/path/to/file.ts \
  --line-start 42 \
  --line-end 42 \
  --out-file /tmp/thread.json

az devops invoke --area git --resource pullRequestThreads \
  --route-parameters project={project} repositoryId={repo} pullRequestId={prId} \
  --http-method POST --api-version 7.1-preview \
  --detect true --in-file /tmp/thread.json
```

For top-level comments, omit the file and line flags.

## Common PR commands

Show a PR:

```bash
az repos pr show --id {prId} --detect true
```

List PRs:

```bash
az repos pr list --detect true --status active --output table
```

Checkout a PR locally:

```bash
az repos pr checkout --id {prId}
```

Set a vote:

```bash
az repos pr set-vote --id {prId} --vote approve --detect true
```

Update PR status:

```bash
az repos pr update --id {prId} --status completed --detect true
```

List linked work items:

```bash
az repos pr work-item list --id {prId} --detect true
```

Manage reviewers:

```bash
az repos pr reviewer list --id {prId} --detect true
az repos pr reviewer add --id {prId} --reviewers {email} --detect true
az repos pr reviewer remove --id {prId} --reviewers {email} --detect true
```

Check policy status:

```bash
az repos pr policy list --id {prId} --detect true --output table
```

## Rules

- Use the helper script for context lookup and thread payload generation before falling back to handwritten REST payloads.
- Keep `threadContext` line ranges as small as possible for file-specific comments.
- When `--detect true` fails, rerun with an explicit `--org` value.
