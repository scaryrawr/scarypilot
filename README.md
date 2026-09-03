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
| **ado-codespaces**  | DevOps             | Supervise Azure DevOps coding agents that run in GitHub Codespaces.                                                                                                  | [📖 Docs](./plugins/ado-codespaces/README.md)           |
| **azure-devops**    | DevOps             | Create, inspect, review, and drive Azure DevOps pull requests through completion, plus manage Azure Boards work items.                                                  | [📖 Docs](./plugins/azure-devops/README.md)             |
| **better-init**      | Workflow           | Create concise, Copilot-aware repository instructions, path-scoped guidance, reusable skills, and custom agents.                                                       | [📖 Docs](./plugins/better-init/README.md)              |
| **chrome-devtools** | Browser Automation | Chrome DevTools Protocol integration for automation, debugging, accessibility testing (WCAG), and performance analysis (Core Web Vitals). Includes specialized agents. | [📖 Docs](./external_plugins/chrome-devtools/README.md) |
| **copilot-autoresearch** | Workflow       | Measurable, resumable experiment loops with Copilot CLI tools, commands, skills, Git integration, and live reporting.                                                  | [📖 Docs](./plugins/copilot-autoresearch/README.md)     |
| **copilot-local-llm** | AI Models        | Discovers supported local LLM servers and registers their models in Copilot sessions.                                                                                   | [📖 Docs](./plugins/copilot-local-llm/README.md)        |
| **digivolution**    | Workflow           | Skill-only post-task reflection for keeping repo instructions and stale in-repo skills accurate.                                                                       | [📖 Docs](./plugins/digivolution/README.md)             |
| **omlx-media**      | Media              | Generate and edit images or turn recordings into transcripts, screenshots, and grounded written content with local OMLX models.                                       | [📖 Docs](./plugins/omlx-media/README.md)               |
| **playwright-ext**  | Browser Automation | Browser automation using Playwright with extension bridge. Testing, web scraping, form automation with logged-in sessions.                                             | [📖 Docs](./external_plugins/playwright-ext/README.md)  |
| **pstack**          | Workflow           | Copilot-native pstack workflows with deterministic status, durable handoffs, capability gates, and verification receipts.                                                | [📖 Docs](./external_plugins/pstack/README.md)          |
| **screen-record**   | Media              | Record agent-driven demos and edit them with trimming, side-by-side layouts, captions, and local narration.                                                              | [📖 Docs](./plugins/screen-record/README.md)            |
| **smahties**        | Code Search        | Local semantic code-search MCP server from smahtutils with indexing, embeddings, and keyword/hybrid query support. Requires the `smahties` CLI first.                  | [📖 Docs](./plugins/smahties/README.md)                 |

**Install any plugin:**

```sh
copilot plugin install <plugin-name>@scarypilot
```

## Plugin Architecture

This marketplace supports multiple plugin patterns:

- **Skill-Based Plugins**: Install reusable workflows and their bundled helpers
- **MCP-Based Plugins**: Integrate external Model Context Protocol servers
- **Extension-Based Plugins**: Run Copilot CLI extensions that add tools,
  commands, hooks, providers, and other session behavior
- **Agent-Based Plugins**: Define specialized agent behaviors for complex tasks
- **LSP-Based Plugins**: Enable language server integration for code intelligence

## Contributing

Interested in adding plugins to this marketplace? Check out the plugin development documentation:

- [Plugin Architecture Guide](./AGENTS.md)
- [Marketplace Configuration](./.github/plugin/marketplace.json)
