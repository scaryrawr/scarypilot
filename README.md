# ScaryRawr Plugins

A curated collection of plugins for Claude Code, including custom plugins and integrations with external MCP servers. This marketplace enhances Claude's capabilities with specialized tools for development, debugging, automation, and more.

## Quick Start

### Add the Marketplace

```sh
claude plugin marketplace add scaryrawr/scaryrawr-plugins
```

### Install a Plugin

Use the `/plugin` command in Claude Code or install from the terminal:

```sh
# Example: Install the TypeScript LSP plugin
claude plugin install typescript-native-lsp
```

## Available Plugins

| Plugin                    | Category           | Description                                                                                                                                                                | Docs                                                   |
| ------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **typescript-native-lsp** | Language Server    | Enhanced TypeScript/JavaScript code intelligence using Microsoft's native `tsgo`. Provides IntelliSense, type information, go-to-definition, refactoring, and diagnostics. | [📖 Docs](./plugins/typescript-native-lsp/README.md)    |
| **azure-devops**          | Integration        | Intelligent Azure DevOps integration with URL parsing, PR management, and work item tracking using Azure CLI.                                                              | [📖 Docs](./plugins/azure-devops/README.md)             |
| **chrome-devtools**       | Browser Automation | Chrome DevTools Protocol integration for automation, debugging, accessibility testing (WCAG), and performance analysis (Core Web Vitals). Includes specialized agents.     | [📖 Docs](./external_plugins/chrome-devtools/README.md) |
| **playwright-ext**        | Browser Automation | Browser automation using Playwright with extension bridge. Testing, web scraping, form automation with logged-in sessions.                                                 | [📖 Docs](./external_plugins/playwright-ext/README.md)  |

**Install any plugin:**

```sh
claude plugin install <plugin-name>
```

## Plugin Architecture

This marketplace supports multiple plugin patterns:

- **MCP-Based Plugins**: Integrate external Model Context Protocol servers
- **Skill-Based Plugins**: Provide contextual instructions for specific domains
- **Agent-Based Plugins**: Define specialized agent behaviors for complex tasks
- **LSP-Based Plugins**: Enable language server integration for code intelligence

## Contributing

Interested in adding plugins to this marketplace? Check out the plugin development documentation:

- [Plugin Architecture Guide](./.github/copilot-instructions.md)
- [Marketplace Configuration](./.claude-plugin/marketplace.json)
