# Copilot Plugin

Bootstrap a repository for GitHub Copilot by generating shared agent instructions, Copilot-specific guidance, custom agents, and custom skills tailored to your project.

## What This Plugin Does

- Creates a shared `AGENTS.md` instruction hierarchy (including nested `AGENTS.md` files when needed) as the primary source of durable guidance
- Creates `CLAUDE.md` files that reference corresponding `AGENTS.md` files using `@{FILE}` syntax (for example `@AGENTS.md`) to minimize duplication
- Generates a `.github/copilot-instructions.md` that focuses on Copilot-specific behavior and references corresponding `AGENTS.md` files
- Creates path-specific instructions in `.github/instructions/*.instructions.md` for different parts of the repository (e.g., test conventions, package-level patterns)
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

- [Best practices for Copilot coding agent in your repository](https://gh.io/copilot-coding-agent-tips)
- [About agent skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills)
