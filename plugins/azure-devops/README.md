# Azure DevOps Plugin

Intelligent Azure DevOps integration for GitHub Copilot. Manages pull requests and work items through the Azure CLI with automatic URL parsing and context-aware actions.

> **⚠️ Note:** Some commands and features in this plugin are AI-generated/vibe-coded. While functional, they may require adjustments for your specific Azure DevOps setup. Always review generated actions before executing in production environments.

## What This Plugin Does

- Detects Azure DevOps URLs and infers appropriate actions
- Manages pull requests (review, checkout, approve, merge)
- Works with work items (view, update, query)
- Automates common Azure DevOps workflows

## Installation

1. Install [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) and the DevOps extension:

   ```bash
   az extension add --name azure-devops
   az login
   az devops configure --defaults organization=https://dev.azure.com/YourOrganization
   ```

2. Install the plugin:

   ```bash
   copilot plugin marketplace add scaryrawr/scarypilot
   copilot plugin install azure-devops@scarypilot
   ```

## Usage Examples

**Review a pull request:**

```text
"Can you review this PR? https://dev.azure.com/myorg/myproject/_git/myrepo/pullrequest/123"
```

**Checkout and work on a PR:**

```text
"I want to work on https://dev.azure.com/myorg/myproject/_git/myrepo/pullrequest/456"
```

**View work item:**

```text
"Show me work item https://dev.azure.com/myorg/myproject/_workitems/edit/12345"
```

**Query your work items:**

```text
"Show me all work items assigned to me"
```

## Resources

- [Azure CLI Documentation](https://learn.microsoft.com/en-us/cli/azure/)
- [Azure DevOps CLI Extension](https://learn.microsoft.com/en-us/azure/devops/cli/)
