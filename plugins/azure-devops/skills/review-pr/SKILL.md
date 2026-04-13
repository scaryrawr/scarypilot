---
name: review-pr
description: Review an Azure DevOps pull request. Use the helper script for eligibility checks, thread payloads, label sync, code links, and attachment uploads.
compatibility: "Requires Node.js >=22.18, Git, and Azure CLI with the azure-devops extension."
---

# Azure DevOps PR Review

Provide a code review for the given Azure DevOps pull request.

## Workflow

1. **Check eligibility** with the helper script before reviewing:

   ```bash
   ./scripts/review-pr.mts eligibility --id {prId} --detect true
   ```

   Skip review when the PR is not active or is a draft.

2. **Gather context**:
   - Identify relevant instruction files such as `.github/copilot-instructions.md`, `AGENTS.md`, and `CLAUDE.md` in affected directories.
   - Get the target branch: `az repos pr show --id {prId} --detect true --query "targetRefName" -o tsv`
   - Check out the PR branch locally: `az repos pr checkout --id {prId}`
   - Generate the diff: `git diff origin/{targetBranch}...HEAD`

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
   - Build payloads with the helper script instead of writing heredocs manually:

   ```bash
   ./scripts/review-pr.mts thread-payload \
     --content "<brief issue title>\n\n<why it matters>\n\n<actionable fix>\n\n🤖 Generated with AI" \
     --file-path /src/path/to/file.ts \
     --line-start 42 \
     --line-end 42 \
     --out-file /tmp/review-thread.json

   az devops invoke --area git --resource pullRequestThreads \
     --route-parameters project={project} repositoryId={repo} pullRequestId={prId} \
     --http-method POST --api-version 7.1-preview \
     --detect true --in-file /tmp/review-thread.json
   ```

   Determine line numbers from the right side of the diff (`+` side), then verify against the checked-out file.

7. **Sync review labels** after the review completes:

   ```bash
   ./scripts/review-pr.mts sync-labels \
     --id {prId} \
     --model gpt-5.4 \
     --model claude-opus-4.6 \
     --detect true
   ```

   Always include `ai-reviewed` plus one `ai-model-<model-id>` label per model used.

## No-issues case

If no issues are found, post one short top-level comment:

```markdown
### Code review

No issues found. Checked for bugs and instruction file compliance.

🤖 Generated with AI
```

## Helper commands

Build an Azure DevOps code link:

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

Upload a PR attachment:

```bash
./scripts/review-pr.mts upload-attachment \
  --org {org-or-url} \
  --project {project} \
  --repository-id {repositoryId} \
  --pull-request-id {prId} \
  --file /absolute/path/to/image.png
```
