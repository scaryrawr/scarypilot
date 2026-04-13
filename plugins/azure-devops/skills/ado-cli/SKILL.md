---
name: ado-cli
description: When users share Azure DevOps links or mention Azure DevOps resources, parse the URL, identify the resource type, and route to the right Azure DevOps skill.
compatibility: "Requires Node.js >=22.18 and Azure CLI with the azure-devops extension."
user-invocable: false
---

# Azure DevOps Router

Use this skill when a user gives you an Azure DevOps URL or needs the shared attachment-upload helper.

## Parse Azure DevOps URLs first

Always normalize the URL with the script instead of manually re-parsing host and path segments:

```bash
./scripts/ado-cli.mts parse-url "https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{prId}"
```

The script returns structured JSON including:

- `organization`
- `organizationUrl`
- `project`
- `repository` when present
- `resourceType`
- `resourceId`
- `routeSkill`

Routing rules:

- `pull-request` -> `ado-pr`
- `work-item` -> `ado-work-items`
- creation requests -> `make-pr`
- explicit review requests -> `review-pr`

## Organization detection

For Azure CLI commands that support it, prefer `--detect true` when you are inside the target repository.

If auto-detection fails, fall back to `organizationUrl` from the parse result or a user-supplied org URL.

## Pull request attachment upload helper

When you need a PR attachment URL, use the script instead of rebuilding the token + binary upload flow inline:

```bash
./scripts/ado-cli.mts upload-attachment \
  --org {org-or-url} \
  --project {project} \
  --repository-id {repositoryId} \
  --pull-request-id {prId} \
  --file /absolute/path/to/image.png
```

The script performs the token lookup and upload, then returns the attachment URL as JSON.

## Rules

- Prefer the script output over handwritten URL parsing.
- Prefer the script output over handwritten `curl` + `python3` attachment upload snippets.
- Fail loudly when the URL host or path is unsupported.
