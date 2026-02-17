# Copilot Plugin

Bootstrap a repository for GitHub Copilot by generating coding instructions, custom agents, and custom skills tailored to your project.

## What This Plugin Does

- Generates a `copilot-instructions.md` with build/test/lint commands, architecture overview, and code style guidelines
- Creates path-specific instructions for different parts of the repository (e.g., test conventions, package-level patterns)
- Scaffolds custom agents based on your project's needs (code reviewer, test specialist, UX reviewer, etc.)
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
