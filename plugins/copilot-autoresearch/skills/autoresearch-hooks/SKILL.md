---
name: autoresearch-hooks
description: Create before/after hooks for an autoresearch session. Use for research fetching, notifications, learnings, tagging, anti-thrash logic, or iteration side effects.
---

# Author autoresearch hooks

Read [references/contract.md](references/contract.md), then create the smallest
hook that satisfies the request. Start from a bundled example when one matches.

Hooks are optional executable scripts:

```text
.auto/hooks/before.sh
.auto/hooks/after.sh
```

1. Read `.auto/prompt.md` and `.auto/measure.sh`.
2. Choose the correct boundary: prospective work belongs in `before.sh`;
   retrospective side effects belong in `after.sh`.
3. Browse `examples/before/` or `examples/after/` relative to this skill.
4. Copy and adapt one example, or write a focused script with the same shape.
5. Mark it executable.
6. Pipe a representative JSON payload into it and verify stdout, stderr, and
   exit status before relying on it.

Rules:

- Parse the single stdin object with `jq`.
- Read fields the loop already records; do not invent hidden environment
  variables or require the agent to populate hook-only fields.
- Use guard clauses and remain silent unless guidance is actionable.
- Keep one concern per script.
- Treat external commands and network calls as explicit user-approved
  dependencies.
- Keep runtime under 30 seconds and stdout under 8 KB.
- Store persistent output under `.auto/` so discard preserves it.
