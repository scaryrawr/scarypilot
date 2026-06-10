---
name: digivolution
description: Use this skill near the end of a task to reflect on whether repo instructions or skills should be updated with durable, repo-specific knowledge discovered during the work.
---

# Digivolution Skill

Use this skill for post-task reflection: if the work revealed durable knowledge that would help the next agent, improve the repo's guidance. Keep changes concise, local to the right instruction surface, and high signal.

## When to update guidance

Update instructions or skills only when at least one is true:

- You repeatedly had to rediscover a durable repo-specific fact.
- Existing instructions were misleading, outdated, incomplete, or contradicted the repo.
- You learned validation, setup, workflow, safety, or convention details likely to be useful next time.

## Where to put changes

- Shared durable repo-wide guidance -> nearest relevant `AGENTS.md`, usually the root file.
- Copilot-specific behavior -> `.github/copilot-instructions.md`.
- Path-scoped Copilot guidance -> `.github/instructions/*.instructions.md` with `applyTo` frontmatter.
- Root `CLAUDE.md`, when used, should remain exactly a one-line `@AGENTS.md` shim.
- Misleading or stale in-repo skills -> correct the relevant `.github/skills/**/SKILL.md` or repo plugin `plugins/*/skills/**/SKILL.md`.
- Deeper docs -> link to them when helpful instead of dumping large documentation into immediate context.

## Non-goals and safety

- Do not add generic advice, one-off task details, secrets, private data, or speculative preferences.
- Do not create nested instructions unless the scope differs meaningfully from parent guidance.
- Do not update instructions or skills just to satisfy a hook. If there is no durable improvement, make no change.

## Checklist

1. Review what you learned during the task and identify only durable, repo-specific facts.
2. Check existing guidance before adding new text; prefer correcting or tightening over duplicating.
3. Choose the narrowest appropriate destination from the list above.
4. Write concise, actionable guidance with links to deeper docs when useful.
5. Validate the edited Markdown/frontmatter and ensure no unrelated files were changed.
