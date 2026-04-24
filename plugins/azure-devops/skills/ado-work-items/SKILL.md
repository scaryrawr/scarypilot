---
name: ado-work-items
description: When users share Azure DevOps work item links or ask about work items, inspect and manage work items with Azure CLI plus the local work-item helper script.
compatibility: "Requires Node.js >=22.18 and Azure CLI with the azure-devops extension."
---

# Azure DevOps Work Item Operations

Use this skill for Azure DevOps Boards work items.

## Script execution model

- Run the bundled helpers via the skill-relative paths shown below (`./scripts/...` resolves from this skill directory).
- The helper scripts are non-interactive. Read structured JSON from stdout and treat stderr as diagnostics.
- If you need to confirm flags or subcommands, run `./scripts/ado-work-items.mts --help`.

## Available scripts

### `parse-url`

Use the script instead of manually pulling the ID out of the URL:

```bash
./scripts/ado-work-items.mts parse-url "https://dev.azure.com/{org}/{project}/_workitems/edit/{workItemId}"
```

Use these fields directly:

- `organization`, `organizationUrl`
- `project`
- `workItemId`

### `wiql`

Use the helper to assemble common WIQL queries instead of rewriting the `WHERE` clause from scratch:

```bash
./scripts/ado-work-items.mts wiql \
  --assigned-to @Me \
  --exclude-state Closed \
  --type Bug \
  --fields System.Id,System.Title,System.State
```

The script returns:

- `wiql`: the query text
- `command`: a ready-to-run `az boards query` command

## Workflow

1. Parse incoming Azure DevOps work item URLs with `parse-url`.
2. Build WIQL with `wiql` instead of manually composing `WHERE` clauses.
3. Run the appropriate Azure CLI command after the helper has normalized the inputs.

## Common work item commands

Show a work item:

```bash
az boards work-item show --id {workItemId} --detect true
```

Show specific fields:

```bash
az boards work-item show --id {workItemId} --fields "System.Title,System.State,System.AssignedTo" --detect true
```

Create a work item:

```bash
az boards work-item create --title "Title" --type "Task" --project {project} --detect true
```

Update a work item:

```bash
az boards work-item update --id {workItemId} --state "Active" --detect true
```

Run WIQL:

```bash
az boards query --wiql "SELECT [System.Id], [System.Title] FROM workitems WHERE [System.AssignedTo] = @Me" --detect true
```

Manage relations:

```bash
az boards work-item relation add --id {workItemId} --relation-type parent --target-id {targetId} --detect true
az boards work-item relation show --id {workItemId} --detect true
az boards work-item relation remove --id {workItemId} --relation-type child --target-id {targetId} --detect true
```

## Rules

- Prefer the helper script for URL parsing and WIQL assembly.
- Prefer `--detect true` when repository context is available.
- Keep custom field names exact; do not silently rewrite them.
