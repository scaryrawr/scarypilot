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

3. **Review the Changes**: Use agents to analyze the code changes for:
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
   
   b. **Post Comments**: After user confirmation, write the comment body to a temporary file and use `az devops invoke` with `--in-file` to avoid shell escaping issues:

   ```shell
   cat > /tmp/review-thread.json << 'REVIEW_EOF'
   {"comments":[{"parentCommentId":0,"content":"Your review","commentType":"text"}],"status":"active"}
   REVIEW_EOF

   az devops invoke --area git --resource pullRequestThreads \
     --route-parameters project={project} repositoryId={repo} pullRequestId={pr} \
     --http-method POST --api-version 7.1-preview \
     --detect true --in-file /tmp/review-thread.json
   ```

   For file-specific comments, include `threadContext` with `filePath`, `rightFileStart`, and `rightFileEnd` in the JSON file.

   Valid thread `status` values: `active`, `fixed`, `wontFix`, `closed`, `byDesign`, `pending`.

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

## Comment Format

When posting the review using `az devops invoke`, format as follows:

**If issues found:**

```markdown
### Code review

Found {N} issues:

1. <brief description> (instruction file says "<quote>")

   <Azure DevOps link to file with full commit hash + line range>

2. <brief description> (bug due to <file and code snippet>)

   <Azure DevOps link to file with full commit hash + line range>

🤖 Generated with AI

<sub>- If this code review was useful, please react with 👍. Otherwise, react with 👎.</sub>
```

**If no issues:**

```markdown
### Code review

No issues found. Checked for bugs and instruction file compliance.

🤖 Generated with AI
```

## Including Images in Comments

When an image helps illustrate a review finding (e.g., a UI regression screenshot, a diagram of a race condition), upload it as a PR attachment and reference the attachment URL in the comment.

Upload the image first, then use the returned URL in the comment content:

```bash
# 1. Upload the image as a PR attachment
az rest --method post \
  --url "https://dev.azure.com/{organization}/{project}/_apis/git/repositories/{repositoryId}/pullRequests/{pullRequestId}/attachments/{fileName}?api-version=7.1" \
  --headers "Content-Type=application/octet-stream" \
  --body @path/to/image.png

# 2. Write the comment body with the attachment URL to a temp file
cat > /tmp/image-comment.json << 'IMG_EOF'
{"comments":[{"parentCommentId":0,"content":"![UI regression](ATTACHMENT_URL_FROM_RESPONSE)","commentType":"text"}],"status":"active"}
IMG_EOF

# 3. Post the comment using --in-file
az devops invoke --area git --resource pullRequestThreads \
  --route-parameters project={project} repositoryId={repo} pullRequestId={pr} \
  --http-method POST --api-version 7.1-preview \
  --detect true --in-file /tmp/image-comment.json
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
