---
name: how
description: "Use for \"how does X work\", code walkthroughs before changing something, and placement / ownership / layering questions (\"where should this live\", \"which package owns this\", \"is this the right layer\"). Explains subsystem architecture, runtime flow, onboarding mental models. Use why for motivation."
---

# How

For host-dependent actions and paths, read [runtime actions](../../docs/runtime-actions.md) first.

Explore the codebase to answer "how does X work?" questions. Produce architectural explanations at the level of a senior engineer onboarding onto a subsystem, enough to build a working mental model, not so much that it reads like annotated source code.

## 1. Assess complexity

If the scope is ambiguous, state your interpretation and explore. The user can redirect.

- **Simple** (a single module, a small utility, or one continuous trace): read and explain directly using `references/explainer-prompt.md` without explorer findings. Go to step 4. Do not delegate a small lookup.
- **Complex** (multiple independent research threads needing substantial separate context): go to step 2. File count alone does not justify fan-out.

When in doubt, take the simple path.

## 2. Explore (complex only)

Each spawn below names a role line in the pstack model configuration available to this session and its default. Use that line's value. If the configuration or the line is missing, omit explicit model selection. Omit explicit model selection when the value is `auto` or `inherit-parent`. If the worker-launch action rejects a slug, omit explicit model selection and say so.

Decompose the question into 2 to 4 independent angles. Spawn all explorers in a single message, each with `references/explorer-prompt.md` and its angle filled in:

- Worker role: read-only exploration
- explicit model selection: your configured how-explorer model; omit it when unconfigured or set to `auto`

Then go to step 3.

## 3. Synthesize (complex only)

Once all explorers have returned, spawn one worker to synthesize their findings into one explanation:

- Worker role: implementation or synthesis
- explicit model selection: your configured how-explainer model; omit it when unconfigured or set to `auto`
- Prompt: read-only; do not edit files

Build its prompt from `references/explainer-prompt.md` with every explorer's findings filled in.

## 4. Present

Present the explanation. For a delegated synthesis, light edits for clarity or conversation context are fine; do not substantially rewrite it.

## Output format

The explanation uses the sections defined in `references/explainer-prompt.md`, dropping any that do not apply: Overview, Key Concepts, How It Works, Where Things Live, Gotchas.
