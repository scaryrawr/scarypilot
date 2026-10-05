# Set up pstack

In this page you install the plugin, pick which models pstack uses, and run your first task. Setup is one command plus a short conversation.

## Install the plugin

Install pstack from the ScaryPilot marketplace:

```sh
copilot plugin marketplace add scaryrawr/scarypilot
copilot plugin install pstack@scarypilot
```

GitHub Copilot confirms the plugin is installed.

## Pick your models

Run:

```text
/setup-pstack
```

[`/setup-pstack`](../../skills/setup-pstack/SKILL.md) detects the models you have access to, shows you each role (code delegates, judgment, the review panels), and asks what you want. Answer the questions. It writes `instructions/pstack-models.instructions.md` in `$COPILOT_HOME`, defaulting to `$HOME/.copilot`, as a user instruction for pstack's Task model roles.

You only override what you care about. A role with no line in the rule keeps the skill's default. To restore a default later, delete that role's line, or just run `/setup-pstack` again.

Set a role to `inherit-parent` or `auto` and pstack omits the Task `model` field, letting the host choose the agent's default. Both values mean the same thing, and neither is a model ID. They do not guarantee the parent chat's model or a lower cost. For a panel role the value is a list, and one subagent runs per entry, so the list length sets the panel size. Setup also configures `swarm workers`, the default model for every `/swarm` worker unless a race names a model for each arm.

## Accept the verification offer, or don't

At the end of setup, `/setup-pstack` looks for a way to prove app behavior in your project, either a `verify-*` skill or an existing harness. If it finds neither, it offers once to generate one with [`/create-verification-skill`](../../skills/create-verification-skill/SKILL.md).

Say yes and it writes `.github/skills/verify-<app>/`, a project-local skill that teaches agents to drive your app the way a user does. It proves the skill works once before handing it over. Say no and setup moves on. You can run `/create-verification-skill` yourself any time. [Verify and ship](./06-verify-and-ship.md#create-a-project-verification-skill) covers it in depth.

If your project has no equivalent harness, this is a useful place to start. An agent that can check its own work can keep going until the check passes. An agent that can't hands every result back to you to check by hand.

After setup, start a new chat. The model rule applies to new sessions.

## Keep the cost in check

pstack spends extra tokens on Task agents and review panels. To spend fewer:

- Rerun `/setup-pstack` and choose lower-cost models from the current host's available model catalog where they meet the task's quality bar.
- Use `auto` or `inherit-parent` to defer model selection to the host, not as a promise of savings.
- Shorten a panel list. Each entry runs one subagent.
- Save `/poteto-mode` for work that needs rigor. A small, obvious edit doesn't need a panel.
- Use `/pstack status`, `/pstack capabilities`, or `/pstack resume` for deterministic, read-only inspection. These native commands do not start model calls or workers; asking an agent to interpret their results still uses the agent.

Setup configures role models only. An expensive dynamic workflow also needs your explicit consent. Installing pstack or asking for help does not authorize a workflow run.

## Run your first task

Pick something real but small, and describe it the way you'd describe it to a colleague:

```text
/poteto-mode add a --json flag to this command. text output stays byte-identical. verify both.
```

Watch the todo list. Its first items are the matched playbook's steps copied in, the Feature playbook for this prompt. If `/poteto-mode` skips a step, the step stays in the list with `skip: <reason>`, so you can see what it chose not to do.

From here you can type normal follow-ups while the conversation holds the task and playbook. Copilot does not promise a sticky Custom Mode for this skill. Start each new task with `/poteto-mode`, and invoke it again if the workflow drifts.

Next: [Route work through `/poteto-mode`](./02-poteto-mode.md).
