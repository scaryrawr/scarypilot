---
name: ado-cli
description: When users share Azure DevOps links (dev.azure.com or visualstudio.com) or mention Azure DevOps, parse URLs to identify the resource and route to the appropriate action.
---

# Azure DevOps CLI

You have access to an already signed-in Azure CLI with the `azure-devops` extension. When users share Azure DevOps links or mention Azure DevOps resources, parse the URL to identify the resource type and infer the appropriate action.

## Organization Detection

Most `az` DevOps commands support `--detect true` to auto-detect organization and project from the local git remote. When running inside a cloned Azure DevOps repository, prefer `--detect true` over explicit `--org {orgUrl}` to reduce parameter errors.

If auto-detection fails (e.g., outside a repo or ambiguous remote), fall back to `--org {orgUrl}`.

## Parsing Azure DevOps URLs

Extract parameters from common URL patterns:

- `https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{prId}` → PR operations
- `https://{org}.visualstudio.com/{project}/_git/{repo}/pullrequest/{prId}` → PR operations
- `https://dev.azure.com/{org}/{project}/_workitems/edit/{workItemId}` → Work item operations

## Routing by Resource Type

| URL contains         | Resource     | Skill to use   |
| -------------------- | ------------ | -------------- |
| `/pullrequest/`      | Pull Request | ado-pr         |
| `/_workitems/edit/`  | Work Item    | ado-work-items |
| User says "create PR"| Pull Request | make-pr        |
| User says "review PR"| Pull Request | review-pr      |

## Using `az devops invoke` for REST APIs

When the CLI lacks a first-class command, use `invoke` to call any Azure DevOps REST API:

```shell
az devops invoke --area {area} --resource {resource} \
  --route-parameters {key}={value} \
  --detect true --api-version 7.1
```

Common areas: `git`, `wit` (work item tracking), `core`

For POST/PUT/PATCH requests, write the JSON body to a temporary file and use `--in-file` to avoid shell escaping issues:

```shell
cat > /tmp/payload.json << 'EOF'
{"key": "value"}
EOF

az devops invoke --area {area} --resource {resource} \
  --route-parameters {key}={value} \
  --http-method POST --api-version 7.1-preview \
  --detect true --in-file /tmp/payload.json
```

## Output Formatting

- Use `--output table` for human-readable summaries
- Use `--output json` (default) for programmatic processing
- Use `--query "<JMESPath>"` to extract specific fields:

```shell
# Example: get just the PR title
az repos pr show --id 123 --detect true --query "title" -o tsv
```

- Pipe JSON output to `jq` for complex filtering
