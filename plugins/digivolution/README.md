# Digivolution Plugin

Digivolution helps agents leave repositories in a state that's easier for the next agent to work in. It adds a post-task reflection workflow that encourages an agent to update durable repo guidance when the task revealed stale, missing, or misleading instructions.

Use it to keep these surfaces accurate and high signal:

- `AGENTS.md`
- `CLAUDE.md` shims
- `.github/copilot-instructions.md`
- `.github/instructions/*.instructions.md`
- In-repo skills such as `.github/skills/**/SKILL.md` or `plugins/*/skills/**/SKILL.md`

The plugin is advisory: it does not directly auto-edit files. It reminds the active agent to decide whether an update is useful, and the agent can silently do nothing when no change is needed.

## Prerequisites

- GitHub Copilot CLI with plugin and hook support.
- Node.js. The hooks invoke a small Node.js script for JSON parsing and state-file handling.

## Installation

```bash
copilot plugin marketplace add scaryrawr/scarypilot
copilot plugin install digivolution@scarypilot
```

## Usage

Digivolution is most useful near the end of a task, after the agent has learned something durable about a repository.

Example prompts:

- "Use digivolution before finishing this task."
- "If you discovered any durable repo guidance, update the right instruction file."
- "Check whether any in-repo skill you used is stale or misleading, and correct it if needed."
- "Before you finish, decide whether AGENTS.md or Copilot instructions need a concise update."

## Hook behavior and loop safety

Digivolution arms one optional reflection nudge per user prompt, then steps out of the way:

1. When you submit a prompt, the `userPromptSubmitted` hook sets a per-session "reflection
   pending" flag (a marker file keyed by session and repository).
2. When the agent finishes a turn, the `agentStop` hook checks the flag. If it is set, the
   hook clears it and blocks once, asking the agent to consider whether durable repo
   instructions or in-repo skills should be updated.
3. If the forced continuation is surfaced through `userPromptSubmitted`, the `mark` hook
   recognizes its own digivolution prompt and does not re-arm the flag. The next `agentStop`
   finds nothing pending and lets the turn finish — at most one forced continuation per
   prompt, so there is no infinite stop-hook loop.
4. Your next prompt arms the flag again, so digivolution can prompt again later in the same
   multi-turn session instead of firing only once.

The nudge is intentionally low pressure. The agent should:

1. Prefer correcting existing guidance over duplicating text.
2. Use the narrowest appropriate destination for any change.
3. Make no edit when there is no durable improvement — it should silently skip the nudge without
   re-reading files, acknowledging it, or saying that no update is needed.

The hook never edits files or overrides the agent's judgement; it only emits an advisory
reason. If Node.js is unavailable or the hook errors, it fails open and the turn finishes
normally.

## Resources

- [Creating a plugin for GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-creating)
- [GitHub Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference)
- [Adding custom instructions for GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions)
- [Agent Skills specification](https://agentskills.io/specification)
