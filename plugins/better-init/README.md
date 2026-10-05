# Better Init Plugin

Better Init runs through GitHub Copilot CLI to create or refresh repository
guidance, including skills consumed by GitHub Copilot code review. It keeps
portable repository facts in `AGENTS.md` while moving Copilot-only behavior,
path-specific rules, reusable workflows, review procedures, and specialist
roles to their native locations.

The plugin provides:

- `/better-init` — inspects the repository and writes the smallest useful set
  of instruction, skill, and agent files, including a repository-local
  code-review skill by default.
- `repo-instruction-researcher` — an optional read-only custom agent for
  discovering commands, architecture, and existing guidance in large
  repositories.

Better Init does not replace Copilot CLI's built-in `/init` command. It provides
a more deliberate workflow that can improve existing `/init` output or start
from an uninitialized repository.

## Prerequisites

- GitHub Copilot CLI with plugin, skill, and custom-agent support.

## Installation

```bash
copilot plugin marketplace add scaryrawr/scarypilot
copilot plugin install better-init@scarypilot
```

## Usage

Invoke the skill directly:

```text
/better-init
```

You can also provide a focus:

```text
/better-init prioritize the contributor workflow and fast validation commands
```

```text
Refresh this repository's Copilot instructions and remove duplicated guidance.
```

The skill chooses among these surfaces:

| Surface | Purpose |
| --- | --- |
| `AGENTS.md` | Portable repository structure, commands, conventions, and safety constraints |
| `.github/copilot-instructions.md` | Copilot-specific operating behavior |
| `.github/instructions/*.instructions.md` | Guidance limited to matching paths |
| `.github/skills/*/SKILL.md` | Reusable workflows loaded only when relevant |
| `.github/agents/*.agent.md` | Specialist roles suitable for subagent delegation |

By default, initialization and general guidance refreshes include `AGENTS.md`
and `.github/skills/code-review/SKILL.md`. Other surfaces are created only when
needed. Each file must contain verified guidance that would be misplaced or
distracting elsewhere.

### Copilot code review

Better Init creates or refreshes `.github/skills/code-review/SKILL.md` by default,
even without an explicit review request. The review-focused name and description
help GitHub Copilot code review discover the skill from a pull request's head
branch. An explicitly narrower request, such as "update only `AGENTS.md`," or a
request to skip the review skill takes precedence.

For a simple repository, the skill maps changed paths to entrypoints, tests,
and applicable validation. Where supported by evidence, it adds checks such as
migration artifact synchronization, API compatibility, or use of MCP context
verified in repository Copilot settings. Local or plugin MCP configuration alone
does not establish hosted review access. Better Init preserves useful existing
checks and does not create a generic bug, security, test, or style checklist.

## Resources

- [Adding custom instructions for GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions)
- [Adding agent skills for GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills)
- [Using GitHub Copilot code review](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-code-review?tool=webui#mcp-servers-and-agent-skills)
- [Creating custom agents for GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli)
- [Creating plugins for GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-creating)
