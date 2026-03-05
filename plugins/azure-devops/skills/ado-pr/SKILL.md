---
name: ado-pr
description: When users share Azure DevOps pull request links or ask about PRs, use the Azure DevOps CLI to view, list, checkout, review, vote on, and manage pull requests.
---

# Azure DevOps Pull Request Operations

You have access to an already signed-in Azure CLI with the `azure-devops` extension. Use these commands to interact with Azure DevOps pull requests.

## Organization Detection

Most `az repos pr` commands require an organization URL. When running inside a cloned Azure DevOps repository, use `--detect true` to auto-detect the organization and project from the local git remote — this avoids passing `--org` explicitly.

If auto-detection fails or you're outside a repo, pass `--org {orgUrl}` directly.

## Parsing PR URLs

Extract parameters from common URL patterns:

- `https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{prId}`
- `https://{org}.visualstudio.com/{project}/_git/{repo}/pullrequest/{prId}`

## Inferring User Intent

When a user shares a PR link, infer the action from context:

| Context                          | Likely Action                             |
| -------------------------------- | ----------------------------------------- |
| "review", "comments", "feedback" | Get comment threads                       |
| "what's this PR", "show me"      | Show PR details                           |
| "check out", "work on this"      | Checkout PR branch                        |
| "approve", "complete", "merge"   | Update PR status                          |
| "policies", "checks", "builds"   | List policy evaluations                   |
| No clear intent                  | Show PR summary first, ask what they need |

## Show PR Details

```shell
az repos pr show --id {prId} --detect true
```

Use `--open` to also open the PR in the browser. Use `--output table` for human-readable output.

Extract specific fields with JMESPath:

```shell
# Get just the target branch
az repos pr show --id {prId} --detect true --query "targetRefName" -o tsv

# Get PR title and status
az repos pr show --id {prId} --detect true --query "{title: title, status: status}" -o table
```

## List Pull Requests

```shell
az repos pr list --detect true --status active --output table
```

Filter options:

| Flag                | Description                        |
| ------------------- | ---------------------------------- |
| `--status`          | `active`, `completed`, `abandoned`, `all` |
| `--creator`         | Filter by creator (name or email)  |
| `--reviewer`        | Filter by reviewer (name or email) |
| `--source-branch`   | Filter by source branch            |
| `--target-branch`   | Filter by target branch            |
| `--repository`      | Filter by repo name or ID          |
| `--top`             | Max results to return              |

## Checkout PR Branch

**Note**: This command does NOT require `--org` because it operates on the local git repository.

```shell
az repos pr checkout --id {prId}
```

## Get PR File Changes

Use `az devops invoke` to get the list of files and diffs:

```shell
az devops invoke --area git --resource pullRequests \
  --route-parameters repositoryId={repo} pullRequestId={prId} \
  --detect true --api-version 7.1
```

## Get PR Comment Threads

The CLI lacks a first-class command for threads; use `az devops invoke`:

```shell
az devops invoke --area git --resource pullRequestThreads \
  --route-parameters project={project} repositoryId={repo} pullRequestId={prId} \
  --detect true --api-version 7.1
```

Filter to active/unresolved threads:

```shell
... | jq '.value[] | select(.status == "active")'
```

### Thread Status Values

Valid `status` values for PR comment threads:

| Status       | Meaning                                 |
| ------------ | --------------------------------------- |
| `active`     | Open, needs attention                   |
| `pending`    | Awaiting action                         |
| `fixed`      | Issue has been addressed                |
| `wontFix`    | Intentionally not fixing                |
| `closed`     | Thread closed                           |
| `byDesign`   | Behavior is intentional                 |

## Create PR Comment Thread

Write the JSON body to a temporary file and use `--in-file` to avoid shell escaping issues.

General comment (not attached to a file):

```shell
cat > /tmp/thread.json << 'EOF'
{
  "comments": [{"parentCommentId": 0, "content": "Your comment", "commentType": "text"}],
  "status": "active"
}
EOF

az devops invoke --area git --resource pullRequestThreads \
  --route-parameters project={project} repositoryId={repo} pullRequestId={prId} \
  --http-method POST --api-version 7.1-preview \
  --detect true --in-file /tmp/thread.json
```

File-specific comment (attached to specific lines):

```shell
cat > /tmp/thread.json << 'EOF'
{
  "comments": [{"parentCommentId": 0, "content": "Your comment", "commentType": "text"}],
  "status": "active",
  "threadContext": {
    "filePath": "/path/to/file.js",
    "rightFileStart": {"line": 10, "offset": 0},
    "rightFileEnd": {"line": 15, "offset": 0}
  }
}
EOF

az devops invoke --area git --resource pullRequestThreads \
  --route-parameters project={project} repositoryId={repo} pullRequestId={prId} \
  --http-method POST --api-version 7.1-preview \
  --detect true --in-file /tmp/thread.json
```

## Vote on a PR

```shell
# approve, approve-with-suggestions, wait-for-author, reject, reset
az repos pr set-vote --id {prId} --vote approve --detect true
```

## Update PR Status

```shell
az repos pr update --id {prId} --status completed --detect true
```

Additional update options:

| Flag                      | Description                                          |
| ------------------------- | ---------------------------------------------------- |
| `--status`                | `active`, `completed`, `abandoned`                   |
| `--title`                 | Update PR title                                      |
| `--description`           | Update PR description (supports markdown)            |
| `--auto-complete`         | Set auto-complete when all policies pass              |
| `--squash`                | Squash commits on merge                              |
| `--delete-source-branch`  | Delete source branch after merge                     |
| `--merge-commit-message`  | Custom merge commit message                          |
| `--transition-work-items` | Transition linked work items (e.g. Active → Resolved)|
| `--draft`                 | Toggle draft mode (`true` to draft, `false` to publish)|

## List Linked Work Items

```shell
az repos pr work-item list --id {prId} --detect true
```

## Link / Unlink Work Items

```shell
# Link work items to an existing PR
az repos pr work-item add --id {prId} --work-items {workItemId1} {workItemId2} --detect true

# Unlink a work item from a PR
az repos pr work-item remove --id {prId} --work-items {workItemId} --detect true
```

## Manage Reviewers

```shell
# Add optional reviewers
az repos pr reviewer add --id {prId} --reviewers {email} --detect true

# List current reviewers
az repos pr reviewer list --id {prId} --detect true

# Remove a reviewer
az repos pr reviewer remove --id {prId} --reviewers {email} --detect true
```

## Check Policy Status

List policy evaluations for a PR to see which checks passed or failed:

```shell
az repos pr policy list --id {prId} --detect true --output table
```

Re-trigger a specific policy evaluation:

```shell
az repos pr policy queue --id {prId} --evaluation-id {evaluationId} --detect true
```

## Output Tips

- Use `--output table` for human-readable summaries
- Use `--output json` (default) for programmatic processing
- Use `--query "<JMESPath>"` to extract specific fields
- Pipe JSON output to `jq` for complex filtering
