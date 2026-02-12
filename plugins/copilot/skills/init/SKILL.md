---
name: init
description: When helping a user better prepare a folder/repository for coding with copilot.
---

# Creating Copilot Instructions

Configure instructions for this repository as documented in [Best practices for Copilot coding agent in your repository](https://gh.io/copilot-coding-agent-tips). If possible use subagents to explore and gather required information.

## What to include

1. Build, test, and lint commands - If they exist, include how to run a single test, not just the full suite.
2. High-level architecture - Focus on the big picture across files, packages, and modules in the repository.
3. Code style guidelines - Patterns and practices to follow based on reading existing code across multiple files in the repository.

## Path Specific Instructions

If there are specific instructions for certain paths in the repository, include those as well. For example, if there are different coding styles or architectural patterns in different parts of the repository, provide instructions for each path to help the agent understand how to assist users effectively.

Paths can be used for file extensions, but also to apply instructions to specific packages and folders.

If there are specific instructions for specific styles of tests or extensions for specific testing frameworks. For example, integration tests, e2e tests, or unit tests may have different conventions and best practices. Providing instructions for each type of test can help the agent understand how to assist users effectively.

## Custom Agents

Create custom agents to perform specific tasks based on the repository's needs. Examine dependencies and coding styles to determine which agents would be most helpful and what specializations they should have. Examples include:

- Code Reviewer - When a user asks for a code review, the agent can provide feedback based on the repository's coding style and best practices.
- Test Specialist - When a user asks for help with testing, the agent can provide guidance on how to write tests that align with the repository's testing framework and conventions.
- UX Framework Reviewer - When a user asks for help with UX, the agent can provide feedback based on the repository's UX framework and design patterns.

## Custom Skills

[About agent skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills).

### Skills to include

Create new skills as needed in `.github/skills` in the current repo. Do not create skills that appear to already exist. Some skills are not needed in smaller repositories and depend on the scale of the repository. Examples:

- PR Skills based on the contribution guidelines/PR templates/best practices for the repository.
- Validation skills based on the build/test/lint commands for the repository.
- Review skills based on the code style guidelines and high-level architecture of the repository.
- Creation skills based on any guides or best practices for creating new packages, modules, or files in the repository.
