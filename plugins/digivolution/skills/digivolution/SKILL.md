---
name: digivolution
description: Use this skill for end-of-task digivolution/reflection requests that ask whether durable repo-specific guidance, AGENTS.md/Copilot instructions, or in-repo SKILL.md instructions are stale, missing, or should be updated.
---

# Digivolution Skill

Use this skill for post-task reflection: if the work revealed durable knowledge that would help the next agent, improve the repo's guidance. Keep changes concise, local to the right instruction surface, and high signal.

## When to update guidance

Update instructions or skills only when at least one is true:

- You repeatedly had to rediscover a durable repo-specific fact.
- Existing instructions were misleading, outdated, incomplete, or contradicted the repo.
- You learned validation, setup, workflow, safety, or convention details likely to be useful next time.

## Where to put changes

- Shared durable guidance -> the narrowest relevant `AGENTS.md`. Use the root file for truly repo-wide rules, but prefer a nested `AGENTS.md` when guidance applies only to a subtree and would clutter higher-level instructions.
- Copilot-specific behavior -> `.github/copilot-instructions.md`.
- Path-scoped Copilot guidance -> `.github/instructions/*.instructions.md` with `applyTo` frontmatter.
- Root `CLAUDE.md`, when used, should remain exactly a one-line `@AGENTS.md` shim.
- Misleading or stale in-repo skills -> correct the relevant `.github/skills/**/SKILL.md` or repo plugin `plugins/*/skills/**/SKILL.md`.
- Deeper docs -> link to them when helpful instead of dumping large documentation into immediate context.

## Non-goals and safety

- Do not add generic advice, one-off task details, secrets, private data, or speculative preferences.
- Do not create nested instructions unless the scope differs meaningfully from parent guidance.
- Do not update instructions or skills just to satisfy a hook.
- When an automatic digivolution hook invoked this skill and there is no durable improvement, make no change and produce no user-visible response. Do not say that no update is needed, recap the check, or acknowledge the hook.
- If an eval harness or explicit user instruction asks you to write a final decision artifact when no update is needed, comply with that artifact requirement instead of staying silent, but make clear the no-op response exists only because that artifact was explicitly requested. Normal hook-triggered no-op checks should remain silent.

## Checklist

1. Review what you learned during the task and identify only durable, repo-specific facts.
2. Check existing guidance before adding new text; prefer correcting or tightening over duplicating.
3. Choose the narrowest appropriate destination from the list above.
4. Write concise, actionable guidance with links to deeper docs when useful.
5. Validate the edited Markdown/frontmatter and ensure no unrelated files were changed.
