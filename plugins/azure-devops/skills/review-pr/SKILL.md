---
name: review-pr
description: Code review an Azure DevOps pull request
---

Provide a code review for the given Azure DevOps pull request.

## Workflow

1. **Check Eligibility**: Use `az repos pr show --id {prId} --org {orgUrl}` to verify the PR is open, not a draft, and hasn't been reviewed by you already. Skip if ineligible.

2. **Get Context**: Identify relevant CLAUDE.md files (root and in modified directories) and get the PR diff using git commands:
   - First, use `az repos pr show --id {prId} --org {orgUrl}` to get the target branch name
   - Then fetch and switch to the PR branch: `az repos pr checkout --id {prId}` (note: checkout does NOT require `--org` as it operates on the local git repository)
   - Generate the diff: `git diff origin/{targetBranch}...HEAD`
   - **Note**: These commands will only work when executed in the same git repository as the PR.

3. **Review the Changes**: Use agents to analyze the code changes for:
   - CLAUDE.md compliance (only applicable instructions)
   - Obvious bugs in the changes themselves
   - Issues revealed by git history/blame
   - Patterns from previous PRs on these files
   - Violations of code comments/guidance

4. **Validate Issues**: For each potential issue, assess confidence (0-100 scale). Filter to only high-confidence issues (80+):
   - **0-25**: False positive or stylistic preference not in CLAUDE.md
   - **50**: Real but minor issue
   - **75**: Important issue affecting functionality or explicitly mentioned in CLAUDE.md
   - **100**: Definite issue that will cause problems

5. **Post Review**: If high-confidence issues found:
   
   a. **Confirm with User**: Use the `AskUserQuestion` tool to confirm with the user before posting comments to the PR, unless the user explicitly requested not to confirm. Present a summary of the issues you found and ask if they should be posted.
   
   b. **Post Comments**: After user confirmation, use `az devops invoke` to create a comment thread on the PR:

   ```shell
   az devops invoke --area git --resource pullRequestThreads \
     --route-parameters project={project} repositoryId={repo} pullRequestId={pr} \
     --http-method POST --api-version 7.1-preview \
     --body '{"comments":[{"parentCommentId":0,"content":"Your review","commentType":"text"}],"status":"active"}' \
     --org {orgUrl}
   ```

   For file-specific comments, include `threadContext` with `filePath`, `rightFileStart`, and `rightFileEnd` in the body.

## Avoid False Positives

- Pre-existing issues not introduced by this PR
- Linter/typechecker/compiler issues (handled by CI)
- Pedantic nitpicks not explicitly in CLAUDE.md
- Intentional functionality changes
- Issues on unmodified lines
- General quality issues (test coverage, documentation) unless CLAUDE.md requires them
- Issues with lint ignore comments

## Notes

- Don't check build signal or run builds/typechecks (handled separately by CI)
- Cite and link each issue with full context
- Keep comments brief and professional
- Use Azure CLI commands from the azure-cli skill

## Comment Format

When posting the review using `az devops invoke`, format as follows:

**If issues found:**

```markdown
### Code review

Found {N} issues:

1. <brief description> (CLAUDE.md says "<quote>")

   <Azure DevOps link to file with full commit hash + line range>

2. <brief description> (bug due to <file and code snippet>)

   <Azure DevOps link to file with full commit hash + line range>

🤖 Generated with AI

<sub>- If this code review was useful, please react with 👍. Otherwise, react with 👎.</sub>
```

**If no issues:**

```markdown
### Code review

No issues found. Checked for bugs and CLAUDE.md compliance.

🤖 Generated with AI
```

## Azure DevOps Link Format

Use this exact format for code links (must include full commit hash):

```
https://dev.azure.com/{org}/{project}/_git/{repo}?path=/{file-path}&version=GC{full-commit-hash}&lineStart={start}&lineEnd={end}&lineStartColumn=1&lineEndColumn=1
```

- Get full commit hash from PR details (`az repos pr show --id {prId} --org {orgUrl}`)
- Use `lineStart` and `lineEnd` for line ranges (or just `line={number}` for a single line)
- Include 1+ lines of context before/after the issue
- Ensure org, project, and repo names match the PR's repository
- File path should start with `/`
