# Digivolution Plugin

Digivolution helps agents leave repositories easier for the next agent to work in. It adds a post-task reflection workflow that encourages an agent to update durable repo guidance when the task revealed stale, missing, or misleading instructions.

Use it to keep these surfaces accurate and high signal:

- `AGENTS.md`
- `CLAUDE.md` shims
- `.github/copilot-instructions.md`
- `.github/instructions/*.instructions.md`
- In-repo skills such as `.github/skills/**/SKILL.md` or `plugins/*/skills/**/SKILL.md`

The plugin is advisory: it does not directly auto-edit files. It reminds the active agent to decide whether an update is useful, and the agent can decide that no change is needed.

## Prerequisites

- GitHub Copilot CLI with plugin and hook support.
- Bash and Node.js. The hook uses a small Bash wrapper with Node.js for JSON parsing and state-file handling.

## Installation

```bash
copilot plugin marketplace add scaryrawr/scarypilot
copilot plugin install digivolution@scarypilot
```

## Usage

Digivolution is most useful near the end of a task, after the agent has learned something durable about a repository.

Example prompts:

- "Use digivolution before finishing this task."
- "If you discovered any durable repo guidance, update the right instruction file."
- "Check whether any in-repo skill you used is stale or misleading, and correct it if needed."
- "Before you finish, decide whether AGENTS.md or Copilot instructions need a concise update."

## Hook behavior and loop safety

The hook flow is designed to encourage one final reflection pass when an agent is about to stop:

1. Ask the agent to consider whether durable repo instructions or in-repo skills should be updated.
2. Prefer correcting existing guidance over duplicating text.
3. Use the narrowest appropriate destination for any change.
4. Allow the agent to make no edit when there is no durable improvement.

To avoid infinite stop-hook loops, Digivolution uses a one-time guard per session/repository. At most one forced continuation is allowed for the same repo in the same session; after that, the agent can finish normally. The hook should never repeatedly force itself, and it should never bypass the agent's judgment by applying direct automatic edits.

## Resources

- [Creating a plugin for GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-creating)
- [GitHub Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference)
- [Adding custom instructions for GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions)
- [Agent Skills specification](https://agentskills.io/specification)
