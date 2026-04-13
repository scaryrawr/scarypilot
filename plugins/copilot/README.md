# Copilot Plugin

Bootstrap a repository for GitHub Copilot by generating shared `AGENTS.md` guidance, Copilot-specific instruction files, compatibility shims for other agents, custom agents, and custom skills tailored to your project.

## What This Plugin Does

- Creates a shared root `AGENTS.md` for durable repo-wide guidance, with optional nested `AGENTS.md` files for shared subtree guidance when your workflow supports them (VS Code nested discovery is experimental and requires `chat.useNestedAgentsMdFiles`)
- Generates `.github/copilot-instructions.md` to layer Copilot-specific behavior on top of the shared `AGENTS.md` guidance
- Creates focused `.github/instructions/*.instructions.md` files with `applyTo` patterns for Copilot-only directory-, framework-, or file-type-specific guidance
- Adds a root `CLAUDE.md` only as a thin `@AGENTS.md` compatibility shim beside the root `AGENTS.md`
- Scaffolds custom agents in `.github/agents/*.agent.md` based on your project's needs (code reviewer, test specialist, UX reviewer, etc.)
- Scaffolds custom skills in `.github/skills` for PR workflows, validation, reviews, and more
- Analyzes repository structure, dependencies, and coding styles to produce relevant configuration

## Installation

```bash
copilot plugin marketplace add scaryrawr/scarypilot
copilot plugin install copilot@scarypilot
```

## Usage Examples

**Initialize a repository for Copilot:**

```text
"Initialize this repository for Copilot"
```

**Set up coding instructions:**

```text
"Set up coding instructions for this project"
```

**Create custom agents and skills:**

```text
"Create custom agents and skills for this repo based on its structure"
```

## Resources

- [VS Code custom instructions](https://code.visualstudio.com/docs/copilot/customization/custom-instructions)
- [About agent skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills)
