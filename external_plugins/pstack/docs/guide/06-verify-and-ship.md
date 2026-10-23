# Verify the result and open a PR

"It compiles" is not evidence of changed behavior. The [Prove It Works principle](../../skills/principle-prove-it-works/SKILL.md) tells the agent to check the actual acceptance condition and supply proportionate evidence without waiting to be asked. Its description targets ordinary implementation and fix requests; discovery still depends on the host and model, not an always-on enforcement mechanism. Work already routed through pstack's Feature, Bug fix and Refactoring playbooks shares the same completion gate without making all of poteto-mode implicit. This page covers finish conditions, measurements, verification skills, and shipping.

Acceptance criteria help target the check, but requesting evidence is not your responsibility. The agent should reuse existing checks, choose the smallest adequate direct observation, and name anything it could not verify.

## State the finish condition up front

Put what done means in the first prompt, in whatever words fit:

```text
Add JSON output to this command. Text output stays byte-identical, the JSON parses, both run against the sample project.
```

Now the agent has three checks it can run. The reply should briefly connect the outcome to the actual check and observed result, with a useful command, output or real artifact pointer. Missing runtime, consent or dependencies means partial or blocked verification with the specific missing check, not a claim that it works. No verbose report, full suite or new receipt is required for every edit.

Match the check to the change:

- A CLI change runs the real command.
- A UI interaction fix walks the original scenario and fresh fixed flow on the relevant running build. Prefer a short genuine replay when useful and explicitly authorized. Static layout changes can use screenshots. Pixel-exact claims use the [Visual parity playbook](../../skills/poteto-mode/playbooks/visual-parity.md).
- A parser or migration replays a saved input.
- A perf change compares before and after profiles.
- A storage change independently reads back the written value through the intended persistence boundary, such as a fresh process, not a setter echo.

Evidence must match the current relevant code/build, scenario and input. A recent filename or an existing path is not enough. A browser harness is not native-app coverage, and an animation or mockup is never runtime proof. A caller-visible library test can suffice; a typo fix or read-only explanation needs no app launch.

For authorized recordings, reuse installed screen-record/media workflows and their raw-evidence and editing standards. Preserve originals and meaningful waits, inspect the actual clip, and confirm it survives cleanup. Include a supported local clip attachment or real local pointer without auto-uploading. Before/after comparisons are optional when they clarify; never revert user work to manufacture a baseline. This preference grants no recording, audio, privacy, installation or upload permission. If a real baseline or runtime is unavailable, say so.

For a small diff you don't fully trust, [`/blast-radius`](../../skills/blast-radius/SKILL.md) finds what it could break elsewhere. It finds the one fact that makes the change safe and proves that fact by running code, not by arguing for it.

## Vet a measured number with `/benchmark-checklist`

A before-and-after number is easy to get wrong by accident. A warm cache, a debug build on one side, or work that never ran inside the timed region can each produce a convincing speedup. Before you report or act on a number, type:

```text
/benchmark-checklist vet the export speedup before it goes in the pr
```

[`/benchmark-checklist`](../../skills/benchmark-checklist/SKILL.md) asks seven questions and wants evidence from a run for each:

1. What limits the number, and why isn't it double?
2. Did every side run tuned the way production runs?
3. Does the result break a physical limit, like disk bandwidth or core count?
4. Did anything error or return wrong output?
5. Does it reproduce over alternating runs, with a median and a range?
6. Does it matter end to end, on the path a user waits on?
7. Did the work actually happen inside the timed region?

The verdict comes back as faster, slower, no measurable difference, or inconclusive, with the run count, range, and limiter. It says inconclusive when it can't name the limiter or a side ran untuned. `/poteto-mode` runs the checklist inside the Perf issue and Hillclimb playbooks, so use it directly for numbers measured outside them or when someone else's number looks too good. It's the working form of the [Explain the Number principle](../../skills/principle-explain-the-number/SKILL.md).

## Create a project verification skill

The UI bullet above hides a real requirement. The agent needs a scripted way to drive your app. If your project has one, great. If not, run:

```text
/create-verification-skill
```

[`/create-verification-skill`](../../skills/create-verification-skill/SKILL.md) interviews the repository, not you. It works out what a user touches, how the app launches locally, what can drive it (an existing harness first, otherwise browser and CDP, a PTY, or plain HTTP), what evidence proves behavior, and whether two instances can run side by side. It asks you only what the code can't answer.

It writes `.github/skills/verify-<app>/`, agent-facing instructions with exact Launch, Doctor, Drive, Evidence, and Cleanup sections, a Helpers section for any script it ships, plus a feature map under `features/` that indexes what the app does and what result proves each feature works. The skill ships a [worked feature-map example](../../skills/create-verification-skill/references/feature-map-example/) with a README index and one file per feature using the four required H2s. Before handing it over, the generator proves the skill once end to end: launch, doctor check, drive one feature, capture evidence, clean up, then confirm the evidence survived cleanup. If that proof fails, don't use the output.

From then on, "verify it in the app" is repeatable in this repo with the required host tools and permissions. Name the skill when you want proof in a specific form:

```text
/poteto-mode build the bulk-archive action. use /verify-<app> to verify your changes and capture screenshots as proof.
```

```text
/poteto-mode repro this with /verify-<app>. if it repros on main, fix it and show me before-and-after evidence.
```

Once the verify skill works, a [`/swarm`](../../skills/swarm/SKILL.md) can split a full pass by feature-map entry and aggregate the results.

Verification workers need the actual driving tools, isolated app instances, and evidence acceptance, not just a `PASS`. Use Task agents for lanes that drive or write to the app. They can gather a larger perf sample with a declared measurement method or exercise regression scenarios before shipping. Avoid competing loads that distort the measurements. A read-only source review cannot replace those lanes.

Treat the verification skill as infrastructure. Commit it when you're ready to share it, so the team drives the app the same way. Then [build the lever](../../skills/principle-build-the-lever/SKILL.md). When agents keep writing throwaway scripts to click through the app, ask for a small control CLI that the skill calls instead. Every run becomes repeatable. A useful control CLI has:

- A few composable commands, each doing real work, rather than many thin ones.
- A `--dry-run` option on destructive actions.
- Subcommands that reveal features gradually.
- Error messages that say what to do instead.
- Rich `--help` text.
- Machine-readable output, such as JSON.

Make the dev setup repeatable too: seeded data, test users, and one command that brings the environment up the same way every time.

For recorded pstack receipts, handoffs, snapshots, and plans, [`/pstack-schema-validate`](../../skills/pstack-schema-validate/SKILL.md) runs its Node CLI from the approved workspace. On macOS and Linux it confines the selected file read, without executing artifact contents or reading evidence paths; unsupported platforms fail explicitly. Contract validity does not prove behavior, freshness, or permission for later actions.

## Keep the verification skill honest

Apps change, and feature maps go out of date. Audit actively changing apps regularly, potentially daily:

```text
/maintain-verification-skill
```

If your Copilot host exposes scheduling and you approve it, schedule the audit with the permissions and scope it needs. pstack does not supply a scheduler or an automation pack. Without that capability, run it manually.

[`/maintain-verification-skill`](../../skills/maintain-verification-skill/SKILL.md) audits the generated skill: one read-only source reader per feature in parallel, then one live pass that drives every mapped feature. It ends in exactly one of three outcomes. `clean` means full coverage and nothing to ship. `changed` means one PR of proven corrections, confined to the verification skill's own directory. `blocked` names the blocker. It never edits product code. If the live pass catches a product regression, it reports the regression instead of hiding it with a doc edit.

## Prove a property with a formal verification skill

A runtime verification skill proves the paths you drive. Some bugs live on paths nobody drives: two retries that overlap, a lock that expires mid-write, a state change that arrives out of order. Tests rarely reach those cases. For code where such a bug is costly, run:

```text
/create-formal-verification-skill
```

[`/create-formal-verification-skill`](../../skills/create-formal-verification-skill/SKILL.md) picks the target from the code: a promise the code makes, where a break harms users and tests rarely reach the case that breaks it. It picks the strongest target, not the easiest to verify. Name an area or a bug to start there instead:

```text
/create-formal-verification-skill the job lease and retry logic. a job must never run twice at once.
```

The question picks the tool. Whether events can happen in a bad order suits a model checker over a small model of the design, and TLA+ is the default for that in any language. Whether the code behaves for every input suits a verifier that runs on the code. If no verifier runs on your language, the agent says so and tests the real code with generated inputs, not a hand-written model of the function. Those tests are not an exhaustive proof. A property that must hold at every size can need a proof. The agent tells you which tool it chose and why. Tool installation and execution remain subject to host approval.

It verifies one property and shows that property failing on a broken variant of the code in an isolated scratch workspace. When the current code already breaks the property, you get the counterexample as a short sequence of steps in your code's terms. The property stays as stated, so the finding stays a finding. Product code doesn't change unless you ask.

It writes `.github/skills/verify-<area>/SKILL.md`, a project-local skill that tells the next agent whether a change touches the verified code, how to run the check with one command, and how to tell a real bug from a modeling error. Before handing it over, the generator follows that skill once on a scratch change that breaks the property, and the check must catch it. The handoff says what was verified, with which tool and bounds, what the check found, and what it doesn't cover. A pass covers the model or the bound, not the whole system.

The skill also records which code each check covers and the commit where the check last matched it. Merges and refactors that skip the skill can leave the check passing on a description of code that's gone. After them, run [`/maintain-formal-verification-skill`](../../skills/maintain-formal-verification-skill/SKILL.md). It updates the verification from the code, reruns it, shows that each updated check can still fail, and tells you whether each failure is drift in the verification or a bug in the code. It reports `in sync`, `updated`, `bug`, or `blocked` for each check without weakening a property just to make it pass.

## Open the PR

```text
/poteto-mode open the pr. small ordered commits, evidence in the description.
```

The [Opening a PR playbook](../../skills/poteto-mode/playbooks/opening-a-pr.md) works from a worktree, rebases the work into small ordered commits, cleans the diff, unslops the prose, and returns the PR link. Five narrow PRs beat one fat one, and stacked follow-ups beat a growing branch.

Use a matching built-in PR creation or update tool when the current host exposes one for the exact operation. Its repository, branch, base, and PR scope still apply. Do not assume an update tool can retarget a PR or change readiness. Unsupported operations use the repository's available forge workflow, subject to the tool's scope and failure instructions.

Open ready unless the user or repository workflow requires a draft. Preserve an intentional draft; changing it to ready needs approval. Read live PR state before reporting readiness.

## Drive the PR to merge-ready with Babysit

An open PR starts collecting blockers immediately. Checks fail, reviewers comment, trunk moves. Hand that churn to the [Babysit playbook](../../skills/poteto-mode/playbooks/babysit.md):

```text
/poteto-mode babysit this pr. get it green.
```

Babysit watches the PR with a bundled watcher and takes blockers in order: conflicts, then review threads, then CI. Every known fix batches into one push, so the checks restart once instead of after every fix. The comment triage is skeptical, because humans and bots file real catches and noise in the same list. A real finding gets a fix, and noise gets dismissed with the disproof posted on the thread. When all you want is status, ask smaller and Babysit answers without starting the loop:

```text
/poteto-mode check on pr 123. anything outstanding?
```

Babysit stops at merge-ready. It never merges, even with everything green, because merging is a different decision.

## Land the stack with Shipping

Green is not the same as safe. When you're ready to land, say so:

```text
/poteto-mode land the stack.
```

The [Shipping playbook](../../skills/poteto-mode/playbooks/shipping.md) verifies each PR independently before it arms anything. One fresh agent per PR proves the behavior live, and the agent that judges a change is never the one that wrote it. Then Shipping lands only the contiguous verified run from the bottom, one PR at a time through GitHub, and reports the first PR that breaks the chain. A verified PR sitting above an unverified one waits, because merging it would pull the gap in underneath.

Next: [Run work while you sleep](./07-overnight.md).
