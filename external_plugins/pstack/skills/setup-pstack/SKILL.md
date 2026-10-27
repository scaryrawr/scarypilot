---
name: setup-pstack
description: Configure which models pstack uses per role. Detect available Copilot Task models and write an always-applied user instruction in Copilot home. Use for /setup-pstack, "configure pstack models", or changing pstack's model choices.
---

# Setup pstack

Write `instructions/pstack-models.instructions.md` in the user's Copilot home directory. Resolve Copilot home from `$COPILOT_HOME` when set, otherwise use `$HOME/.copilot`. The `applyTo: "**"` instruction makes the role mapping available across repositories, matching upstream pstack's always-applied user rule. The file is an override layer, not a requirement. When it is absent, omit the Task `model` argument and let Copilot choose the agent's default.

## Steps

### 1. Detect available models

Read the current Task tool schema or another first-party Copilot model listing when the host exposes one. Treat it as authoritative for this session. When no first-party listing is available, keep every role at `auto` and do not invent explicit model IDs. `auto` and `inherit-parent` both mean to omit the Task `model` argument.

### 2. Load current state

Read `instructions/pstack-models.instructions.md` from Copilot home when it exists. Otherwise start every scalar role at `auto` and each panel at a single `auto` entry. A line whose role is not in step 5, such as `how critics`, is from a retired role. Drop it.

### 3. Map and confirm

Show every role with its current value. Mark unavailable IDs. Also list each line step 2 dropped. Ask one focused `ask_user` question at a time when a choice is needed. Offer only detected model IDs plus `auto`.

Panel values are comma-separated lists. One subagent runs per entry, so the list length sets panel size. Recommend models from different families for judgment panels only when those models are available.

### 4. Validate

Every non-alias model ID must appear in the detected set. Stop before writing if any value is invalid.

### 5. Write the configuration

Create the Copilot home `instructions` directory when needed, then overwrite `pstack-models.instructions.md` so reruns are idempotent:

```markdown
---
applyTo: "**"
---

# pstack model configuration

Use `auto` or `inherit-parent` to omit the Task `model` argument.

feature, refactoring: auto
bug-fix: auto
perf-issue: auto
hillclimb: auto
judgment and prose: auto
hardest tasks: auto
how explorer: auto
how explainer: auto
why investigators: auto
why synthesizer: auto
reflect tooling: auto
reflect judgment, divergent, synthesizer: auto
arena runners: auto
arena cross-judge pool: auto
swarm workers: auto
architect runners: auto
interrogate reviewers: auto
```

Replace aliases with validated IDs only when the user chooses explicit models.

### 6. Confirm

Tell the user which user-level configuration was written and which roles use explicit models. Explain that Copilot loads the change in new or resumed sessions.

### 7. Offer a verification skill

Check whether the project already has a skill or equivalent runtime harness that launches or connects to the real app, drives user-facing behavior, and checks the result. Read the candidate's launch/drive instructions or harness commands; a `verify-*` name alone is not evidence. A formal-only skill that runs a model checker, proof, or code-level verifier does not satisfy this runtime check. If no runtime capability exists, offer `/create-verification-skill` once. Do not push after a no.

### 8. Offer a formal verification skill

Check whether the project already has a formal verification skill: a project skill that runs a model checker, a proof, or another verifier against named code. This is separate from the runtime harness in step 7. If none exists, offer once to generate one with [`/create-formal-verification-skill`](../create-formal-verification-skill/SKILL.md), explaining that it checks one key property in every case within a stated scope, not only the cases tests reach. On yes, invoke that installed skill. On no, move on without pushing. Do not install a verifier or start verification merely because setup ran.
