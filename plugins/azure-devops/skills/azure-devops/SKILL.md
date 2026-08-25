---
name: azure-devops
description: Use for performing Azure DevOps work — create, inspect, review, comment on, vote on, or manage pull requests; find, query, create, update, and link Azure Boards work items (including building WIQL queries); parse and route dev.azure.com or *.visualstudio.com URLs; and upload PNG/image/file attachments to pull requests. Triggers on Azure DevOps / ADO / Azure Boards links or action requests such as "make an ADO PR", "review this Azure DevOps PR", or "find work items assigned to me". Not for general conceptual explanations that do not act on a specific Azure DevOps resource, and not for GitHub, Jira, or other non-Azure-DevOps tools.
allowed-tools: >-
  Bash(uv run ./scripts/ado-cli.py:*)
  Bash(uv run ./scripts/ado-pr.py:*)
  Bash(uv run ./scripts/review-pr.py:*)
  Bash(uv run ./scripts/make-pr.py:*)
  Bash(uv run ./scripts/ado-work-items.py:*)
compatibility: "Requires uv/Python, Git for checkout and PR creation flows, and Azure CLI with the azure-devops extension. On Windows, helpers resolve the Azure CLI az.cmd shim before invoking it."
---

# Azure DevOps

One skill for every Azure DevOps task. This file is the router: read only the
reference for the task at hand, then drive the matching helper script. Supported
hosts are `dev.azure.com` and `*.visualstudio.com`.

## Route by use case

Match the user's intent to a row, read that reference **on demand**, then run its
helper. Do not read references you do not need.

| Use case | Read reference | Helper script |
| --- | --- | --- |
| Create a PR from current changes (incl. draft) | `references/make-pr.md` | `scripts/make-pr.py` |
| Inspect or manage an existing PR (status, threads, votes, checkout) | `references/pr.md` | `scripts/ado-pr.py` |
| Review a PR and post inline findings + labels | `references/review-pr.md` | `scripts/review-pr.py` |
| Find, query (WIQL), create, update, or link Azure Boards work items | `references/work-items.md` | `scripts/ado-work-items.py` |
| Parse/route an ADO URL, or upload a PR attachment | (this file) | `scripts/ado-cli.py` |

Every helper prints JSON to stdout and diagnostics to stderr. Run any helper with
`--help` to confirm its subcommands and flags before composing a command.

## Routing an unknown ADO URL

When the user provides an Azure DevOps URL, normalize it first:

```text
uv run ./scripts/ado-cli.py parse-url "{azure_devops_url}"
```

Use the returned `organizationUrl`, `project`, `repository`, `resourceType`, and
`resourceId` directly. `routeSkill` is an internal workflow hint:

- `pull-request` -> use `references/pr.md` for existing PR inspection/management (or `references/review-pr.md` if the user asked for a review).
- `work-items` -> use `references/work-items.md` for Azure Boards work items and WIQL.
- `unknown` -> pick the row above that matches the user's stated intent (PR creation, PR review, existing PR ops, or work items).

## Uploading a PR attachment

Use `uv run ./scripts/ado-cli.py upload-attachment ...` (or the workflow-specific
helper's attachment command). Run `--help` for exact flags.

## Organization detection

For Azure CLI commands that support it, prefer `--detect true` when you are inside
the target repository. If auto-detection fails, fall back to `organizationUrl` from
`parse-url`, parsed git remote metadata from `make-pr.py preflight`, or a
user-supplied org URL.

## Rules

- Prefer helper output over handwritten URL parsing, WIQL assembly, PR thread JSON, code links, template discovery, or attachment uploads.
- Keep commands shell-neutral: use single-line commands, quote shell-sensitive values such as `"@Me"`, use helper-provided temp paths, and avoid POSIX-only temp paths or Bash parameter expansion.
- Stop and surface blockers, branch-policy errors, permission failures, unsupported URL hosts, and unsupported paths verbatim.
