# Copilot Instructions

This is a GitHub Copilot plugin marketplace repository ("ScaryPilot"). It contains curated plugins that extend Copilot's capabilities with specialized tools for development, debugging, automation, and more.

## Repository Structure

- `plugins/`: First-party plugins maintained in this repository
  - `azure-devops/`: Azure DevOps CLI integration (skills-based)
  - `typescript-native-lsp/`: TypeScript/JavaScript language server using `tsgo` (LSP-based)
  - `tmux/`: Remote control tmux sessions for interactive CLIs (skills-based)
- `external_plugins/`: Wrappers around third-party MCP servers
  - `chrome-devtools/`: Chrome DevTools Protocol integration (MCP-based, with agent profiles)
  - `playwright-ext/`: Playwright browser automation (MCP-based)
- `.github/plugin/marketplace.json`: Marketplace manifest listing all available plugins

## Plugin Architecture

This marketplace supports multiple plugin patterns:

- **Skills-based plugins** (`plugins/*/skills/*/SKILL.md`): Contextual instructions for specific domains
- **MCP-based plugins** (`external_plugins/*/.mcp.json`): Integrate external Model Context Protocol servers
- **Agent-based plugins** (`external_plugins/*/agents/*.md`): Specialized agent behaviors with frontmatter config
- **LSP-based plugins** (`plugins/*/lsp.json`): Language server integration for code intelligence

## Key Guidelines

1. **Plugin structure**: Each plugin lives in its own directory under `plugins/` or `external_plugins/` and must include a `README.md`
2. **Marketplace manifest**: When adding or removing plugins, update `.github/plugin/marketplace.json` to keep the registry in sync
3. **Markdown-first**: Plugin configuration is primarily done through Markdown files (skills, agents) and JSON (MCP servers, LSP configs)
4. **Attribution**: External or adapted plugins must include proper attribution and license information (see `plugins/tmux/` for an example)
5. **Documentation**: Every plugin README should include: what it does, installation prerequisites, installation steps, usage examples, and resource links
6. **No build system**: This repository has no build step or test suite — validation is done through manual review
