# Digivolution Plugin

Digivolution helps agents leave repositories in a state that's easier for the next agent to work in. It combines a post-task reflection skill with an adaptive extension that invokes the reflection only when a turn contains strong evidence of a durable repository learning opportunity.

Use it to keep these surfaces accurate and high signal:

- `AGENTS.md`
- `CLAUDE.md` shims
- `.github/copilot-instructions.md`
- `.github/instructions/*.instructions.md`
- In-repo skills such as `.github/skills/**/SKILL.md` or `plugins/*/skills/**/SKILL.md`

The extension observes the active turn in memory and may request one extra reflection turn when:

- The user directly corrects a repository-specific command, instruction, setup step, convention, or workflow.
- A repo-local operation fails repeatedly and a materially changed operation succeeds.
- A command usage error is recovered by a materially changed command against the same repo-local target.

It does not trigger for ordinary test failures, long turns, repeated edits, generic frustration, network failures, or successful validation alone. It does not read session transcripts or persist prompts, tool arguments, results, or errors.

## Prerequisites

- GitHub Copilot CLI with plugin, skill, and native extension support.
- Node.js 22.18 or newer.

## Installation

```bash
copilot plugin marketplace add scaryrawr/scarypilot
copilot plugin install digivolution@scarypilot
```

## Usage

Digivolution is most useful near the end of a task, after the agent has learned something durable about a repository.

Example prompts:

- "Use digivolution before finishing this task."
- "Digivolve before you finish."
- "If you discovered any durable repo guidance, update the right instruction file."
- "Check whether any in-repo skill you used is stale or misleading, and correct it if needed."
- "Before you finish, decide whether AGENTS.md or Copilot instructions need a concise update."

The skill should:

1. Prefer correcting existing guidance over duplicating text.
2. Use the narrowest appropriate destination for any change.
3. Make no edit when there is no durable improvement and avoid a no-op status that interrupts task completion.

## Adaptive trigger behavior

The extension registers typed session hooks through `@github/copilot-sdk`:

1. `onUserPromptSubmitted` starts a fresh in-memory turn and detects only explicit, repository-specific corrections.
2. `onPostToolUseFailure` records minimized operation fingerprints and failure categories.
3. `onPostToolUse` correlates a changed successful operation with prior repo-local failures.
4. `onAgentStop` requests one digivolution continuation when the current turn has qualifying evidence.

Every handler requires the event's session ID to match the extension's joined primary session ID. Subagent events are ignored, and `onAgentStop` is additionally documented by the SDK as a top-level-agent event.

The continuation is loop-safe: the extension claims the reflection before blocking, ignores its own continuation prompt, and allows any stop where `stopHookActive` is set. If hook processing is uncertain or fails, the turn ends normally.

## Resources

- [Creating a plugin for GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-creating)
- [Adding custom instructions for GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions)
- [Agent Skills specification](https://agentskills.io/specification)
