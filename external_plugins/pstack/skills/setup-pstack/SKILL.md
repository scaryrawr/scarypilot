---
name: setup-pstack
description: Configure pstack's worker models using the current host's supported model catalog and native instruction format. Use for /setup-pstack, "configure pstack models", or changing pstack's model choices.
---

# Setup pstack

Configure worker roles, not tool argument names. Read the shared
[runtime actions](../../docs/runtime-actions.md) before choosing capabilities.
The role mapping is optional. When it is absent, omit explicit model selection
and let the host choose its default.

## Native configuration locations

- **Copilot.** Write `instructions/pstack-models.instructions.md` under
  `$COPILOT_HOME`, or `$HOME/.copilot` when unset. Add the frontmatter
  `applyTo: "**"`. Copilot loads this user instruction in new or resumed sessions.
- **Codex.** Do not write Copilot's instruction file or claim it auto-loads.
  With the user's approval, add or replace a clearly delimited pstack model
  configuration section in the instruction file the current Codex host
  documents and loads, commonly `$CODEX_HOME/AGENTS.md` or `~/.codex/AGENTS.md`.
  Inspect existing content and preserve unrelated instructions. Do not copy
  Copilot's `applyTo` frontmatter into it. If discovery is uncertain, return the
  mapping for explicit inclusion in the current session instead of inventing a
  configuration path or a persistence guarantee.

Neither file registers agents or creates model-selection support. If the host
cannot select a model for an individual worker, keep the roles at `auto` and say
that explicit per-worker model selection is unavailable.

## Steps

### 1. Detect available models

Inspect the worker-launch schema or a first-party model listing exposed by the current host. Treat it as authoritative for this session. Without such evidence, keep every role at `auto` and do not invent model IDs. `auto` and `inherit-parent` both mean omit explicit model selection.

### 2. Load current state

Read the current host's configuration described above, or the mapping explicitly supplied to this session. Otherwise start every scalar role at `auto` and each panel at a single `auto` entry. A line whose role is not in step 5, such as `how critics`, is from a retired role. Drop it.

### 3. Map and confirm

Show every role with its current value. Mark unavailable IDs. Also list each line step 2 dropped. Use the supported user-question action for one focused choice at a time. Offer only detected model IDs plus `auto`.

Panel values are comma-separated lists. One subagent runs per entry, so the list length sets panel size. Recommend models from different families for judgment panels only when those models are available.

The `arena cross-judge pool` is an ordered list of candidates for one judge, not a panel. Arena tries only concrete authorized IDs from a known family other than the parent's. Aliases never judge. If the parent family is unknown or no eligible candidate runs, Arena skips the judge and reports the missing independent judgment.

### 4. Validate

Every non-alias model ID must appear in the detected set. Stop before writing if any value is invalid.

### 5. Write the configuration

Write the mapping using the current host's native location above. Create its
directory only with the required permission. Replace the existing pstack mapping
on reruns, not unrelated instructions. For Copilot, prepend the frontmatter
described above. The shared mapping body is:

```markdown
# pstack model configuration

Use `auto` or `inherit-parent` to omit explicit model selection.

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

Tell the user which configuration was written or supplied and which roles use explicit models. State the host's confirmed loading behavior. Do not promise that merely writing a file makes this session reload it.

### 7. Offer a verification skill

Check whether the project already has a skill or equivalent runtime harness that launches or connects to the real app, drives user-facing behavior, and checks the result. Read the candidate's launch/drive instructions or harness commands; a `verify-*` name alone is not evidence. A formal-only skill that runs a model checker, proof, or code-level verifier does not satisfy this runtime check. If no runtime capability exists, offer `/create-verification-skill` once. Do not push after a no.

### 8. Offer a formal verification skill

Check whether the project already has a formal verification skill: a project skill that runs a model checker, a proof, or another verifier against named code. This is separate from the runtime harness in step 7. If none exists, offer once to generate one with [`/create-formal-verification-skill`](../create-formal-verification-skill/SKILL.md), explaining that it checks one key property in every case within a stated scope, not only the cases tests reach. On yes, invoke that installed skill. On no, move on without pushing. Do not install a verifier or start verification merely because setup ran.
