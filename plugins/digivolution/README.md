# Digivolution Plugin

Digivolution helps agents leave repositories in a state that's easier for the next agent to work in. It provides a post-task reflection skill for updating durable repo guidance when a task reveals stale, missing, or misleading instructions.

Use it to keep these surfaces accurate and high signal:

- `AGENTS.md`
- `CLAUDE.md` shims
- `.github/copilot-instructions.md`
- `.github/instructions/*.instructions.md`
- In-repo skills such as `.github/skills/**/SKILL.md` or `plugins/*/skills/**/SKILL.md`

The plugin is skill-only. It does not install hooks, force an extra agent turn, or run background scripts. Invoke it when reflection is useful; the agent can silently do nothing when no durable update is needed.

## Prerequisites

- GitHub Copilot CLI with plugin and skill support.

## Installation

```bash
copilot plugin marketplace add scaryrawr/scarypilot
copilot plugin install digivolution@scarypilot
```

## Usage

Digivolution is most useful near the end of a task, after the agent has learned something durable about a repository.

Example prompts:

- "Use digivolution before finishing this task."
- "Digivolve before you finish."
- "If you discovered any durable repo guidance, update the right instruction file."
- "Check whether any in-repo skill you used is stale or misleading, and correct it if needed."
- "Before you finish, decide whether AGENTS.md or Copilot instructions need a concise update."

The skill should:

1. Prefer correcting existing guidance over duplicating text.
2. Use the narrowest appropriate destination for any change.
3. Make no edit when there is no durable improvement and avoid a no-op status that interrupts task completion.

## Resources

- [Creating a plugin for GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-creating)
- [Adding custom instructions for GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions)
- [Agent Skills specification](https://agentskills.io/specification)
