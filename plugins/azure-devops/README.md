# Azure DevOps Plugin

Use GitHub Copilot CLI to work with Azure DevOps pull requests and Azure Boards
work items. The plugin includes a general Azure DevOps skill plus an agent-merge
workflow for driving pull requests through review, policy checks, conflicts, and
safe auto-complete. It also includes a local paired-review canvas for exploring
the changed-file tree, diffs, and draft findings with the agent before anything
is posted to Azure DevOps.

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
with safe auto-complete. It also supports Azure Boards queries, work item creation
and updates, WIQL, and work item links.

Example prompts:

- "Create an Azure DevOps pull request from my current branch."
- "Create an Azure DevOps PR and get it all the way through."
- "Use ADO agent merge on pull request 4821."
- "Review Azure DevOps pull request 4821 and post inline comments."
- "Show the active work items assigned to me in Azure Boards."
- "Update this Azure DevOps work item and link it to its parent."
- "Parse this dev.azure.com URL and route it to the right workflow."

Start the paired-review canvas with an Azure DevOps pull request URL:

```text
/paired-review https://dev.azure.com/example/project/_git/repo/pullrequest/4821
```

The command opens a localhost-only canvas and the extension loads pull request
metadata, changed paths, and file contents through the authenticated Azure CLI.
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
The paired-review extension has no endpoint for posting comments or votes;
publishing still requires the normal review workflow and its confirmation step.

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
Rolldown-powered `tsdown` bundles the extension backend. The small root
`extension.mjs` loader and generated `dist/` plus `public/` directories are
therefore sufficient at install time; users do not need `node_modules`.

The bundled helpers emit JSON on stdout and diagnostics on stderr. Permission,
authentication, branch policy, and unsupported-resource errors are surfaced
instead of being hidden.

## Resources

- [Azure DevOps CLI documentation](https://learn.microsoft.com/azure/devops/cli/)
- [Azure DevOps REST API reference](https://learn.microsoft.com/rest/api/azure/devops/)
- [Azure Boards WIQL reference](https://learn.microsoft.com/azure/devops/boards/queries/wiql-syntax)
- [Agent Skills specification](https://agentskills.io/specification)
