---
name: review-pr
description: Code review an Azure DevOps pull request
---

Provide a code review for the given Azure DevOps pull request.

## Workflow

1. **Check Eligibility**: Use `az repos pr show --id {prId} --detect true` to verify the PR is open, not a draft, and hasn't been reviewed by you already. Skip if ineligible.

2. **Get Context**: Identify relevant instruction files: the root-level `.github/copilot-instructions.md` (if present under `.github/`), plus any `AGENTS.md` or `CLAUDE.md` files found in modified directories and their ancestor directories. Then get the PR diff using git commands:
   - First, use `az repos pr show --id {prId} --detect true --query "targetRefName" -o tsv` to get the target branch name
   - Then fetch and switch to the PR branch: `az repos pr checkout --id {prId}` (note: checkout does NOT require `--org` as it operates on the local git repository)
   - Generate the diff: `git diff origin/{targetBranch}...HEAD`
   - **Note**: These commands will only work when executed in the same git repository as the PR.
   - Optionally check policy status: `az repos pr policy list --id {prId} --detect true --output table`

3. **Review the Changes**:
   - Prefer available custom agents that match the technologies or risk areas in the PR (for example: React/UI, Angular, performance, accessibility, testing, security, or API specialists).
   - Use multiple independent review passes with different models. At minimum, run one pass with `gpt-5.4` and one pass with `claude-opus-4.6`.
   - If a relevant specialist agent is available, use it in addition to a general review agent rather than replacing the general pass entirely.
   - If no relevant custom agent exists for part of the diff, fall back to the best available general review/code-review agent for that area.
   - Deduplicate overlapping findings from different agents/models before presenting or posting them.
   - Review the PR for:
     - Compliance with instruction files (GitHub Copilot instructions, AGENTS.md, CLAUDE.md — only applicable instructions)
     - Obvious bugs in the changes themselves
     - Issues revealed by git history/blame
     - Patterns from previous PRs on these files
     - Violations of code comments/guidance

4. **Validate Issues**: For each potential issue, assess confidence (0-100 scale). Filter to only high-confidence issues (80+):
   - **0-25**: False positive or stylistic preference not in instruction files
   - **50**: Real but minor issue
   - **75**: Important issue affecting functionality or explicitly mentioned in instruction files
   - **100**: Definite issue that will cause problems

5. **Post Review**: If high-confidence issues found:

   a. **Confirm with User**: Ask the user to confirm before posting comments to the PR, unless they explicitly requested not to confirm. Present a summary of the issues you found and ask if they should be posted.

   b. **Post Inline Comments (Required)**: After user confirmation, post **one thread per issue** on the **exact file and line range** where the issue appears. Do not post only a single aggregated summary when issues exist. Write each thread body to a temporary file and use `az devops invoke` with `--in-file` to avoid shell escaping issues:

   ```shell
   cat > /tmp/review-thread.json << 'REVIEW_EOF'
   {
     "comments": [
       {
         "parentCommentId": 0,
         "content": "<Issue summary + why it matters + actionable fix>",
         "commentType": "text"
       }
     ],
     "status": "active",
     "threadContext": {
       "filePath": "/src/path/to/file.ext",
       "rightFileStart": { "line": 42, "offset": 1 },
       "rightFileEnd": { "line": 42, "offset": 1 }
     }
   }
   REVIEW_EOF

   az devops invoke --area git --resource pullRequestThreads \
     --route-parameters project={project} repositoryId={repo} pullRequestId={pr} \
     --http-method POST --api-version 7.1-preview \
     --detect true --in-file /tmp/review-thread.json
   ```

   For line-specific comments, `threadContext` is required and must include `filePath`, `rightFileStart`, and `rightFileEnd` with precise line numbers. Prefer the smallest relevant range (single line when possible).

   Valid thread `status` values: `active`, `fixed`, `wontFix`, `closed`, `byDesign`, `pending`.

6. **Tag the PR as AI-reviewed**: After finishing the review (whether or not issues were found), add PR labels that indicate AI review completion and which model(s) were used.

   Azure DevOps shows these in the UI as **Tags**, but the REST API calls them **labels**. Don't use `az repos pr update` here: it can set `--labels` during PR creation, but it does **not** support updating labels on an existing PR. Use the Pull Request Labels REST API instead.

   ```bash
   # Replace with the actual model IDs used for this review run.
   MODEL_IDS=("gpt-5.4" "claude-opus-4.6")
   LABELS=("ai-reviewed")
   for model in "${MODEL_IDS[@]}"; do
     LABELS+=("ai-model-${model}")
   done

   PROJECT_ID=$(az repos pr show \
     --id {prId} \
     --detect true \
     --query "repository.project.id" -o tsv)
   REPOSITORY_ID=$(az repos pr show \
     --id {prId} \
     --detect true \
     --query "repository.id" -o tsv)

   TOKEN=$(az account get-access-token \
     --resource 499b84ac-1321-427f-aa17-267ca6975798 \
     --query accessToken -o tsv)

   EXISTING_LABELS=$(curl -sS \
     -H "Authorization: Bearer ${TOKEN}" \
     "https://dev.azure.com/{organization}/${PROJECT_ID}/_apis/git/repositories/${REPOSITORY_ID}/pullRequests/{prId}/labels?api-version=7.1" \
     | python3 -c 'import json,sys; print("\n".join(label["name"] for label in json.load(sys.stdin)))')

   for label in "${LABELS[@]}"; do
     if ! grep -Fxq "$label" <<< "${EXISTING_LABELS}"; then
       cat > /tmp/pr-label.json << EOF
   {"name":"${label}"}
   EOF

       curl -sS -X POST \
         -H "Authorization: Bearer ${TOKEN}" \
         -H "Content-Type: application/json" \
         --data-binary @/tmp/pr-label.json \
         "https://dev.azure.com/{organization}/${PROJECT_ID}/_apis/git/repositories/${REPOSITORY_ID}/pullRequests/{prId}/labels?api-version=7.1" \
         > /dev/null
     fi
   done

   curl -sS \
     -H "Authorization: Bearer ${TOKEN}" \
     "https://dev.azure.com/{organization}/${PROJECT_ID}/_apis/git/repositories/${REPOSITORY_ID}/pullRequests/{prId}/labels?api-version=7.1" \
     | python3 -c 'import json,sys; print("\n".join(label["name"] for label in json.load(sys.stdin)))'
   ```

   - Always include the `ai-reviewed` label.
   - Add one `ai-model-<model-id>` label per model used (including sub-agents, if any).
   - Use the exact model IDs (for example: `gpt-5.4`, `claude-opus-4.6`).
   - Verify the final GET output contains the labels you added.

## Avoid False Positives

- Pre-existing issues not introduced by this PR
- Linter/typechecker/compiler issues (handled by CI)
- Pedantic nitpicks not explicitly in instruction files
- Intentional functionality changes
- Issues on unmodified lines
- General quality issues (test coverage, documentation) unless instruction files require them
- Issues with lint ignore comments

## Notes

- Don't check build signal or run builds/typechecks (handled separately by CI)
- Cite and link each issue with full context
- Keep comments brief and professional
- Use Azure CLI commands from the ado-cli skill

## Inline Comment Format

When posting review findings, use this format per thread:

```markdown
<brief issue title>

<why this is a problem in this specific code path>

<clear, actionable suggestion>

🤖 Generated with AI
```

- Post one thread per issue at the exact file/line location using `threadContext`.
- Include only one issue per thread so authors can resolve items independently.
- Keep comments brief, specific, and fix-oriented.
- Optional: after posting all inline threads, post one short top-level summary comment linking the key findings.

**If no issues:** post a single top-level comment:

```markdown
### Code review

No issues found. Checked for bugs and instruction file compliance.

🤖 Generated with AI
```

## Including Images in Comments

When an image helps illustrate a review finding (e.g., a UI regression screenshot, a diagram of a race condition), upload it as a PR attachment and reference the attachment URL in the comment.

Upload the image first, then use the returned URL in the comment content:

```bash
# 1. Resolve the repository ID from the PR
REPOSITORY_ID=$(az repos pr show \
  --id {pullRequestId} \
  --org "https://dev.azure.com/{organization}" \
  --query "repository.id" -o tsv)

# 2. Get a DevOps token and upload raw image bytes
TOKEN=$(az account get-access-token \
  --resource 499b84ac-1321-427f-aa17-267ca6975798 \
  --query accessToken -o tsv)

ATTACHMENT_URL=$(curl -sS -X POST \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/octet-stream" \
  --data-binary "@/absolute/path/to/image.png" \
  "https://dev.azure.com/{organization}/{project}/_apis/git/repositories/${REPOSITORY_ID}/pullRequests/{pullRequestId}/attachments/{fileName}?api-version=7.1" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["url"])')

# 3. Write the comment body with the attachment URL to a temp file
cat > /tmp/image-comment.json << IMG_EOF
{"comments":[{"parentCommentId":0,"content":"![UI regression](${ATTACHMENT_URL})","commentType":"text"}],"status":"active"}
IMG_EOF

# 4. Post the comment using --in-file
az devops invoke --area git --resource pullRequestThreads \
  --route-parameters project={project} repositoryId=${REPOSITORY_ID} pullRequestId={pullRequestId} \
  --http-method POST --api-version 7.1 \
  --org "https://dev.azure.com/{organization}" \
  --in-file /tmp/image-comment.json
```

Control image size with Azure DevOps's `=WIDTHxHEIGHT` Markdown extension (note the space before `=`):

```markdown
![Screenshot](ATTACHMENT_URL =400x)
![Screenshot](ATTACHMENT_URL =500x250)
```

Supported image formats: PNG, GIF, JPEG, ICO.

## Azure DevOps Link Format

Use this exact format for code links (must include full commit hash):

```
https://dev.azure.com/{org}/{project}/_git/{repo}?path=/{file-path}&version=GC{full-commit-hash}&lineStart={start}&lineEnd={end}&lineStartColumn=1&lineEndColumn=1
```

- Get full commit hash from PR details (`az repos pr show --id {prId} --detect true --query "lastMergeSourceCommit.commitId" -o tsv`)
- Use `lineStart` and `lineEnd` for line ranges (or just `line={number}` for a single line)
- Include 1+ lines of context before/after the issue
- Ensure org, project, and repo names match the PR's repository
- File path should start with `/`
