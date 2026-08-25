### Authoring or modifying a skill

**You own the skill's voice.** Agent-facing prose has a higher bar than human prose; unhelpful sentences become instructions.

1. Follow the Agent Skills structure: a folder containing `SKILL.md`, with optional `references/`, `scripts/`, `assets/`, and `evals/`.
2. Keep frontmatter to a lowercase kebab-case `name` matching the folder and a specific `description`. Quote YAML-sensitive descriptions.
3. Validate the skill: frontmatter is valid, referenced files exist, and cross-skill links resolve. Run focused task or trigger evals when behavior is objective; skip them for subjective prose.
4. Run **Opening a PR**.

When in doubt, delete; prose earns its keep by changing a decision. Tell it to do the thing and skip the reason. Explain only when the rule is confusing without one. Match tone to scope. Point at structural sources (types, READMEs, config); hardcoded details go stale (the **encode-lessons-in-structure** principle skill). Delegate to other skills by path; don't restate. A workflow you keep hitting but isn't captured → propose a new skill.

**Reply:** summary of the skill, key design decisions, validation notes.
