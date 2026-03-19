---
name: init
description: Quickly bootstrap repo-specific Copilot instructions with high signal and low context bloat.
disable-model-invocation: true
---

# Creating Copilot Instructions

Configure instructions as documented in [Best practices for Copilot coding agent in your repository](https://gh.io/copilot-coding-agent-tips). Use subagents to explore first, then create or update `.github/copilot-instructions.md` with only durable, repo-specific guidance.

Optimize for fast onboarding: help a new agent become productive quickly without adding noisy or redundant instructions.

## What to include

1. Build, test, and lint commands - Include fast local commands and at least one single-test command when available.
2. High-level architecture - Capture major modules, boundaries, and where key responsibilities live.
3. Style and patterns - Record conventions that are specific to this repo and repeated across multiple files.
4. Operating constraints - Include any important safety rules, approval workflows, or environment limits.

Keep this section compact. Prefer short bullets over long prose, and avoid instructions that can be inferred from common language defaults.

## Path Specific Instructions

Add path-specific rules only when behavior genuinely differs by folder, package, or file type. Create them as `.github/instructions/<name>.instructions.md` files with `applyTo` frontmatter so Copilot loads them only for matching paths.

Paths can target file extensions and concrete directories. Focus on high-impact differences such as:

- Different test frameworks or test styles (unit/integration/e2e)
- Different architectural patterns by package
- Different review or validation requirements by area

## Custom Agents

[Create custom agents](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/create-custom-agents) in `.github/agents/<name>.agent.md` for repeated, specialized tasks where a constrained toolset and focused persona improve outcomes.

When defining agents:

- Scope each agent to one clear job (for example: code review, test debugging, migration planning).
- Give each agent clear YAML frontmatter and a focused prompt; include `description`, and add `name` or `tools` when they improve discoverability or tool safety.
- Keep the tool list minimal and intentional.
- Make it obvious when a human or main agent should choose this specialist.
- Do not create agents that duplicate general-purpose behavior.

## Custom Skills

[About agent skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills).

### Skills to include

Create skills in `.github/skills` for repeatable multi-step workflows with clear entry and exit conditions.

Prioritize skills that reduce time-to-first-success in the repo:

- Repo bootstrap and setup verification
- Fast validation (format/lint/test pathways)
- PR hygiene and contribution workflow
- Common creation workflows (new package/module/component)

Do not create skills that already exist, and avoid niche skills unless they are used frequently.

## Custom Hooks

Consider adding custom hooks in `.github/hooks/<name>.json` as documented in [Using hooks with GitHub Copilot agents](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/use-hooks).

Use hooks as lightweight guardrails:

- Post-tool formatting and quick validation checks (keep them fast).
- Pre-tool approval for expensive or risky commands (for example full builds/tests/lints).

Avoid long-running tasks in hooks; keep hook latency low to prevent workflow friction.
