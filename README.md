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
| **anti-slop**       | Code Quality       | Full bundled Anti-Slop checks after edits, plus focused pre-edit guardrails, without repository lint setup.                                                       | [📖 Docs](./plugins/anti-slop/README.md)                |
| **azure-devops**    | DevOps             | Create, inspect, and review Azure DevOps pull requests, drive them through completion, and manage Azure Boards work items.                       | [📖 Docs](./plugins/azure-devops/README.md)             |
| **better-init**      | Workflow           | Create concise repository instructions and a code-review skill by default, with additional Copilot guidance and agents when needed.                                   | [📖 Docs](./plugins/better-init/README.md)              |
| **chrome-devtools** | Browser Automation | Chrome DevTools Protocol integration for automation, debugging, accessibility testing (WCAG), and performance analysis (Core Web Vitals). Includes specialized agents. | [📖 Docs](./external_plugins/chrome-devtools/README.md) |
| **copilot-autoresearch** | Workflow       | Measurable, resumable experiment loops with Copilot CLI tools, commands, skills, Git integration, and live reporting.                                                  | [📖 Docs](./plugins/copilot-autoresearch/README.md)     |
| **digivolution**    | Workflow           | Adaptive post-task reflection that triggers only on strong evidence of durable repository learning.                                                                    | [📖 Docs](./plugins/digivolution/README.md)             |
| **omlx-media**      | Media              | Generate or edit images, synthesize speech, transcribe audio, or turn recordings into grounded written content with local OMLX models.                                | [📖 Docs](./plugins/omlx-media/README.md)               |
| **omlx-decisions** | AI Models | Use installed oMLX SystemOne decision models for routing, classification, and rubric evaluation. | [📖 Docs](./plugins/omlx-decisions/README.md) |
| **playwright-ext**  | Browser Automation | Browser automation using Playwright with extension bridge. Testing, web scraping, form automation with logged-in sessions.                                             | [📖 Docs](./external_plugins/playwright-ext/README.md)  |
| **pstack**          | Workflow           | Skill-based workflows, prompt rewriting, read-only catch-up, formal verification, model-checked statecharts, benchmark checks, and portable validation helpers.                | [📖 Docs](./external_plugins/pstack/README.md)          |
| **screen-record**   | Media              | Record agent-driven demos and edit them with trimming, side-by-side layouts, captions, and local narration.                                                              | [📖 Docs](./plugins/screen-record/README.md)            |
| **smahties**        | Code Search        | Local semantic code-search MCP server from smahtutils with indexing, embeddings, and keyword/hybrid query support. Requires the `smahties` CLI first.                  | [📖 Docs](./plugins/smahties/README.md)                 |
| **uv**              | Python             | Guide Copilot to run Python and manage Python dependencies with uv.                                                                                                   | [📖 Docs](./plugins/uv/README.md)                       |

**Install any plugin:**

```sh
copilot plugin install <plugin-name>@scarypilot
```

For local models, Copilot CLI supports Ollama discovery and manually configured
OpenAI-compatible providers. See [Adding LLM models to GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-llm-models).
Other local providers and their models must be configured manually.

## Plugin Architecture

This marketplace supports multiple plugin patterns:

- **Skill-Based Plugins**: Install reusable workflows and their bundled helpers
- **MCP-Based Plugins**: Integrate external Model Context Protocol servers
- **Extension-Based Plugins**: Run Copilot CLI extensions that add tools,
  commands, hooks, providers, and other session behavior
- **Agent-Based Plugins**: Define specialized agent behaviors for complex tasks
- **LSP-Based Plugins**: Enable language server integration for code intelligence

Native extensions target `@github/copilot-sdk` 1.0.16 for development.
Copilot supplies its own SDK at runtime. Pstack is skill-based and does not
require native extension support.

## Platform support

Shared plugins target Windows, macOS, and Linux with their documented prerequisites.
Native extensions require Node.js 22.18.0 or later and a Copilot host that supports
extensions. Platform CI checks extension startup and runtime contracts; it does not
prove that an external service, browser bridge, or capture device is available.

| Plugins | Platform requirements |
| --- | --- |
| `pstack` | Core skills target all three platforms. Statechart model checking additionally requires Java and TLC; PNG rendering needs an available Mermaid CLI and browser runtime. Stacked PR workflows use the official [`github/gh-stack`](https://github.com/github/gh-stack) extension for GitHub CLI. Confined artifact validation requires macOS or Linux and fails explicitly on unsupported platforms. Apple simulator workflows remain macOS-only. |
| `ado-codespaces`, `azure-devops` | Local clients target all three platforms. Codespaces workloads run in their Linux container. Azure DevOps workflows also need their documented CLI and authentication setup. |
| `anti-slop`, `better-init`, `digivolution` | Target all three platforms with their documented tools. |
| `uv` | Requires Node.js and uv on the Copilot CLI host. |
| `copilot-autoresearch` | Targets all three platforms with Bash installed. Experiment commands and repository-specific tools must match the execution host. |
| `chrome-devtools`, `playwright-ext`, `smahties` | Require the documented external browser bridge or CLI on the host. These integrations are not bundled implementations of those dependencies. |
| `screen-record` | Has Windows, macOS, and Linux capture backends. FFmpeg, capture permissions, and backend availability are required; Linux capture currently needs X11. |
| `omlx-media`, `omlx-decisions` | Local oMLX inference requires macOS on Apple Silicon. HTTP clients may use an explicitly configured remote oMLX server from other platforms, subject to each tool's transmission-consent rules. |

Do not translate POSIX shell snippets literally into PowerShell or `cmd.exe`.
Use the host shell's quoting and environment syntax, quote absolute helper paths,
and use bundled Node.js helpers where available.

## Contributing

Interested in adding plugins to this marketplace? Check out the plugin development documentation:

- [Plugin Architecture Guide](./AGENTS.md)
- [Marketplace Configuration](./.github/plugin/marketplace.json)
