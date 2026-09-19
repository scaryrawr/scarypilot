---
name: azure-devops
description: Use for performing Azure DevOps work — privately pair-review or discuss pull requests in the local canvas; create, inspect, review, comment on, vote on, or manage pull requests; find, query, create, update, and link Azure Boards work items (including building WIQL queries); parse and route dev.azure.com or *.visualstudio.com URLs; and upload PNG/image/file attachments to pull requests. Triggers on Azure DevOps / ADO / Azure Boards links or action requests such as "make an ADO PR", "review this Azure DevOps PR without posting", or "find work items assigned to me". Not for general conceptual explanations that do not act on a specific Azure DevOps resource, and not for GitHub, Jira, or other non-Azure-DevOps tools.
allowed-tools: >-
  list_canvas_capabilities
  open_canvas
  invoke_canvas_action
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

## Route private reviews to paired review

When the user provides a full Azure DevOps pull request URL and asks to review,
discuss, make a local issue table, keep findings private, avoid comments, or ask
before posting, use the `azure-devops-paired-review` canvas before any helper or
raw Azure CLI command:

1. Inspect the canvas capabilities, then open it with the pull request URL and a
   stable instance ID derived from the pull request ID.
2. Use `list_review_files` and bounded `get_review_file_lines` calls to inspect
   every changed file. Create local findings only for high-confidence defects.
3. Summarize findings and concerns in chat for discussion. Keep them local.
4. Never invoke `publish_review_findings` unless the user explicitly approves
   the specific publication after reviewing the local findings.

The canvas extension owns authenticated Azure DevOps loading for this route. Do
not separately run eligibility, checkout, policy, thread, or other Azure CLI
commands unless the canvas is unavailable or reports a load failure. If falling
back, preserve the user's no-write constraint and surface the fallback clearly.

## Route by use case

Match the user's intent to a row, read that reference **on demand**, then run its
helper. Do not read references you do not need.

| Use case | Read reference | Helper script |
| --- | --- | --- |
| Create a PR from current changes (incl. draft) | `references/make-pr.md` | `scripts/make-pr.py` |
| Inspect or manage an existing PR (status, threads, votes, checkout) | `references/pr.md` | `scripts/ado-pr.py` |
| Review a PR with permission to post inline findings + labels | `references/review-pr.md` | `scripts/review-pr.py` |
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

`project` is `null` for organization-scoped repository URLs such as
`https://dev.azure.com/{org}/_git/{repo}`; prefer Azure CLI auto-detection or
repository IDs when a later operation requires project context.

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
