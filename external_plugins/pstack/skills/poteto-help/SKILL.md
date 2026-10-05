---
name: poteto-help
description: "Answer explicitly typed /poteto-help requests or help questions about pstack setup, usage, skills, playbooks, and principles. Recommend a prompt without executing it. Not for generic coding, debugging, design, review, or implementation work."
---

# Poteto help

Answer the user's pstack question, give them a prompt they can send, and link the source. Do not start the suggested work. Help is not consent to spend tokens on a panel or workflow.

If `/poteto-help` carries an implementation request, explain which prompt would start it, then stop. Do not delegate, install or configure anything, mutate files or external systems, schedule work, or invoke an execution workflow. Read relevant skill files as documentation with available read/search tools, not by running their steps. Respect the host's built-in skill and Task tooling; do not substitute another client's tool names or assume unavailable capabilities.

This map routes to files that own the details. Read the relevant file before recommending or quoting it, and prefer its actual instructions over this summary. For user-facing source links, use `https://github.com/scaryrawr/scarypilot/blob/main/external_plugins/pstack/` followed by the path relative to the plugin root. Link the adapted file you read, not upstream client-specific docs. If its public availability is unconfirmed, say so rather than inventing a link.

## Find out what they need

Infer the need from the message and conversation. A named situation goes straight to its section. If unclear and the host supports questions, ask one focused choice:

- Get set up
- Start a task with `/poteto-mode`
- Pick a skill for a situation
- Fix a run that went wrong
- Make pstack my own

In a non-interactive host, state the likely interpretation and answer it without starting work.

Inspect state only when it changes the answer:

- Resolve Copilot home from `$COPILOT_HOME`, defaulting to `$HOME/.copilot`. If `instructions/pstack-models.instructions.md` or a role line is absent, omit the Task `model` argument and let the host select its default. A missing file does not prove setup never ran.
- If the project has neither a `verify-*` skill nor an equivalent harness, suggest `/create-verification-skill` for questions about proving app behavior.
- Use the current host's advertised tools as authoritative. `/pstack capabilities` or `pstack_capabilities`, when installed, reports available, unavailable, or unknown capabilities. Unknown is not permission to assume support.

## Get set up

Give the Copilot installation commands as instructions, not actions to execute during help:

```sh
copilot plugin marketplace add scaryrawr/scarypilot
copilot plugin install pstack@scarypilot
```

Then recommend [`/setup-pstack`](../setup-pstack/SKILL.md) to configure available Task model roles, followed by a small `/poteto-mode` task with a pass/fail check. Setup writes `instructions/pstack-models.instructions.md` in Copilot home, normally `~/.copilot`, for new or resumed sessions. It configures role models only.

Copilot supports natural-language skill triggers as well as typed skill names. Setup is not the only naturally invokable skill, and installation is not authorization to execute every workflow. The [README](../../README.md) and [guide page 1](../../docs/guide/01-setup.md) own installation and capability details.

For inventory or version questions, read the current README and [`plugin.json`](../../plugin.json) instead of treating this routing table as the complete inventory.

For cost questions, explain that Task agents and panels add model work. Choose lower-cost available models only where they meet the quality bar, reduce panel entries, and reserve heavy playbooks for work that needs them. `auto` and `inherit-parent` both omit `model`; the host selects its default. Neither guarantees the parent model, fewer tokens, or a cheaper run.

The native `/pstack status`, `/pstack capabilities`, and `/pstack resume` commands are deterministic, read-only inspection with no model calls or workers. Resume inspects existing state and handoffs, not the next task. An agent conversation interpreting their output still uses its model.

## Start a task with `/poteto-mode`

`/poteto-mode` matches a playbook, copies its steps into the todo list, and invokes the needed skills. Skipped steps remain as `skip: <reason>`. Recommend a goal and a check for done, not a hand-written skill sequence. Read [`references/prompting.md`](references/prompting.md) when wording a prompt. [Guide page 2](../../docs/guide/02-poteto-mode.md) has examples.

Follow-ups can be short while the conversation holds the task and playbook. Do not promise a sticky Custom Mode or a keyboard shortcut. Start each new task with `/poteto-mode`; say "new task" when changing subjects, and invoke the skill again if the workflow drifts.

The playbooks use the `poteto-agent` custom agent only when the current Task tool advertises it. Select the exact advertised `agent_type`, which may be plugin-qualified. Otherwise follow the skill's documented built-in Task fallback. Do not invent a model ID, agent name, background mode, or cloud parameter the host schema does not support.

## Pick a skill

Default to `/poteto-mode` for non-trivial work that needs its discipline. Name a focused skill when the user wants a narrower outcome or more scrutiny. Read it before recommending it, and give one example prompt.

| The user wants to | Skill |
|---|---|
| Do non-trivial work with rigor | [`/poteto-mode`](../poteto-mode/SKILL.md) |
| Know how code works or where code should live | [`/how`](../how/SKILL.md) |
| Know why code is shaped this way or where a choice came from | [`/why`](../why/SKILL.md) |
| Understand a change or subsystem plainly | [`/teach`](../teach/SKILL.md) |
| Catch up on recent work from available history | [`/recall`](../recall/SKILL.md) |
| Prove what a small diff could break elsewhere | [`/blast-radius`](../blast-radius/SKILL.md) |
| Settle types and module boundaries before implementation | [`/architect`](../architect/SKILL.md) |
| Compare attempts at one brief and graft the best parts | [`/arena`](../arena/SKILL.md) |
| Cover independent slices or declared race arms | [`/swarm`](../swarm/SKILL.md) |
| Have several models challenge a diff | [`/interrogate`](../interrogate/SKILL.md) |
| Fix a bug test-first when a cheap local test exists | [`/tdd`](../tdd/SKILL.md) |
| Apply TypeScript rules | [`/typescript-best-practices`](../typescript-best-practices/SKILL.md) |
| Remove AI-generated code slop | [`/deslop`](../deslop/SKILL.md) |
| Strip comments with a reviewer that didn't write them | [`/no-comments`](../no-comments/SKILL.md) |
| Clean AI tells from prose | [`/unslop`](../unslop/SKILL.md) |
| Write docs, RFCs, READMEs, or PR prose to a standard | [`/technical-writing`](../technical-writing/SKILL.md) |
| Hear the last reply in plain words | [`/bro`](../bro/SKILL.md) |
| Give agents a repeatable way to drive the app | [`/create-verification-skill`](../create-verification-skill/SKILL.md) |
| Audit a verification skill and feature map | [`/maintain-verification-skill`](../maintain-verification-skill/SKILL.md) |
| Vet a measured performance number | [`/benchmark-checklist`](../benchmark-checklist/SKILL.md) |
| Validate a pstack snapshot, receipt, handoff, or plan contract | [`/pstack-schema-validate`](../pstack-schema-validate/SKILL.md) |
| Run a large change or work to review after stepping away | [`/figure-it-out`](../figure-it-out/SKILL.md) |
| Keep and audit a decision trail | [`/show-me-your-work`](../show-me-your-work/SKILL.md) |
| Configure models per Task role | [`/setup-pstack`](../setup-pstack/SKILL.md) |
| Capture personal working habits in a mode skill | [`/automate-me`](../automate-me/SKILL.md) |
| Turn session lessons into approved skill edits | [`/reflect`](../reflect/SKILL.md) |
| Prevent repeated repository mistakes | [`/correct`](../correct/SKILL.md) |
| Find their way around pstack | `/poteto-help` |

For a missing table entry, read the installed skill's frontmatter and route by its description. Do not recommend a skill that is not installed. `principle-*` skills are covered below.

Close calls:

- `/how` explains mechanics, `/why` explains reasons, and `/teach` combines and explains the evidence.
- `/arena` repeats one brief and grafts the best parts. `/swarm` partitions coverage or races declared arms and aggregates one report.
- `/architect` normally implements after design. Add "with checkpoint" to review the design before implementation.
- `/interrogate` challenges a diff. `/blast-radius` proves a safety assumption outside it.
- `/recall` rebuilds topic context. Session pickup resumes one specific branch or session.
- `/figure-it-out` designs one rigorous run. Orchestrate is a multi-day program; Autonomous run drives one task to a finish condition.

Both `/deslop` and `/pstack-schema-validate` are bundled in this Copilot pstack adaptation. For validation, `pstack_validate_artifact` checks one selected workspace artifact's contract without running commands or reading evidence paths. Valid structure is not proof of behavior, freshness, or permission to act. The validation skill documents its CLI fallback.

The opt-in `pstack-swarm` native workflow is read-only coverage, requires dynamic workflow tools in the current host and explicit user consent, and can pin declared file bytes through `inputFiles`. It rejects drift at workflow boundaries, including resume, but does not freeze the whole repository or prove worker evidence. Races and writing work use Task agents, with separate worktrees for writing. Do not invoke a workflow from help.

## Playbooks and principles

Playbooks are step lists inside `/poteto-mode`, not slash-command skills:

- "babysit this pr" or "check on pr 123" selects Babysit. Status-only requests do not start its fix loop. It stops at merge-ready; merging needs an explicit request and Shipping.
- "land the stack" selects Shipping.
- "take over this branch" selects Session pickup.
- "pause safely" selects Pause safely.
- "full autopilot on this queue" selects Autopilot-full. "stack them, don't ship" selects Autopilot-stack.
- "run the eval playbook" selects Eval.

Read the Playbooks section of [`poteto-mode`](../poteto-mode/SKILL.md) for the full map. [Guide page 6](../../docs/guide/06-verify-and-ship.md) covers PR work. There is no standalone pstack `/orchestrate` skill; another installed plugin may provide one.

For PR-tool questions, read [Opening a PR](../poteto-mode/playbooks/opening-a-pr.md). Prefer a matching built-in creation or update tool only within its actual repository, branch, base, and PR scope. Do not claim it supports retargeting or readiness changes unless its schema does. Unsupported operations use the available forge workflow under the tool's scope and failure instructions. Open ready unless the user or repository requires a draft, and never change an intentional draft without approval.

pstack has no separate planning skill. Asking `/poteto-mode` for a multi-phase plan selects the [Multi-phase plan playbook](../poteto-mode/playbooks/multi-phase-plan.md), which writes the plan and does not implement it. Prototypes or `/architect` settle empirical design questions first. Host plan modes and approval surfaces are separate capabilities, not plugin promises.

Long program plans retain a persisted decision-trail objective and specify hourly audits. Audits use available approved session automation or a bounded timer while the session is active; neither guarantees a closed session can wake. The shared validator accepts both new hourly and legacy 30-minute audit plans. Explain those limits without configuring a timer, automation, or execution run from help.

Principles are one-rule skills. `/poteto-mode` reads and cites those it applies. Users can steer with a name, such as "apply prove it works. show me the real output", or explicitly invoke `/principle-<name>`. [Guide page 8](../../docs/guide/08-principles.md) lists them.

## Fix a run that went wrong

| Symptom | Advice |
|---|---|
| The style stopped applying | Invoke `/poteto-mode` again with the goal and constraints. Don't promise sticky mode support. |
| A question became the last task's next step | Say "new task" and "don't change any code yet". |
| A model choice had no effect | Check the Copilot home instruction and current Task model catalog. Start a new or resumed session that loads it. |
| Runs cost more than expected | Reduce panels and review role models. Aliases alone don't guarantee savings. |
| A skill didn't load | Invoke it explicitly, and check its installed frontmatter. Copilot also supports natural-language triggers; loading is not guaranteed by a path alone. |
| Parallel agents overwrote each other | Give writing workers separate worktrees, ports, and outputs. Use cloud sessions only if this host exposes them. |
| An overnight run moved but finished nothing | Give it a pass/fail predicate, working verification, and an authorized wake mechanism if the host has one. |
| The reply claims success from a green build | Ask for the real command, flow, stored value, or profile. |
| A resumed report may be stale | Inspect `/pstack resume`, then verify the inherited evidence at the actual revision before acting. |

[`references/prompting.md`](references/prompting.md) has one-line steers. [Guide page 10](../../docs/guide/10-recipes-and-pitfalls.md) has pitfalls and recipes.

## Make pstack my own

- `/automate-me` drafts a personal mode skill from accessible history.
- `/reflect` proposes skill changes from one session for user approval.
- `/correct` changes the repository to prevent repeated mistake classes.
- `/poteto-mode write a skill for <workflow>` selects the authoring playbook; Eval tests the change blind.
- Fix a misbehaving skill in its own PR, not hidden inside feature work.

[Guide page 9](../../docs/guide/09-make-it-yours.md) covers these.

## Reply

Lead with the answer. Give at most one example prompt in a code block, adapted from [`references/recipes.md`](references/recipes.md), then a public link to the adapted source you read. Installation may need its two command lines in one block. Keep it short unless the user asks for the whole map. State unavailable or unconfirmed capabilities plainly, and stop without executing the suggestion.
