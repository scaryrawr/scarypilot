# Copilot Instructions

This is a GitHub Copilot plugin marketplace repository ("ScaryPilot"). It contains curated plugins that extend Copilot's capabilities with specialized tools for development, debugging, automation, and more.

## Repository Structure

- `plugins/`: First-party plugins maintained in this repository
  - `azure-devops/`: Azure DevOps CLI integration (skills-based)
  - `codespaces/`: GitHub Codespaces connection and remote command execution (skills-based)
  - `copilot/`: Copilot repository initialization workflow (skills-based)
  - `ghostty/`: Ghostty terminal automation on macOS (skills-based)
  - `ollama/`: Local image generation via Ollama REST API (skills-based)
  - `tmux/`: Remote control tmux sessions for interactive CLIs (skills-based)
  - `worktrunk/`: Disk-aware parallel worktree management (skills-based)
- `external_plugins/`: Wrappers around third-party MCP servers
  - `chrome-devtools/`: Chrome DevTools Protocol integration (MCP-based, with agent profiles)
  - `playwright-ext/`: Playwright browser automation (MCP-based)
- `.github/plugin/marketplace.json`: Marketplace manifest listing all available plugins

## Plugin Architecture

Choose the pattern that best fits the capability being added:

| Pattern | Use when | Location |
|---------|----------|----------|
| **Skills** | Providing step-by-step instructions or workflows the agent executes | `plugins/*/skills/*/SKILL.md` |
| **MCP** | Wrapping an external server that exposes tools/resources | `external_plugins/*/.mcp.json` |
| **Agents** | Defining a specialized persona with a constrained tool set | `external_plugins/*/agents/*.md` or `plugins/*/agents/*.md` |
| **LSP** | Integrating a language server for code intelligence | `plugins/*/lsp.json` |

### SKILL.md frontmatter

```yaml
---
name: skill-name          # matches the directory name
description: "One sentence describing when to invoke this skill."
# Optional for derived/adapted work:
license: Apache-2.0
metadata:
  attribution: "Based on X by Author from URL - Licensed under Y"
---
```

### Agent frontmatter

```yaml
---
name: agent-name
description: "One sentence describing the agent's specialty and when to use it."
model: 'inherit'          # or a specific model ID
tools: ["Read", "Grep", "Glob", "Bash", "mcp-server/*"]
---
```

### marketplace.json entry

```json
{
  "name": "plugin-name",
  "description": "One sentence plugin description.",
  "author": { "name": "Author Name" },
  "source": "./plugins/plugin-name"   // or ./external_plugins/plugin-name
}
```

### Skills with shell dependencies

Skills that invoke shell tools (tmux, gh, ghostty, etc.) must set up the full environment before testing. Do not assume helpers are globally available — source or load all plugin files before running smoke tests. A test that passes with only a subset of files sourced is not valid.

## Key Guidelines

1. **Plugin structure**: Each plugin lives in its own directory under `plugins/` or `external_plugins/` and must include a `README.md`
2. **Marketplace manifest**: When adding or removing plugins, update `.github/plugin/marketplace.json` to keep the registry in sync
3. **Markdown-first**: Plugin configuration is primarily done through Markdown files (skills, agents) and JSON (MCP servers, LSP configs)
4. **Attribution**: External or adapted plugins must include proper attribution and license information (see `plugins/tmux/` for an example)
5. **Documentation**: Every plugin README should include: what it does, installation prerequisites, installation steps, usage examples, and resource links
6. **No build system**: This repository has no build step or test suite — validation is done through manual review
