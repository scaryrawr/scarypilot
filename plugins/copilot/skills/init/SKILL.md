---
name: init
description: Quickly bootstrap repo-specific Copilot instructions with high signal and low context bloat.
disable-model-invocation: true
---

# Creating Shared and Copilot-Specific Instructions

Follow VS Code's [custom instructions guidance](https://code.visualstudio.com/docs/copilot/customization/custom-instructions). Explore the repo first, then create a layered instruction setup: shared guidance in `AGENTS.md`, Copilot-specific guidance in `.github/copilot-instructions.md`, and scoped `.instructions.md` files only when they add clear value.

Optimize for fast onboarding: help a new agent become productive quickly without adding redundant or generic guidance.

## Recommended instruction layout

1. Create or update a root `AGENTS.md` as the shared source of truth for durable repo-wide guidance.
   - Put architecture, preferred libraries, naming/style conventions, safety rules, and validation commands here.
   - Keep it concise, repo-specific, and reusable across agents.
2. Add nested `AGENTS.md` files in subdirectories only when shared guidance differs meaningfully by area and your tooling supports them.
   - In VS Code, nested `AGENTS.md` discovery is experimental and requires `chat.useNestedAgentsMdFiles`.
   - For stable Copilot path- or file-specific behavior, prefer `.github/instructions/*.instructions.md`.
3. Create or update `.github/copilot-instructions.md` to layer in Copilot-specific behavior.
   - Keep shared rules in `AGENTS.md` and use `.github/copilot-instructions.md` for Copilot/VS Code specifics, such as instruction discovery, prompt-shaping details, or explicit links to the relevant `AGENTS.md` files.
   - Avoid copying the full contents of `AGENTS.md` into Copilot-specific files.
4. Add `.github/instructions/*.instructions.md` only for Copilot-specific rules that should apply by `applyTo` pattern.
   - Use YAML frontmatter with `applyTo`, and optionally `name` and `description`.
   - Prefer focused files for test conventions, framework patterns, or docs rules.
5. Create a root `CLAUDE.md` only as a thin compatibility file next to the root `AGENTS.md`.
   - Its content should just be `@AGENTS.md`.
   - Do not duplicate or restate instructions in `CLAUDE.md`, and do not create nested `CLAUDE.md` shims that Copilot will not discover.

## What to include

1. Build, test, and lint commands - Include the default local commands and at least one narrow validation command when available.
2. High-level architecture - Capture the main packages, boundaries, and where important responsibilities live.
3. Project-specific conventions - Record patterns that are repeated across the repo and would not be obvious from general language norms.
4. Safety and review constraints - Note security requirements, approval workflows, risky commands, or environment limits.
5. Examples and rationale - When a rule matters, briefly explain why and show a preferred pattern if it helps.

Keep instructions short, self-contained, and durable. Skip formatter-enforced basics, temporary tasks, and generic advice the model already knows.

## Path-Specific Instructions

Use `.instructions.md` files for targeted guidance such as:

- Different frontend vs backend patterns
- Different test conventions by folder
- Framework-specific rules for one package
- Documentation rules for docs-only paths

For automatic application, include an `applyTo` glob pattern. If the rule is shared across agents, prefer `AGENTS.md`; use a nested `AGENTS.md` only when your workflow supports it and you accept VS Code's experimental discovery. If the rule is Copilot-only but path-scoped, use `.instructions.md`.

## Existing instruction files

If the repo already has `.github/copilot-instructions.md`, `.instructions.md`, `AGENTS.md`, or `CLAUDE.md` files, reconcile them before adding new ones:

- Preserve durable shared guidance that is still correct.
- Consolidate shared rules into the most relevant `AGENTS.md`.
- Keep `.github/copilot-instructions.md` focused on Copilot-specific additions.
- Keep only supported top-level `CLAUDE.md` files, and make them a local `@AGENTS.md` include when needed.
- Remove duplication and avoid overlapping files that give conflicting instructions.

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
