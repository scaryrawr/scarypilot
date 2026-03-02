---
name: init
description: Quickly bootstrap repo-specific Copilot instructions with high signal and low context bloat.
---

# Creating Copilot Instructions

Configure instructions as documented in [Best practices for Copilot coding agent in your repository](https://gh.io/copilot-coding-agent-tips). Use subagents to explore first, then write only durable, repo-specific guidance.

Optimize for fast onboarding: help a new agent become productive quickly without adding noisy or redundant instructions.

## What to include

1. Build, test, and lint commands - Include fast local commands and at least one single-test command when available.
2. High-level architecture - Capture major modules, boundaries, and where key responsibilities live.
3. Style and patterns - Record conventions that are specific to this repo and repeated across multiple files.
4. Operating constraints - Include any important safety rules, approval workflows, or environment limits.

Keep this section compact. Prefer short bullets over long prose, and avoid instructions that can be inferred from common language defaults.

## Path Specific Instructions

Add path-specific rules only when behavior genuinely differs by folder, package, or file type.

Paths can target file extensions and concrete directories. Focus on high-impact differences such as:

- Different test frameworks or test styles (unit/integration/e2e)
- Different architectural patterns by package
- Different review or validation requirements by area

## Custom Agents

Create custom agents for repeated, specialized tasks where a constrained toolset and focused persona improve outcomes.

When defining agents:

- Scope each agent to one clear job (for example: code review, test debugging, migration planning).
- Keep the tool list minimal and intentional.
- Add explicit invocation cues in instructions so the main agent knows when to delegate.
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

Consider adding custom hooks as documented in [hooks configuration](https://docs.github.com/en/copilot/reference/hooks-configuration).

Use hooks as lightweight guardrails:

- Post-tool formatting and quick validation checks (keep them fast).
- Pre-tool approval for expensive or risky commands (for example full builds/tests/lints).

Avoid long-running tasks in hooks; keep hook latency low to prevent workflow friction.
