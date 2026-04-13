# Copilot Instructions

Start with the nearest `AGENTS.md`. The root `AGENTS.md` is the shared source of truth for repo-wide guidance. Use nested `AGENTS.md` files only when a subtree needs different durable rules and your workflow supports them; in VS Code, nested discovery is experimental and requires `chat.useNestedAgentsMdFiles`.

This file is only for Copilot-specific layering:

- Use `.github/instructions/*.instructions.md` for Copilot-only rules that should apply by path or file type.
- If you create new repo guidance, keep shared rules in `AGENTS.md` and keep any supported top-level `CLAUDE.md` file as a one-line `@AGENTS.md` shim.
- When adding Copilot-specific automation, use:
  - `.github/agents/*.agent.md` for specialist agents
  - `.github/skills/` for repeatable multi-step workflows
  - `.github/hooks/*.json` for fast guardrails around risky or expensive actions
- Do not duplicate the contents of `AGENTS.md` here. Link or defer to shared guidance instead.
