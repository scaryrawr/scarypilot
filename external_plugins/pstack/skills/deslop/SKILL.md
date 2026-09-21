---
name: deslop
description: Remove AI-generated code slop and clean up code style. Applies anti-slop to changed TypeScript and JavaScript as part of the same pass.
---

# Remove AI code slop

Check the diff against main and remove AI-generated slop introduced in the branch.

For changed TypeScript and JavaScript files, run the **anti-slop** skill first.
Carry its type-evidence and boundary findings into this cleanup pass rather
than treating type precision as a separate review.

## Focus Areas

- Extra comments that are unnecessary or inconsistent with local style
- Defensive checks or try/catch blocks that are abnormal for trusted code paths
- Casts to `any` used only to bypass type issues
- Deeply nested code that should be simplified with early returns
- Other patterns inconsistent with the file and surrounding codebase

## Guardrails

- Keep behavior unchanged unless fixing a clear bug.
- Prefer minimal, focused edits over broad rewrites.
- Keep the final summary concise (1-3 sentences).
