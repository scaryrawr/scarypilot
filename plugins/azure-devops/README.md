# Azure DevOps Plugin

Use GitHub Copilot CLI to work with Azure DevOps pull requests and Azure Boards
work items. The plugin includes a general Azure DevOps skill plus an agent-merge
workflow for driving pull requests through review, policy checks, conflicts, and
safe squash auto-complete, with recurring same-session monitoring until the PR
completes or needs human intervention. It also includes a local paired-review
canvas for exploring the changed-file tree, diffs, and draft findings with the
agent before anything is posted to Azure DevOps.

## Prerequisites

- A current GitHub Copilot CLI release with plugin and skill support.
- A GitHub Copilot app build with canvas extension support for paired review.
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
- "Show the active work items assigned to me in Azure Boards."
- "Update this Azure DevOps work item and link it to its parent."
- "Parse this dev.azure.com URL and route it to the right workflow."

Start the paired-review canvas with an Azure DevOps pull request URL:

```text
/paired-review https://dev.azure.com/example/project/_git/repo/pullrequest/4821
```

You can also ask naturally for a private review:

```text
Let's review https://dev.azure.com/example/project/_git/repo/pullrequest/4821.
Keep findings local and ask me before posting anything.
```

Private, conversational review prompts route to the paired-review canvas instead
of the checkout-and-comment workflow. The agent inspects the canvas-loaded
changes, keeps findings local, and summarizes concerns for discussion.

The command opens a localhost-only canvas and the extension loads pull request
metadata, changed paths, file contents, and existing inline review threads through
the shared Python request owner, using Azure CLI credentials or a configured
Azure DevOps PAT. The extension launches the bundled helper with `uv`; `uv`
must be available on its PATH.
It creates unified diffs locally, so the command works outside a checkout and
does not require the agent to make Azure DevOps calls. The canvas inherits the
Copilot app theme and presents a native-style changed-file tree and unified diff.
Select one or more changed lines to open an inline conversation anchored at that
location. Each thread keeps its own transcript while using the current Copilot
session to answer. Thread turns contain only a small locator and the latest user
message; the agent retrieves bounded selected-line context, prior messages, or
additional file ranges through local canvas actions when needed. If the canvas
is opened from the matching repository, the agent may also use read-only local
file and Git context. Collapsed unchanged regions can be expanded in place to
inspect more surrounding code. Active conversation threads can be collapsed,
and resolved concerns remain as compact inline markers that can be reopened.
Azure DevOps feedback is shown inline with its original author and status. Use
**Ask Copilot** to discuss any feedback privately without posting a reply, or
**Fix with Copilot** to have Copilot apply the smallest suitable change in the
current workspace only when it is the matching pull request checkout. These
actions never reply to, resolve, vote on, or otherwise mutate the Azure DevOps
pull request.
After the pull request loads, select **Start Copilot review**. Copilot inspects
every changed file through bounded local actions and adds only high-confidence
local findings. The canvas shows each pass as queued, running, complete, or
failed. Findings remain local until you ask Copilot to publish selected findings
or all open findings. The browser has no publish control or publication route.
During a publication pass, the request owner locks the PR, lists current threads
once, and updates its duplicate index after each confirmed write. It skips
only a duplicate that has the same hidden finding marker or the same path,
side, range, and canonically normalized first comment. Normalization standardizes
Unicode, line endings, trailing line whitespace, and outer whitespace. Retrying
a publish request therefore adopts a prior remote write instead of creating
another thread.
If a cooldown blocks an unsent finding, the batch returns a failure for that
finding while preserving confirmed publications and duplicates. Unsent findings
are not journaled and can be submitted in a later explicit publish request.
An uncertain submission is recorded for reconciliation rather than blindly
repeated. Separate cooperating plugin processes on the same machine share the
publication lock and recovery state.

Agents can also create a local finding directly from chat after the paired-review
canvas has loaded; a full review pass is not required. Creating or refocusing a
finding updates the canvas to select its file, expand its thread, and scroll it
into view through the `focus_review_target` canvas action. The returned navigation
target contains only the canvas identity, pull request URL, and local thread
ID—never the localhost server token. Files and directories with conversations
display an explicit marker in the changed-file tree: filled for open conversations
and outlined for resolved-only conversations.

The renderer is a prebuilt React application using
[`@pierre/diffs`](https://github.com/pierrecomputer/pierre). A small built-in
Node HTTP server serves the bundled JavaScript and CSS over loopback, so source
and diff content remain local and the canvas does not load scripts or styles
from a CDN. The extension listens for the normal SDK shutdown event instead of
registering permission-gated session hooks.

The checked-in runtime artifacts are generated with:

```sh
cd plugins/azure-devops/extensions/paired-review
npm run build
npm run check:bundle
```

Vite emits the React/Pierre client as a compact static payload, while
Rolldown-powered `tsdown` bundles the extension backend. The installed plugin includes the root `extension.mjs` loader, generated `dist/`
and `public/` directories, and sibling Python helpers. Users do not need
`node_modules`, but the backend requires `uv` and Azure CLI authentication or a
configured Azure DevOps PAT.

The bundled helpers emit JSON on stdout and diagnostics on stderr. Permission,
authentication, branch policy, and unsupported-resource errors are surfaced
instead of being hidden.
Agent-authored PR descriptions, review comments, and replies created by the
helpers (and published paired-review findings) include the visible
`- Generated with AI 🤖` suffix. Direct Azure CLI text posts should include it
once as well, so readers can distinguish an agent's words from a user's.

## Request pacing and readiness

Use the read-only `azure_devops_pr_snapshot` extension tool with a PR URL for
readiness checks. The CLI equivalent is:

```sh
uv run plugins/azure-devops/skills/azure-devops/scripts/ado-pr.py snapshot --id 4821 --org https://dev.azure.com/example
```

The snapshot combines fresh PR details, reviewers, threads, policies, and
current-merge build results. It reuses PR scope, follows collection pagination,
and checks that the revision did not change during the read. A missing or failed
check is an error, not evidence that the PR is ready. Merge monitoring uses one
snapshot per pass and refreshes before enabling auto-complete.

Plugin-owned HTTP requests share per-organization concurrency and cooldown state
on the same machine. The client honors `Retry-After` on successful and failed
responses. Safe reads have bounded retries. Writes are not automatically replayed
after an uncertain response. HTTP 4xx write responses record a rejection and allow
a later explicit retry. Transport failures and HTTP 5xx responses remain unknown
and require reconciliation before further publication.

Commit-addressed file contents use a bounded credential-isolated cache.
Concurrent reads of the same content share one fetch. Mutable PR, thread,
policy, and build readiness results are not reused across monitoring passes.
Canvas content limits still apply and omitted content remains visible.

This coordination does not include raw Azure CLI commands, independently
registered MCP servers, or agents on another machine. Those requests can consume
the same ADO identity's service budget. The plugin reduces redundant reads and
request bursts; it does not remove Azure DevOps usage limits.

Each collection or snapshot shares a 60-second read budget across its requests.
An expired budget returns `incomplete_read`, not a partial readiness result.

Paired-review content loads use a bounded `readItems` bridge operation, not one
Python launch per file revision or a background daemon. Each stdin request names
one organization, project and repository, and 1–8 ordered `{path, commit}` items
with full commit SHAs. One Python client/transport and credential memo serve the
whole batch, including cache hits. Results retain the exact request order:
`text` with content, `binary`, or `error` with explicit error/code and optional
cooldown metadata. Only `content_too_large` becomes an oversized-file omission;
other item failures fail the load rather than masquerading as binary content.

The loader reads up to four changed files (eight revisions) per batch, one batch
at a time, and stops fetching once its 32 MiB retained-content budget is spent.
Each item retains the 2 MiB decoded UTF-8 and 8 MiB raw HTTP response limits.
Normalized batch results contain at most 16 MiB of decoded content; ASCII JSON
escaping can expand this to 96 MiB, so the process output buffer is 96 MiB plus
64 KiB for bounded error/structure overhead, not the ordinary 32 MiB buffer.
Python streams that output rather than constructing an aggregate encoded string.
Each batch shares a 60-second total deadline, and requests still acquire the
existing organization-wide maximum of four HTTP permits. No new write path is
introduced. For 2,000 edited files within the retained-content budget, this is at
most 500 content-owner launches instead of 4,000.

Set `ADO_REQUEST_DIAGNOSTICS` to `1` to emit sanitized request, quota, cooldown,
and cache metadata on stderr. Diagnostics exclude resource identifiers,
credentials, raw headers, and authored text.

## Cross-platform checks

The paired-review workflow includes Windows, macOS, and Linux jobs. Each job runs
the Python request-owner tests, extension tests, typechecks, and installed-bundle
smoke check without ADO credentials or live writes.

The installed-layout tests launch native `uv` or `uv.exe` with a Python fixture.
They cover source and bundled entry points, paths containing spaces, stdin text,
and fresh snapshot calls. The backend uses OS-held locks rather than Unix-only
process signaling. Windows Azure CLI authentication must use a native executable
or its bundled Python interpreter, not a shell command assembled from PR text.
Bridge input and helper output use UTF-8 explicitly, and bridge output escapes
non-ASCII JSON characters so Windows pipe encodings do not corrupt text.

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
