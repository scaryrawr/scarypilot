---
name: ado-work-items
description: When users share Azure DevOps work item links or ask about work items, use the Azure DevOps CLI to view, create, update, query, and manage work items.
---

# Azure DevOps Work Item Operations

You have access to an already signed-in Azure CLI with the `azure-devops` extension. Use these commands to manage Azure DevOps work items.

## Organization Detection

Most `az boards` commands require an organization URL. When running inside a cloned Azure DevOps repository, use `--detect true` to auto-detect the organization and project from the local git remote — this avoids passing `--org` explicitly.

If auto-detection fails or you're outside a repo, pass `--org {orgUrl}` directly.

## Parsing Work Item URLs

Extract the work item ID from common URL patterns:

- `https://dev.azure.com/{org}/{project}/_workitems/edit/{workItemId}`

## Show Work Item Details

```shell
az boards work-item show --id {workItemId} --detect true
```

Useful flags:

| Flag         | Description                                                        |
| ------------ | ------------------------------------------------------------------ |
| `--expand`   | Control returned data: `all` (default), `fields`, `links`, `relations`, `none` |
| `--fields`   | Comma-separated field list (e.g. `System.Id,System.Title,System.State`) |
| `--as-of`    | Show state at a point in time (e.g. `"2024-01-15"`, `"2024-01-15 14:00:00 UTC"`) |
| `--open`     | Also open the work item in the browser                             |

Examples:

```shell
# Get only specific fields
az boards work-item show --id {workItemId} --fields "System.Title,System.State,System.AssignedTo" --detect true

# View work item state as of a specific date
az boards work-item show --id {workItemId} --as-of "2024-06-01" --detect true

# Show only relations
az boards work-item show --id {workItemId} --expand relations --detect true
```

## Create Work Item

```shell
az boards work-item create --title "Title" --type "Task" --project {project} --detect true
```

Optional flags:

| Flag             | Description                                          |
| ---------------- | ---------------------------------------------------- |
| `--assigned-to`  | Email of the assignee                                |
| `--description`  | Work item description                                |
| `--area`         | Area path (e.g. `MyProject\TeamA`)                   |
| `--iteration`    | Iteration path (e.g. `MyProject\Sprint 1`)           |
| `--discussion`   | Add an initial discussion comment                    |
| `--reason`       | Reason for the state                                 |
| `--fields`       | Custom fields as `"field=value"` pairs               |
| `--open`         | Open in browser after creation                       |

Example with custom fields:

```shell
az boards work-item create \
  --title "Fix login timeout" \
  --type "Bug" \
  --project {project} \
  --assigned-to "dev@contoso.com" \
  --fields "Microsoft.VSTS.Common.Priority=1" "Microsoft.VSTS.Common.Severity=2 - High" \
  --detect true
```

## Update Work Item

```shell
az boards work-item update --id {workItemId} --state "Active" --detect true
```

Commonly used update flags:

| Flag             | Description                                          |
| ---------------- | ---------------------------------------------------- |
| `--state`        | New state (e.g. `Active`, `Resolved`, `Closed`)      |
| `--assigned-to`  | Reassign the work item                               |
| `--title`        | Update title                                         |
| `--description`  | Update description                                   |
| `--discussion`   | Add a comment without changing other fields           |
| `--area`         | Move to a different area path                        |
| `--iteration`    | Move to a different iteration                        |
| `--reason`       | Reason for the state transition                      |
| `--fields`       | Custom fields as `"field=value"` pairs               |
| `--open`         | Open in browser after update                         |

Add a comment without making other changes:

```shell
az boards work-item update --id {workItemId} --discussion "Investigated — root cause is a race condition in the auth flow." --detect true
```

## Query Work Items (WIQL)

Run inline queries:

```shell
az boards query --wiql "SELECT [System.Id], [System.Title], [System.State] FROM workitems WHERE [System.AssignedTo] = @Me AND [System.State] <> 'Closed'" --detect true
```

Run a saved query by path:

```shell
az boards query --path "Shared Queries/Active Bugs" --detect true
```

Run a saved query by ID:

```shell
az boards query --id {queryId} --detect true
```

## Manage Work Item Relations

Add a relation:

```shell
# Link types: parent, child, related, predecessor, successor, etc.
az boards work-item relation add --id {workItemId} --relation-type "parent" --target-id {targetId} --detect true

# Link multiple targets at once (comma-separated)
az boards work-item relation add --id {workItemId} --relation-type "child" --target-id {id1},{id2} --detect true
```

View relations with friendly names:

```shell
az boards work-item relation show --id {workItemId} --detect true
```

Remove a relation:

```shell
az boards work-item relation remove --id {workItemId} --relation-type "child" --target-id {targetId} --detect true
```

List available link types:

```shell
az boards work-item relation list-type --detect true
```

## Output Tips

- Use `--output table` for human-readable summaries
- Use `--query "<JMESPath>"` to extract specific fields from JSON output
- Use `--fields` on show/create/update to limit which fields are returned or set
