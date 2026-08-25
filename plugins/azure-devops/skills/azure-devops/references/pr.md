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

## `thread-payload`

Never hand-write review thread JSON when the helper can do it for you:

```text
uv run ./scripts/ado-pr.py thread-payload --content "Your comment" --file-path src/path/to/file.ts --line-start 42 --line-end 42 --out-file auto

az devops invoke --area git --resource pullRequestThreads --route-parameters project={project} repositoryId={repo} pullRequestId={prId} --http-method POST --api-version 7.1-preview --detect true --in-file {outFile}
```

For top-level comments, omit the file and line flags. Pass repo-relative Azure paths with `/` separators to `--file-path`; the helper also normalizes Windows `\` separators. If you pass `--out-file auto`, the helper writes to the OS temp directory and returns `{ outFile, payload }`; otherwise it returns the payload directly.

## Workflow

1. Resolve PR context with `context`.
2. Retrieve threads with `list-threads` when you need prior discussion state.
3. Build comment payloads with `thread-payload` before posting inline or top-level comments.

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
