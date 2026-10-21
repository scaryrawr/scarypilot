# Azure DevOps Plugin

Use GitHub Copilot CLI to work with Azure DevOps pull requests and Azure Boards
work items. The plugin includes a general Azure DevOps skill plus an agent-merge
workflow for driving pull requests through review, policy checks, conflicts, and
safe squash auto-complete, with recurring same-session monitoring until the PR
completes or needs human intervention.

## Prerequisites

- A current GitHub Copilot CLI release with plugin and skill support.
- [`uv`](https://docs.astral.sh/uv/) and Python.
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) with the
  `azure-devops` extension installed and authenticated.
- Git for pull request creation and checkout workflows.

Install the Azure DevOps CLI extension:

```sh
az extension add --name azure-devops
az login
```

## Installation

Install the complete plugin from the ScaryPilot marketplace:

```sh
copilot plugin marketplace add scaryrawr/scarypilot
copilot plugin install azure-devops@scarypilot
```

Install only an individual skill with GitHub CLI:

```sh
gh skill install scaryrawr/scarypilot plugins/azure-devops/skills/azure-devops --scope user
gh skill install scaryrawr/scarypilot plugins/azure-devops/skills/ado-agent-merge --scope user
```

The `ado-agent-merge` skill expects the sibling `azure-devops` skill and its
bundled helpers, so install the complete plugin for that workflow.

If `azure-devops` was previously installed from `scaryrawr/agentic`, add
`--force` once to replace its source-tracking metadata.

Version 0.14.0 removes the paired-review canvas extension, including its native
Boards read and PR snapshot tools. The plugin now uses the bundled Python
helpers for these operations and does not require canvas extension support.

## Usage

The plugin supports Azure DevOps pull request creation, inspection, review,
commenting, voting, checkout, attachment uploads, and end-to-end merge readiness
with safe squash auto-complete. It also supports Azure Boards queries, work item
creation and updates, WIQL, and work item links.

Example prompts:

- "Create an Azure DevOps pull request from my current branch."
- "Create an Azure DevOps PR and get it all the way through."
- "Use ADO agent merge on pull request 4821."
- "Enable auto-complete and keep monitoring this ADO PR for build failures."
- "Review Azure DevOps pull request 4821 and post inline comments."
- "Review this Azure DevOps PR privately; keep findings in chat."
- "Show the active work items assigned to me in Azure Boards."
- "Update this Azure DevOps work item and link it to its parent."
- "Parse this dev.azure.com URL and route it to the right workflow."

Private reviews use the helper-based inspection workflow and report findings in
chat. They do not post comments, votes, or review labels without authorization.

For Boards reads, use the coordinated `ado-work-items.py search`, `query`, and
`get` helpers described in
[work item operations](skills/azure-devops/references/work-items.md).
Use search for keywords and WIQL for exact field predicates. The local `wiql`
builder emits `[System.TeamProject] = @Project`; callers must keep that predicate
applicable to every OR branch. CLI `query` preserves raw responses and WIQL;
`--project` supplies context, not ownership enforcement.

The bundled helpers emit JSON on stdout and diagnostics on stderr. Permission,
authentication, branch policy, and unsupported-resource errors are surfaced
instead of being hidden.
Agent-authored PR descriptions, review comments, and replies created by the
helpers include the visible `- Generated with AI 🤖` suffix. Direct Azure CLI
text posts should include it once as well, so readers can distinguish an agent's
words from a user's.

## Request pacing and readiness

Use the snapshot helper for readiness checks:

```sh
uv run plugins/azure-devops/skills/azure-devops/scripts/ado-pr.py snapshot --id 4821 --org https://dev.azure.com/example
```

The snapshot combines fresh PR details, reviewers, threads, policies, and
current-merge build results. It reuses PR scope, follows collection pagination,
and checks that the revision did not change during the read. A missing or failed
check is an error, not evidence that the PR is ready. Merge monitoring uses one
snapshot per pass and refreshes before enabling auto-complete.
Active snapshots require documented thread statuses. PR details require a
recognized merge status and complete reviewer votes at both the initial read
and final revision fence. A recognized conflict or pending state remains visible
to callers; it is not a ready result.

Plugin-owned HTTP requests share per-organization concurrency and cooldown state
on the same machine. The client honors `Retry-After` on successful and failed
responses. Safe reads have bounded retries. Writes are not automatically replayed
after an uncertain response. HTTP 4xx write responses record a rejection and allow
a later explicit retry. Transport failures and HTTP 5xx responses remain unknown
and require reconciliation before further publication.

Commit-addressed file contents use a bounded credential-isolated cache.
Concurrent reads of the same content share one fetch. Mutable PR, thread,
policy, and build readiness results are not reused across monitoring passes.

This coordination does not include raw Azure CLI commands, independently
registered MCP servers, or agents on another machine. Those requests can consume
the same ADO identity's service budget. The plugin reduces redundant reads and
request bursts; it does not remove Azure DevOps usage limits.

Each collection or snapshot shares a 60-second read budget across its requests.
An expired budget returns `incomplete_read`, not a partial readiness result.

Set `ADO_REQUEST_DIAGNOSTICS` to `1` to emit sanitized request, quota, cooldown,
and cache metadata on stderr. Diagnostics exclude resource identifiers,
credentials, raw headers, and authored text.

## Cross-platform checks

The Azure DevOps helpers workflow runs the Python request-owner tests on Windows,
macOS, and Linux without ADO credentials or live writes.

The backend uses OS-held locks rather than Unix-only process signaling.
Lock files can remain empty: opening a contender never writes into a byte
another owner may have locked on Windows.
Windows Azure CLI authentication must use a native executable or its bundled
Python interpreter, not a shell command assembled from PR text.

Attachment helpers return a ready-to-paste `markdown` field: inline image
Markdown for screenshots and `<video src="..." controls width="800"></video>`
for recordings. Agents prefer these embeds in PR descriptions and comments so
reviewers can see images or play videos without following a download link.
Browser-playable MP4 is preferred. Other file types remain ordinary links;
media links are used only when requested or when the target ADO surface cannot
render the embed. Uploading is separate from updating a description or posting
a comment.

## Resources

- [Azure DevOps CLI documentation](https://learn.microsoft.com/azure/devops/cli/)
- [Azure DevOps REST API reference](https://learn.microsoft.com/rest/api/azure/devops/)
- [Azure Boards WIQL reference](https://learn.microsoft.com/azure/devops/boards/queries/wiql-syntax)
- [Agent Skills specification](https://agentskills.io/specification)
