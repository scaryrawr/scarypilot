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
copilot plugin install azure-devops@scarypilot
```

## Available Plugins

| Plugin              | Category           | Description                                                                                                                                                            | Docs                                                   |
| ------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **azure-devops**    | Integration        | Intelligent Azure DevOps integration with URL parsing, PR management, and work item tracking using Azure CLI.                                                          | [📖 Docs](./plugins/azure-devops/README.md)             |
| **chrome-devtools** | Browser Automation | Chrome DevTools Protocol integration for automation, debugging, accessibility testing (WCAG), and performance analysis (Core Web Vitals). Includes specialized agents. | [📖 Docs](./external_plugins/chrome-devtools/README.md) |
| **copilot**         | Skills             | Skills for working with GitHub Copilot, including repository initialization with coding instructions, custom agents, and custom skills.                                | [📖 Docs](./plugins/copilot/README.md)                  |
| **ghostty**         | Terminal           | Ghostty automation for opening windows/tabs/splits and driving terminals with focus/input for multitasking workflows on macOS.                                         | [📖 Docs](./plugins/ghostty/README.md)                  |
| **ollama**          | Image Generation   | Generate images from text prompts using Ollama's local image generation models (macOS-only). Supports Z-Image Turbo and FLUX.2 Klein.                                 | [📖 Docs](./plugins/ollama/README.md)                   |
| **playwright-ext**  | Browser Automation | Browser automation using Playwright with extension bridge. Testing, web scraping, form automation with logged-in sessions.                                             | [📖 Docs](./external_plugins/playwright-ext/README.md)  |
| **tmux**            | Terminal           | Remote control tmux sessions for interactive CLIs (Python REPL, gdb, etc.) by sending keystrokes and scraping pane output. Based on work by Armin Ronacher.           | [📖 Docs](./plugins/tmux/README.md)                     |

**Install any plugin:**

```sh
copilot plugin install <plugin-name>
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
- [Marketplace Configuration](./.github/plugin/marketplace.json)
