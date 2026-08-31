# Azure DevOps Plugin

Use GitHub Copilot CLI to work with Azure DevOps pull requests and Azure Boards
work items. The plugin includes a general Azure DevOps skill plus an agent-merge
workflow for driving pull requests through review, policy checks, conflicts, and
safe auto-complete.

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

The bundled helpers emit JSON on stdout and diagnostics on stderr. Permission,
authentication, branch policy, and unsupported-resource errors are surfaced
instead of being hidden.

## Resources

- [Azure DevOps CLI documentation](https://learn.microsoft.com/azure/devops/cli/)
- [Azure DevOps REST API reference](https://learn.microsoft.com/rest/api/azure/devops/)
- [Azure Boards WIQL reference](https://learn.microsoft.com/azure/devops/boards/queries/wiql-syntax)
- [Agent Skills specification](https://agentskills.io/specification)
