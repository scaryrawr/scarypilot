# Better Init Plugin

Better Init runs through GitHub Copilot CLI to create or refresh repository
guidance, including skills consumed by GitHub Copilot code review. It keeps
portable repository facts in `AGENTS.md` while moving Copilot-only behavior,
path-specific rules, reusable workflows, review procedures, and specialist
roles to their native locations.

The plugin provides:

- `/better-init` — inspects the repository and writes the smallest useful set
  of instruction, skill, and agent files.
- `repo-instruction-researcher` — an optional read-only custom agent for
  discovering commands, architecture, and existing guidance in large
  repositories.

Better Init does not replace Copilot CLI's built-in `/init` command. It provides
a more deliberate workflow that can improve existing `/init` output or start
from an uninitialized repository.

## Prerequisites

- GitHub Copilot CLI with plugin, skill, and custom-agent support.

## Installation

```bash
copilot plugin marketplace add scaryrawr/scarypilot
copilot plugin install better-init@scarypilot
```

## Usage

Invoke the skill directly:

```text
/better-init
```

You can also provide a focus:

```text
/better-init prioritize the contributor workflow and fast validation commands
```

```text
Refresh this repository's Copilot instructions and remove duplicated guidance.
```

The skill chooses among these surfaces:

| Surface | Purpose |
| --- | --- |
| `AGENTS.md` | Portable repository structure, commands, conventions, and safety constraints |
| `.github/copilot-instructions.md` | Copilot-specific operating behavior |
| `.github/instructions/*.instructions.md` | Guidance limited to matching paths |
| `.github/skills/*/SKILL.md` | Reusable workflows loaded only when relevant |
| `.github/agents/*.agent.md` | Specialist roles suitable for subagent delegation |

It does not create every surface by default. Each file must contain verified
guidance that would be misplaced or distracting elsewhere.

### Copilot code review

When a repository has non-obvious review requirements, Better Init can create
`.github/skills/code-review/SKILL.md`. The review-focused name helps GitHub
Copilot code review discover the skill from a pull request's head branch.

The generated skill should contain repository-specific checks such as migration
artifact synchronization, API compatibility rules, targeted validation, or use
of an MCP server that is already configured for review context. Better Init does
not create a generic checklist for ordinary bug, security, test, or style review.

## Resources

- [Adding custom instructions for GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions)
- [Adding agent skills for GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills)
- [Using GitHub Copilot code review](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review)
- [Creating custom agents for GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli)
- [Creating plugins for GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-creating)
