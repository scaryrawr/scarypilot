# Azure DevOps Work Item Operations

Run these non-interactive helpers with `uv run` from the skill directory using the `./scripts/...` paths shown below. The helpers print JSON to stdout and diagnostics to stderr. Run `uv run ./scripts/ado-work-items.py --help` to confirm flags or subcommands.

## `parse-url`

Use the script instead of manually pulling the ID out of the URL:

```text
uv run ./scripts/ado-work-items.py parse-url "https://dev.azure.com/{org}/{project}/_workitems/edit/{workItemId}"
```

Use these fields directly:

- `organization`, `organizationUrl`
- `project`
- `workItemId`

## `wiql`

Use the helper to assemble common WIQL queries instead of rewriting the `WHERE` clause from scratch:

```text
uv run ./scripts/ado-work-items.py wiql --assigned-to "@Me" --exclude-state Closed --type Bug --fields System.Id,System.Title,System.State
```

The script returns:

- `wiql`: the query text
- `executable` and `commandArgs`: shell-neutral argv values for `az boards query`
- `powerShellCommand` and `posixCommand`: display-only commands for those shells

Use `--current` to exclude `Closed` and `Removed` without repeating those states:

```text
uv run ./scripts/ado-work-items.py wiql --assigned-to "@Me" --current --type Bug
```

## `search`

Use the Azure DevOps work item search API for keyword/full-text lookup instead of WIQL `CONTAINS`, which can time out on org-wide scans:

```text
uv run ./scripts/ado-work-items.py search --org {org-or-url} --text "keyword phrase" --type Epic --project {project} --top 25
```

## `required-fields`

List fields a customized process marks as always required before creating a work item type:

```text
uv run ./scripts/ado-work-items.py required-fields --org {org-or-url} --project {project} --type Feature
```

## `link-pr`

Link a pull request to a work item with the required named `ArtifactLink` relation:

```text
uv run ./scripts/ado-work-items.py link-pr --org {org-or-url} --work-item-id {workItemId} --pull-request-id {prId} --project {project} --repository {repo}
```

Use `--project-id` and `--repository-id` when you already have the GUIDs.

## Workflow

1. Parse incoming Azure DevOps work item URLs with `parse-url`.
2. Build WIQL with `wiql` instead of manually composing `WHERE` clauses.
3. Use `search` for keyword lookup, `required-fields` before creating customized work item types, and `link-pr` when Azure CLI relation commands cannot create the required PR artifact link.
4. Run the appropriate Azure CLI command after the helper has normalized the inputs.

## Common work item commands

Show a work item:

```text
az boards work-item show --id {workItemId} --detect true
```

Show specific fields:

```text
az boards work-item show --id {workItemId} --fields "System.Title,System.State,System.AssignedTo" --detect true
```

Create a work item:

```text
az boards work-item create --title "Title" --type "Task" --project {project} --detect true
```

Update a work item:

```text
az boards work-item update --id {workItemId} --state "Active" --detect true
```

Run WIQL:

```text
az boards query --wiql "SELECT [System.Id], [System.Title] FROM workitems WHERE [System.AssignedTo] = @Me" --detect true
```

Manage relations:

```text
az boards work-item relation add --id {workItemId} --relation-type parent --target-id {targetId} --detect true
az boards work-item relation show --id {workItemId} --detect true
az boards work-item relation remove --id {workItemId} --relation-type child --target-id {targetId} --detect true
```

## Rules

- Prefer the helper script for URL parsing, WIQL assembly, keyword search, required-field discovery, and PR artifact links.
- Prefer `--detect true` when repository context is available.
- Keep custom field names exact; do not silently rewrite them.
- Use `executable` plus `commandArgs` from the WIQL helper instead of copying POSIX shell quoting on Windows.
