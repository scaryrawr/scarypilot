---
name: make-pr
description: Creates a pull request from current changes. Commits changes logically, finds PR templates, and opens the PR using the Azure CLI.
---

You are now in PR creation mode. Your job is to take the current uncommitted changes (or unpushed commits), organize them into logical commits, and create a well-structured pull request.

## Safety Rules

- Do not perform side effects (`git checkout -b`, `git add`, `git commit`, `git push`, `az repos pr create`) unless the user explicitly asked to create a PR or confirms the action.
- If user intent is clear (for example: "create a PR for these changes"), you may proceed without re-confirming every command.
- Stop and ask before proceeding if repository context is ambiguous or unsafe.

Hard stop conditions:

- Detached HEAD
- Merge conflicts present
- No `origin` remote
- `origin` is not an Azure DevOps remote
- Azure auth or permissions failure

## Preflight

```bash
az extension show --name azure-devops
```

If the Azure DevOps extension is missing, install it:

```bash
az extension add --name azure-devops
```

## Workflow

### 1) Check Git State and Remote Context

Get the minimal info needed to proceed:

```bash
# Get branch, status, and remote in one command
git rev-parse --abbrev-ref HEAD && git status --short && git remote get-url origin
```

From the remote URL, extract organization, project, and repository when possible using common URL patterns:

- `https://dev.azure.com/{organization}/{project}/_git/{repository}`
- `https://{organization}.visualstudio.com/{project}/_git/{repository}`

If parsing fails, require explicit user-provided values and pass them directly to `az repos pr create`.

### 2) Understand the Changes

If you already have context from this session about what changed and why, use it. Otherwise, review the changes:

```bash
git diff --stat              # Overview of files changed
git diff -- path/to/file     # Full diff for specific files if needed
```

### 3) Decide the Path by Current State

Choose the correct path:

- **Uncommitted changes exist**: create logical commits first.
- **Commits exist but branch is not pushed**: skip commit creation unless user asks to amend/rework.
- **Branch is already pushed with the intended commits**: skip directly to PR template + PR creation.

Do not rewrite history (rebase/reset/amend) unless branch is not already pushed or user explicitly asks.

### 4) Create a Branch (if needed)

If you are on the default branch (e.g., main/master), create a new branch for your changes, check existing branches for branch naming conventions, and follow them. A user's alias can usually be derived from their email `git config user.email` alias@example.com.

```bash
# Could be user/alias/feature-name, users/alias/feature-name, or feature/feature-name depending on the repo
git checkout -b alias/feature-name
```

Prefer repository-inferred conventions. If no clear convention exists, use a simple descriptive branch name.

### 5) Create Logical Commits (when needed)

Group related changes into logical commits. Each commit should:

- Represent a single logical change
- Have a clear, descriptive message
- Be atomic (could be reverted independently if needed)

When requested to commit, stage intentionally and commit in focused units:

```bash
git add path/to/file
git commit -m "Short, descriptive summary"
```

### 6) Push the Branch

```bash
git push -u origin alias/feature-name
```

If push is rejected due to branch protection, stop and surface the error with next steps.

### 7) Find the PR Template

The pull request template is commonly called `pull_request_template` as a `.txt` or `.md` file, often located in the root of the repository in a `.azuredevops` directory.

Branch specific pull request template that should apply to all pull requests into the `dev` branch would be named `dev.md` or `dev.txt` and located in one of the following locations. (`dev` is the branch name in this example, but could be anything depending on the branch the PR is targeting):

- /.azuredevops/pull_request_template/branches/
- /.vsts/pull_request_template/branches/
- /docs/pull_request_template/branches/
- /pull_request_template/branches/

In addition to the default and branch specific pull request templates, you can find additional pull request templates. These can be `.md` or `.txt` files, located in one of the following folders in your default branch.

- /.azuredevops/pull_request_template/
- /.vsts/pull_request_template/
- /docs/pull_request_template/
- /pull_request_template/

If a template exists, read it and use its structure. If multiple templates exist, choose the most appropriate one based on the change type.

### 8) Generate PR Title and Description

**Title:** Create a concise title that summarizes the PR:

- For single commits: Use the commit message subject
- For multiple commits: Summarize the overall change

**Description:** Generate a comprehensive PR description:

1. If a template exists, fill in each section thoughtfully
2. If no template, create a description with:
   - **What**: High-level summary of changes
   - **Why**: Motivation/context (reference work items if branch name suggests one)
   - **How**: Brief technical approach if non-obvious
   - **Testing**: How the changes were verified

Use the commit messages and diff to write accurate, helpful descriptions.

### 9) Create the PR

The `source_branch` is the branch you pushed.

Target branch resolution order:

1. Explicit target branch from the user
2. Repository default branch
3. If unresolved, stop and ask the user

Default to a **ready PR**. Only use `--draft true` when user explicitly requests a draft PR.

Most `az repos pr` commands require `--org`.

Use explicit org/project/repository when available:

```bash
az repos pr create \
  --org https://dev.azure.com/{organization} \
  --project {project} \
  --repository {repository} \
  --source-branch "{source_branch}" \
  --target-branch "{target_branch}" \
  --title "<title>" \
  --description "## What

<High-level summary of changes>

## Why

<Motivation/context, reference work items if applicable with #itemNumber>

## How

<Brief technical approach if non-obvious>

## Testing

<How the changes were verified>"
```

If org/project/repository defaults are already configured and verified, you may omit `--project` and `--repository`.

### 10) Validate Completion

After creating the PR, verify and report:

- PR was created successfully
- PR ID and URL
- Source and target branches are correct
- Title and description are populated as intended

Optional checks when requested:

- Add reviewers
- Link work items
- Create as draft (or convert later)

## Troubleshooting

### Common Failures

- `az extension show --name azure-devops` fails:
  - Install extension: `az extension add --name azure-devops`
- Authentication errors (`TF401444`, login/session issues):
  - Re-authenticate with Azure CLI and retry
- Permission denied while creating PR:
  - Confirm repo permissions and branch policies with user
- Remote URL is not parseable for org/project/repo:
  - Request explicit values and pass `--org`, `--project`, `--repository`
- Push rejected:
  - Surface branch policy/protection output and ask for preferred next step

### Failure Matrix

| Symptom                                          | Likely Cause                               | Immediate Action                                |
| ------------------------------------------------ | ------------------------------------------ | ----------------------------------------------- |
| `az repos pr create` cannot resolve project/repo | Missing CLI defaults or unparseable remote | Provide explicit `--org --project --repository` |
| PR creation returns auth error                   | Expired or missing Azure auth              | Re-authenticate, then retry                     |
| PR creation returns permission error             | Missing repo/branch permission             | Confirm access and required policy approvals    |
| `git push` rejected                              | Branch protection/policy                   | Stop, report policy message, ask next action    |

## Examples

### Ready PR with explicit target branch

```bash
az repos pr create \
  --org https://dev.azure.com/{organization} \
  --project {project} \
  --repository {repository} \
  --source-branch "alias/feature-name" \
  --target-branch "main" \
  --title "Add Azure DevOps PR preflight checks" \
  --description "## What

Adds preflight validation and safer PR creation flow.

## Why

Reduces failed PR creation attempts and unsafe side effects.

## How

Adds preflight, stop conditions, and troubleshooting guidance.

## Testing

Validated workflow against repository skill conventions."
```

### Draft PR (only when requested)

```bash
az repos pr create \
  --org https://dev.azure.com/{organization} \
  --project {project} \
  --repository {repository} \
  --source-branch "alias/feature-name" \
  --target-branch "main" \
  --draft true \
  --title "WIP: Add Azure DevOps PR preflight checks" \
  --description "<template-filled description>"
```
