# Use pstack for a focused task

Give pstack the problem, the behavior you expect, and the limits. Keep your
follow-ups short while the same task is active. You do not need a chain of skill
names.

## Start with the outcome

Use [`/poteto-mode`](../../skills/poteto-mode/SKILL.md) for a substantial fix or
feature. Name the failure and what would prove it fixed:

```text
/poteto-mode retrying an upload creates a duplicate. repro first, fix the cause, then replay the same flow. keep normal uploads unchanged. no PR or merge.
```

This selects the Bug fix playbook. It requires a real repro and verification on
the same kind of runtime. State "no PR" when that is your boundary, because the
full playbook includes opening one.

For a small edit or lookup, ask directly. `/poteto-mode` invokes other skills
and can add design and review work. It is not the cheapest wrapper for every task.

## Pick a focused skill when you need less

| Situation | Prompt |
|---|---|
| The agent may have misunderstood the goal | [`/in-your-own-words`](../../skills/in-your-own-words/SKILL.md) `what problem are we solving? don't start yet.` |
| You want a stronger prompt before starting | [`/sharpen`](../../skills/sharpen/SKILL.md) `investigate why retries create duplicates. keep the scope to this failure.` |
| You need code understanding, not a change | [`/how`](../../skills/how/SKILL.md) `explain where retry state lives and how it reaches the upload worker. read-only.` |
| You returned to a busy chat | [`/ketchup`](../../skills/ketchup/SKILL.md) `what changed, and what is waiting on me?` |
| The description buries the actual change | [`/unslop`](../../skills/unslop/SKILL.md) `trim this PR description to what matters for the reviewer. don't post it.` |

`/in-your-own-words` and `/sharpen` do not execute the task. Send the rewritten
prompt when you want work to start. `/ketchup` stays read-only and does not
launch the app to gather new screenshots.

## Steer the current task without expanding it

Keep the original finish condition attached to corrections:

```text
I think that path already works. check it before changing it; keep the original repro as the done check.
```

```text
also cover the nested case in the same repro and demo. leave unrelated editor behavior alone.
```

```text
that build result doesn't prove the fix. drive the original flow and show the before-and-after result. no external upload.
```

```text
what actually matters for this PR? drop unrelated findings from the description, not unresolved blockers. don't post yet.
```

Say "new task" when you change subjects. Invoke `/poteto-mode` again for a new
substantial task rather than assuming a permanent mode.

If the same repository mistake keeps returning, use
[`/correct`](../../skills/correct/SKILL.md):

```text
/correct agents keep adding a second test flow. use the existing runner and make the duplicate path fail a check. stay within this mistake class.
```

This changes the repository to prevent a repeated mistake. It is not just a
request to remember another instruction.

## Spend extra agent work on a specific risk

Use [`/architect`](../../skills/architect/SKILL.md) with "with checkpoint" when
competing designs could change ownership or interfaces. It compares designs
and otherwise proceeds to implementation by default.

Use [`/interrogate`](../../skills/interrogate/SKILL.md) for a risky diff that
needs independent challenges. It returns a review verdict, not automatic
fixes. Its default is three reviewers. A small wording change does not need
that panel.

Use a swarm only for independent coverage that needs separate context, not a
single call chain. Writing workers need isolated workspaces. More agents do
not replace a working runtime check.

Task agents, models, image inspection, and scheduling depend on the current
Copilot host. `auto` and `inherit-parent` omit the Task model argument; neither
guarantees a cheaper model. Read-only agent instructions are not a tool sandbox.

When you need a checked behavior diagram, see
[`/statechart`](../../skills/statechart/SKILL.md). Java and TLC are optional
prerequisites for that skill only, not for ordinary pstack work.

For a recommendation without starting a workflow, ask
[`/poteto-help`](../../skills/poteto-help/SKILL.md). The
[full guide](./README.md) covers setup, verification, and longer runs.
