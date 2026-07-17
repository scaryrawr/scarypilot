# ScaryPilot Plugin Marketplace

A curated collection of plugins for GitHub Copilot, including custom plugins and integrations with external MCP servers. This marketplace enhances Copilot's capabilities with specialized tools for development, debugging, automation, and more.

## Quick Start

### Add the Marketplace

```sh
copilot plugin marketplace add scaryrawr/scarypilot
```

### Install a Plugin

Use the `/plugin` command in copilot or install from the terminal:

```sh
copilot plugin install chrome-devtools@scarypilot
```

## Available Plugins

| Plugin              | Category           | Description                                                                                                                                                            | Docs                                                   |
| ------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **chrome-devtools** | Browser Automation | Chrome DevTools Protocol integration for automation, debugging, accessibility testing (WCAG), and performance analysis (Core Web Vitals). Includes specialized agents. | [📖 Docs](./external_plugins/chrome-devtools/README.md) |
| **digivolution**    | Workflow           | Agent self-improvement hooks and skills that encourage durable updates to repo instructions and stale in-repo skills.                                                  | [📖 Docs](./plugins/digivolution/README.md)             |
| **microsoft-docs**  | Documentation      | Search and retrieve Microsoft Learn documentation, tutorials, and API references directly from Copilot.                                                                | [📖 Docs](./external_plugins/microsoft-docs/README.md)  |
| **playwright-ext**  | Browser Automation | Browser automation using Playwright with extension bridge. Testing, web scraping, form automation with logged-in sessions.                                             | [📖 Docs](./external_plugins/playwright-ext/README.md)  |
| **smahties**        | Code Search        | Local semantic code-search MCP server from smahtutils with indexing, embeddings, and keyword/hybrid query support. Requires the `smahties` CLI first.                  | [📖 Docs](./plugins/smahties/README.md)                 |

**Install any plugin:**

```sh
copilot plugin install <plugin-name>
```

## Plugin Architecture

This marketplace supports multiple plugin patterns:

- **MCP-Based Plugins**: Integrate external Model Context Protocol servers
- **Agent-Based Plugins**: Define specialized agent behaviors for complex tasks
- **LSP-Based Plugins**: Enable language server integration for code intelligence

## Contributing

Interested in adding plugins to this marketplace? Check out the plugin development documentation:

- [Plugin Architecture Guide](./.github/copilot-instructions.md)
- [Marketplace Configuration](./.github/plugin/marketplace.json)
