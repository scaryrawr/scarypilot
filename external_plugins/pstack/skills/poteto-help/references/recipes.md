# Prompts worth copying

Swap in real paths, installed skills, and done checks. Give at most one recipe for a help answer. These are prompts for the user to send, not instructions to execute during help.

## Understand

- `/poteto-mode read <thread>. restate the underlying issue in your own words, in plain english. don't change any code yet.`
- `/poteto-mode investigate why <symptom>. give me what we know, what data you used, and your best hypotheses. don't change any code yet.`
- `use /how to understand <subsystem>. then use /why to find out why it broke recently.`
- `/recall my work on <topic> from last week, then read <issue>.` Requires available history.
- `/teach me why you implemented it this way and not <other way>. what did you trade off?`
- `/poteto-mode take over this branch. read the decision log, find what's done, and continue. don't redo finished work.`

For deterministic native inspection, recommend `/pstack status`, `/pstack capabilities`, or `/pstack resume`. These commands make no model calls and launch no workers; resume does not execute a task.

## Build

- Bug: `/poteto-mode <symptom>. repro first, then fix and verify.`
- App bug: `/poteto-mode repro this with /verify-<app>. if it repros on main, fix it and show me before-and-after evidence.`
- Cheap test: `/poteto-mode repro <bug> first. if there's a cheap test path, /tdd it. then fix and rerun.`
- Feature: `/poteto-mode add <behavior>. <current output> stays byte-identical. verify both.`
- Refactor: `/poteto-mode move <code> into one module, zero behavior change. record current output first and prove it's unchanged after.`
- Perf: `/poteto-mode <operation> takes <time> on <fixture>. trace it, fix the measured cause, show me before and after.`
- Repeated mistake: `/correct agents keep adding config flags without registering them in the schema.`

## Design and plan

- `/poteto-mode prototype a few options for <feature>. capture screenshots or timings for me to compare.`
- `/poteto-mode we need <feature>. /architect it first, and answer empirical questions with prototypes. let me review before proceeding.`
- `/poteto-mode write a tutorial for how i would use <new package> first. then /teach me why it beats the current one.`
- `ask /arena for a second opinion on this thread and our approach.`
- `/poteto-mode turn this design into a plan. small verifiable PRs, each with its own verification steps.`
- `/poteto-mode plan the migration of <library> to <target>. small verifiable PRs. the result must match the original exactly, bugs included.`

Capture needs actual tools and permission. A plan is the deliverable, not permission to implement it.

## Review and ship

- `/interrogate the whole branch, but skeptically. don't change anything yet. no nitpicks unless it's a real bug or regression.` Read the dismissals too.
- `/swarm check every package under <dir> against its check script. one worker per package. one report.` Confirm host tools and scope; an expensive native workflow needs explicit consent.
- `/benchmark-checklist vet this speedup before it goes in the pr description.`
- `/pstack-schema-validate validate this pstack plan at <workspace path>.` Contract validity does not prove the recorded evidence.
- `/poteto-mode open the pr. small ordered commits, evidence in the description.`
- `/poteto-mode babysit this pr. get it green.` For status only: `/poteto-mode check on pr <number>. anything outstanding?`
- `/poteto-mode land the stack.` Requires explicit merge authorization and the Shipping checks.

PR creation and updates prefer matching built-in tools within their actual scope. Do not assume they support retargeting or readiness changes. Preserve a draft when the user or repository workflow requires it; an intentional draft is not approval to mark it ready.

## Away and back

- `/poteto-mode im stepping away. <goal> in a fresh worktree off <base>. done means <checks>. keep a decision log. you may commit, but don't push or merge. keep running while the session is active. if truly stuck, stop and write up why.`
- `/show-me-your-work catch me up on what you did last night.` Read its Attention section first.
- `/poteto-mode full autopilot on this queue. each item is independent.` Requires agreed external-write permissions and independent verification.
- `/poteto-mode autopilot these changes but stack them, don't ship. i'll land the stack.`
- `/poteto-mode pause safely. write a durable handoff so i can resume after restarting Copilot.`
- `/reflect capture what we learned so the next run doesn't repeat it.` Approve only edits that change a future decision.
- `/bro` restates the last reply in plain words.

Do not promise work survives laptop closure or host restart. Scheduling, event triggers, cloud sessions, and persistent coordination depend on the installed host and explicit authorization. No recipe authorizes help to invoke them.

Long programs keep the agreed objective in the decision trail and audit hourly through available approved session automation or a bounded timer while the session is active. Re-read that objective on each tick, and record any inability to wake a closed session. Legacy 30-minute plan validation remains compatible; new plans use hourly audits.
