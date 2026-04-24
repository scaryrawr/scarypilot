---
name: review-pr
description: Review an Azure DevOps pull request. Use the helper script for eligibility checks, thread payloads, label sync, code links, and attachment uploads.
compatibility: "Requires Node.js >=22.18, Git, and Azure CLI with the azure-devops extension."
---

# Azure DevOps PR Review

Provide a code review for the given Azure DevOps pull request.

## Script execution model

- Run the bundled helpers via the skill-relative paths shown below (`./scripts/...` resolves from this skill directory).
- The helper scripts are non-interactive. Read structured JSON from stdout and treat stderr as diagnostics.
- If you need to confirm flags or subcommands, run `./scripts/review-pr.mts --help`.

## Available scripts

### `eligibility`

Start here before reviewing:

```bash
./scripts/review-pr.mts eligibility --id {prId} --detect true
```

Use these fields directly:

- `eligible`, `status`, `isDraft`
- `sourceBranch`, `targetBranch` (Azure refs like `refs/heads/main`)
- `repositoryId`, `repositoryName`
- `projectId`, `projectName`
- `reviewers`, `url`

Skip review when `eligible` is false.

### `thread-payload`

Use the helper instead of hand-writing review thread JSON:

```bash
./scripts/review-pr.mts thread-payload \
  --content "<brief issue title>\n\n<why it matters>\n\n<actionable fix>\n\n🤖 Generated with AI" \
  --file-path /src/path/to/file.ts \
  --line-start 42 \
  --line-end 42 \
  --out-file /tmp/review-thread.json
```

If you pass `--out-file`, the script returns `{ outFile, payload }`; otherwise it returns the payload directly.

### `sync-labels`

Use the helper after the review is complete:

```bash
./scripts/review-pr.mts sync-labels \
  --id {prId} \
  --model gpt-5.4 \
  --model claude-opus-4.6 \
  --detect true
```

Use `desiredLabels`, `addedLabels`, `removedLabels`, and `finalLabels` from the JSON result.

### `code-link`

Build Azure DevOps code links with:

```bash
./scripts/review-pr.mts code-link \
  --org {org-or-url} \
  --project {project} \
  --repo {repo} \
  --commit {fullCommitSha} \
  --file-path /src/path/to/file.ts \
  --line-start 40 \
  --line-end 44
```

The script returns `{ url }`.

### `upload-attachment`

Upload PR attachments with:

```bash
./scripts/review-pr.mts upload-attachment \
  --org {org-or-url} \
  --project {project} \
  --repository-id {repositoryId} \
  --pull-request-id {prId} \
  --file /absolute/path/to/image.png
```

Use `id` and `url` from the JSON result.

## Workflow

1. **Check eligibility** with the helper script before reviewing:

   ```bash
   ./scripts/review-pr.mts eligibility --id {prId} --detect true
   ```

   Skip review when the PR is not active or is a draft.

2. **Gather context**:
    - Identify relevant instruction files such as `.github/copilot-instructions.md`, `AGENTS.md`, and `CLAUDE.md` in affected directories.
    - Reuse `targetBranch`, `projectName`, and `repositoryId` from the `eligibility` output instead of immediately re-querying them.
    - Check out the PR branch locally: `az repos pr checkout --id {prId}`
    - Strip the `refs/heads/` prefix before using `targetBranch` as a git ref, then generate the diff: `git diff "origin/${targetBranch#refs/heads/}"...HEAD`

3. **Review the changes**:
   - Prefer relevant specialist agents when they match the technologies in the diff.
   - Use multiple independent review passes when practical.
   - Deduplicate overlapping findings before presenting or posting them.
   - Focus on bugs, explicit instruction-file violations, history/blame signals, and changed-line issues.

4. **Validate issues**:
   - Post only high-confidence findings.
   - Ignore style-only nits, pre-existing issues, CI-only issues, and unmodified-line complaints.

5. **Confirm before posting** unless the user explicitly asked you not to confirm.

6. **Post inline comments**:
    - Post one thread per issue.
    - Use the exact file and line range.
    - Prefer a single-line range when possible.
    - Build payloads with `thread-payload` before posting.
    - Post them with:

      ```bash
      az devops invoke --area git --resource pullRequestThreads \
        --route-parameters project={projectName} repositoryId={repositoryId} pullRequestId={prId} \
        --http-method POST --api-version 7.1-preview \
        --detect true --in-file /tmp/review-thread.json
      ```

    Determine line numbers from the right side of the diff (`+` side), then verify against the checked-out file.

7. **Sync review labels** after the review completes:

   Always include `ai-reviewed` plus one `ai-model-<model-id>` label per model used.

## No-issues case

If no issues are found, post one short top-level comment:

```markdown
### Code review

No issues found. Checked for bugs and instruction file compliance.

🤖 Generated with AI
```

## Helper commands
- Reuse `code-link` for file-specific references in comments or summaries.
- Reuse `upload-attachment` when the review needs screenshots or other uploaded artifacts.
