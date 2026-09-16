---
name: setup-pstack
description: Configure which models pstack uses per role and at what reasoning effort. Detect available Copilot Task models and write an always-applied user instruction in Copilot home. Use for /setup-pstack, "configure pstack models", "pstack budget", or changing pstack's model choices.
---

# Setup pstack

Write `instructions/pstack-models.instructions.md` in the user's Copilot home directory. Resolve Copilot home from `$COPILOT_HOME` when set, otherwise use `$HOME/.copilot`. The `applyTo: "**"` instruction makes the role mapping available across repositories, matching upstream pstack's always-applied user rule. The file is an override layer, not a requirement. When it is absent, omit the Task `model` and `reasoning_effort` arguments and let Copilot choose the agent's defaults.

## Steps

### 1. Detect available models

Read the current Task tool schema or another first-party Copilot model listing when the host exposes one. Treat it as authoritative for this session. When no first-party listing is available, keep every role at `auto` and do not invent explicit model IDs. `auto` and `inherit-parent` both mean to omit the Task `model` argument.

### 2. Load current state

Read `instructions/pstack-models.instructions.md` from Copilot home when it exists. Treat its `# budget` line and its role values as the current choices. Otherwise start every scalar role at `auto`, each panel at a single `auto` entry, and the budget at `unlimited`.

### 3. Ask for a reasoning budget

Ask one focused `ask_user` question, naming the current budget when the rule records one. Offer these four options with these exact labels:

- `unlimited — no reasoning_effort override`
- `large — xhigh reasoning_effort`
- `medium — high reasoning_effort`
- `small — medium reasoning_effort`

`unlimited` omits the Task `reasoning_effort` argument for every role, so each subagent keeps its own default. `large`, `medium`, and `small` set `reasoning_effort` to `xhigh`, `high`, or `medium` for every role that names an explicit model, panel entries included. A role left at `auto` or `inherit-parent` never gets a `reasoning_effort` override, because it already inherits the parent's full configuration.

### 4. Map and confirm

Show every role with its current value. Mark unavailable IDs. Ask one focused `ask_user` question at a time when a choice is needed. Offer only detected model IDs plus `auto`.

Panel values are comma-separated lists. One subagent runs per entry, so the list length sets panel size. Recommend models from different families for judgment panels only when those models are available.

### 5. Validate

Every non-alias model ID must appear in the detected set. Stop before writing if any value is invalid.

### 6. Write the configuration

Create the Copilot home `instructions` directory when needed, then overwrite `pstack-models.instructions.md` so reruns are idempotent:

```markdown
---
applyTo: "**"
---

# pstack model configuration

Use `auto` or `inherit-parent` to omit the Task `model` argument.
budget: unlimited

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

Replace aliases with validated IDs only when the user chooses explicit models. Replace the `budget:` value with `large`, `medium`, or `small` when the user chose one of those, and record the `reasoning_effort` each role that carries an explicit model ID should pass to its Task calls.

### 7. Confirm

Tell the user which user-level configuration was written, which roles use explicit models, and the chosen budget. Explain that Copilot loads the change in new or resumed sessions.

### 8. Offer a verification skill

Check whether the project already has a `verify-*` skill or an equivalent runtime harness. If not, offer `/create-verification-skill` once. Do not push after a no.
