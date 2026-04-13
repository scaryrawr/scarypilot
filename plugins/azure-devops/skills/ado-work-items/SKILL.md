---
name: ado-work-items
description: When users share Azure DevOps work item links or ask about work items, inspect and manage work items with Azure CLI plus the local work-item helper script.
compatibility: "Requires Node.js >=22.18 and Azure CLI with the azure-devops extension."
---

# Azure DevOps Work Item Operations

Use this skill for Azure DevOps Boards work items.

## Script-first helpers

### Parse work item URLs

Use the script instead of manually pulling the ID out of the URL:

```bash
./scripts/ado-work-items.mts parse-url "https://dev.azure.com/{org}/{project}/_workitems/edit/{workItemId}"
```

### Build WIQL safely

Use the helper to assemble common WIQL queries instead of rewriting the `WHERE` clause from scratch:

```bash
./scripts/ado-work-items.mts wiql \
  --assigned-to @Me \
  --exclude-state Closed \
  --type Bug \
  --fields System.Id,System.Title,System.State
```

The script returns both the WIQL string and a ready-to-run `az boards query` command.

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
