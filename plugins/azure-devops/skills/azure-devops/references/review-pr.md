# Azure DevOps PR Review

Run these non-interactive helpers with `uv run` from the skill directory using the `./scripts/...` paths shown below. The helpers print JSON to stdout and diagnostics to stderr. Run `uv run ./scripts/review-pr.py --help` to confirm flags or subcommands.

## `eligibility`

Start here before reviewing:

```text
uv run ./scripts/review-pr.py eligibility --id {prId} --detect true
```

Use these fields directly:

- `eligible`, `status`, `isDraft`
- `sourceBranch`, `targetBranch` (Azure refs like `refs/heads/main`), plus shell-neutral `sourceBranchName` and `targetBranchName`
- `repositoryId`, `repositoryName`
- `projectId`, `projectName`
- `reviewers`, `url`

Skip review when `eligible` is false.

## `thread-payload`

Use the helper instead of hand-writing review thread JSON:

```text
uv run ./scripts/review-pr.py thread-payload --content "<brief issue title>\n\n<why it matters>\n\n<actionable fix>\n\n🤖 Generated with AI" --file-path src/path/to/file.ts --line-start 42 --line-end 42 --out-file auto
```

Pass repo-relative Azure paths with `/` separators to `--file-path`; the helper also normalizes Windows `\` separators. If you pass `--out-file auto`, the helper writes to the OS temp directory and returns `{ outFile, payload }`; otherwise it returns the payload directly.

## `sync-labels`

Use the helper after the review is complete:

```text
uv run ./scripts/review-pr.py sync-labels --id {prId} --model gpt-5.6-sol --model claude-opus-5 --detect true
```

Use `desiredLabels`, `addedLabels`, `removedLabels`, and `finalLabels` from the JSON result.

## `code-link`

Build Azure DevOps code links with:

```text
uv run ./scripts/review-pr.py code-link --org {org-or-url} --project {project} --repo {repo} --commit {fullCommitSha} --file-path src/path/to/file.ts --line-start 40 --line-end 44
```

The script returns `{ url }`.

## `upload-attachment`

Upload PR attachments with:

```text
uv run ./scripts/review-pr.py upload-attachment --org {org-or-url} --project {project} --repository-id {repositoryId} --pull-request-id {prId} --file {absolute_path_to_image}
```

Use `id` and `url` from the JSON result.

## Workflow

1. Check eligibility with `uv run ./scripts/review-pr.py eligibility --id {prId} --detect true`.
2. Skip review when the PR is not active or is a draft.
3. Gather context: identify relevant instruction files such as `.github/copilot-instructions.md`, `AGENTS.md`, and `CLAUDE.md`; reuse `targetBranch`, `projectName`, and `repositoryId` from eligibility output; check out the PR branch locally with `az repos pr checkout --id {prId}`; use `targetBranchName` to generate the diff with `git diff "origin/{targetBranchName}"...HEAD`.
4. Review the changes: follow the code-review skill (read its `SKILL.md`) for the evaluation lenses and structured output. Prefer relevant specialist agents when they match technologies in the diff, use independent review passes when practical, and deduplicate overlapping findings. Focus on bugs, explicit instruction-file violations, history/blame signals, and changed-line issues.
5. Validate issues: post only high-confidence findings and ignore style-only nits, pre-existing issues, CI-only issues, and unmodified-line complaints.
6. Confirm before posting unless the user explicitly asked you not to confirm.
7. Post one inline thread per issue with exact file and right-side diff line range. Prefer single-line ranges. Build payloads with `thread-payload` before posting. Do not post a separate top-level summary for the same finding; a singular comment request means the inline finding only. Use a top-level thread only when the user explicitly asks for a standalone summary or the content has no file anchor.
8. Sync review labels after the review completes. Always include `ai-reviewed` plus one `ai-model-<model-id>` label per model used.

Post inline comments with:

```text
az devops invoke --area git --resource pullRequestThreads --route-parameters project={projectName} repositoryId={repositoryId} pullRequestId={prId} --http-method POST --api-version 7.1-preview --detect true --in-file {outFile}
```

Determine line numbers from the right side of the diff (`+` side), then verify against the checked-out file.

## No-issues case

If no issues are found, post no comment. A clean review is silent.

## Helper commands

- Reuse `code-link` for file-specific references in comments or summaries.
- Reuse `upload-attachment` when the review needs screenshots or other uploaded artifacts.
- Keep commands shell-neutral when possible: use single-line commands, `--out-file auto`, repo-relative Azure paths, and helper-provided branch names instead of POSIX-only temp paths or Bash parameter expansion.
