# Existing Azure DevOps Pull Request Operations

Run these non-interactive helpers with `uv run` from the skill directory using the `./scripts/...` paths shown below. The helpers print JSON to stdout and diagnostics to stderr. Run `uv run ./scripts/ado-pr.py --help` to confirm flags or subcommands.

## `context`

Start with the helper script so you have normalized IDs and branch metadata before composing follow-up commands:

```text
uv run ./scripts/ado-pr.py context --id {prId} --detect true
```

Use these fields directly:

- `pullRequestId`, `title`, `status`, `isDraft`
- `sourceBranch`, `targetBranch`, plus shell-neutral `sourceBranchName` and `targetBranchName` without `refs/heads/`
- `repositoryId`, `repositoryName`
- `projectId`, `projectName`
- `createdBy`, `url`

Use `--org {orgUrl}` instead of `--detect true` when auto-detection is unavailable.

## `list-threads`

Use the thread helper instead of hand-building the `az devops invoke` call each time:

```text
uv run ./scripts/ado-pr.py list-threads --id {prId} --status active --detect true
```

Use `count` and `threads` from the JSON response. Omit `--status` when you need all threads.

## `list-builds`

Query pipeline runs for the PR's current synthetic merge commit:

```text
uv run ./scripts/ado-pr.py list-builds --id {prId} --detect true
```

This is separate from `az repos pr policy list`: policy output is not a complete
inventory of pipelines triggered for a PR. The helper queries
`refs/pull/{prId}/merge`, then filters out runs from superseded merge commits.
Treat nonempty `failed` as a current build failure and nonempty `pending` as work
still running. Inspect each failed build's status, logs, and issues before deciding
whether the failure is actionable, pre-existing, or infrastructure-related.

## `thread-payload`

Never hand-write review thread JSON when the helper can do it for you:

```text
uv run ./scripts/ado-pr.py thread-payload --content "Your comment" --file-path src/path/to/file.ts --line-start 42 --line-end 42 --out-file auto

az devops invoke --area git --resource pullRequestThreads --route-parameters project={project} repositoryId={repo} pullRequestId={prId} --http-method POST --api-version 7.1-preview --detect true --in-file {outFile}
```

Pass repo-relative Azure paths with `/` separators to `--file-path`; the helper also normalizes Windows `\` separators. If you pass `--out-file auto`, the helper writes to the OS temp directory and returns `{ outFile, payload }`; otherwise it returns the payload directly. Use a top-level thread only when the user explicitly requests a standalone summary or when the comment cannot be anchored to a file.

## `reply-and-resolve`

Reply inside an existing review thread and resolve it only after the reply succeeds:

```text
uv run ./scripts/ado-pr.py reply-and-resolve --id {prId} --thread-id {threadId} --content "Applied the fix and added coverage." --status fixed --detect true
```

Use `fixed` when code changed, `wontFix` or `byDesign` when the suggestion was considered but intentionally not applied, and `closed` only for a general discussion that is complete. Do not resolve a thread without first leaving a concise reply that records the disposition.

## Workflow

1. Resolve PR context with `context`.
2. Retrieve threads with `list-threads` when you need prior discussion state.
3. Retrieve current-merge pipeline runs with `list-builds`; do not infer build
   health only from branch policies.
4. Use `reply-and-resolve` after addressing an existing active thread.
5. Build comment payloads with `thread-payload` before posting new inline comments. Do not add a separate top-level summary when it repeats an inline finding.

## Common PR commands

Show a PR:

```text
az repos pr show --id {prId} --detect true
```

List PRs:

```text
az repos pr list --detect true --status active --output table
```

Checkout a PR locally:

```text
az repos pr checkout --id {prId}
```

Set a vote:

```text
az repos pr set-vote --id {prId} --vote approve --detect true
```

Update PR status:

```text
az repos pr update --id {prId} --status completed --detect true
```

List linked work items:

```text
az repos pr work-item list --id {prId} --detect true
```

Manage reviewers:

```text
az repos pr reviewer list --id {prId} --detect true
az repos pr reviewer add --id {prId} --reviewers {email} --detect true
az repos pr reviewer remove --id {prId} --reviewers {email} --detect true
```

Check policy status:

```text
az repos pr policy list --id {prId} --detect true --output table
```

## Rules

- Use the helper script for context lookup and thread payload generation before falling back to handwritten REST payloads.
- Keep `threadContext` line ranges as small as possible for file-specific comments.
- When `--detect true` fails, rerun with an explicit `--org` value.
- Keep commands shell-neutral when possible: use single-line commands, `--out-file auto`, and helper-provided branch names instead of POSIX-only temp paths or Bash parameter expansion.
