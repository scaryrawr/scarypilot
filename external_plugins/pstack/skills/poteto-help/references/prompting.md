# Word the prompt

A prompt states intent and the check for done. The playbook supplies the steps, so a few plain sentences beat a spec. Give the user wording to send; do not execute it during help.

## Put in

- The goal. Say what is wrong or what the user wants.
- The done check. It can pass or fail. "Make it better" and a duration are not checks.
- The proof to show. Ask for real command output, a recording when capture is available and approved, a stored value, or a before-and-after number.
- What the user already knows. A symptom, repro step, log, or link saves a search.
- The real constraints. "repro first", "don't change any code yet", "zero behavior change", and "let me review before proceeding" each change the task.

## Leave out

- The how. Leave the agent room to find a better way.
- A list of skills or steps. A hand-written order can drop or reorder steps the playbook keeps. Name a skill to override a specific choice.
- The user's theory of the cause until the agent restates the problem. A stated guess narrows the search.

## Load the context first

- For a noisy report, ask for a plain-English restatement before edits. A misreading shows up before code exists.
- In a fresh chat, use `/recall` for earlier work when session history is available. Missing sources are limits, not grounds to invent context.
- Before changing unfamiliar code, use `/how` for mechanics and `/why` for reasons.
- Ask `/teach` to make the case for a choice, such as "convince me it fixes the cause and not the symptom".

## Design before the plan

- For a hard design, compare prototypes of several options. Use screenshots, recordings, or timings that the actual host can produce with permission.
- Let prototypes answer empirical questions. Review the resulting diff rather than adversarially polishing an untested abstract plan.
- For a shared package or API, write the README or tutorial first. It becomes the implementation target.
- Ask for a plan after the design settles. Each unit ends in a check, and writing the plan does not authorize execution.

## Follow up short

- "do it", "continue", and "keep going until done" work once the conversation holds the task and permissions.
- Start a new task with `/poteto-mode new task` when the subject changes.
- Invoke `/poteto-mode` again if context drifts. Do not promise persistent Custom Modes.

## Before stepping away

- State that the user is stepping away and which decisions the agent may make. This does not override host safety controls.
- Write done as checks every iteration can run.
- Ask for a fresh writing worktree off a named base, plus separate app ports and outputs when needed.
- Pre-answer allowed actions, such as committing. Do not treat this as consent for unrelated writes or expensive workflows.
- Ask for an auditable decision log.
- For a long program, persist the agreed objective, plan path, PR order, verification rule, merge permissions, and done condition. Recommend hourly audits through approved available session automation or a bounded in-session timer, with the objective re-read at each tick. A timer cannot wake a closed session.
- Give an exit: "if you're truly stuck after a few hours, stop and write up why".
- Check installed host capabilities before recommending a scheduler, event watcher, cloud session, or persistent coordinator. Configure nothing from help.

## Steer in one line

- Restate the goal: "i said the goal is to repro. i did not ask for a fix yet."
- Name the principle: "apply prove it works. show me the real output, not the build log."
- A principle citation should name the decision its rule changed, not just repeat the name.
