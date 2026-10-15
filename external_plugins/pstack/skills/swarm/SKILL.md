---
name: swarm
description: "Fan out N parallel workers, drain them, and return one report. Use for /swarm, 'swarm this', or parallel coverage, races, gauntlets, and exploration."
---

# Swarm

Fan out N Task workers and consolidate their evidence. Writing workers need
isolated workspaces. Read-only briefs constrain intent, not the host's tool
permissions; do not claim enforced read-only execution or journaled input pinning.

## Start

Open a todolist with one entry per phase before launching anything.

1. Frame
2. Fan out
3. Aggregate
4. Report

## Phase A: Frame

1. State the done predicate and the artifact or report the swarm must return.
2. Choose the shape. Partition into slices, race N workers on identical briefs, or mix both. For a race or mixed shape, declare `first pass`, `rank all`, or `best-of` before spawning.
3. Set N from the user or derive it from the shape. N is total workers, not the Task concurrency limit.
4. Resolve each worker's model from the `swarm workers` line in `instructions/pstack-models.instructions.md` in Copilot home (`$COPILOT_HOME`, or `$HOME/.copilot` when unset). Missing configuration, a missing role line, `auto`, and `inherit-parent` all resolve to no explicit model. Only a concrete configured slug resolves to an explicit model. Use this resolved choice at every dispatch and retry; never copy a raw alias into `model`. No explicit model lets Copilot choose the agent's default, not necessarily the parent model. If the host rejects a concrete slug before that worker starts, resolve it to no explicit model and report the fallback. Do not retry a writing worker that may already have changed files. For a model race, name each arm's concrete model up front.
5. Give every writing worker an isolated workspace: a distinct worktree and
   branch for repository changes, or a worker-specific directory under the
   session artifact directory for scratch output. Separate filenames inside
   one checkout are not isolation because workers would still share the
   working tree and Git index. When workers verify or measure commits, each
   brief names the exact SHAs. A measurement brief also names the method
   (sample count, what one sample is, order). The worker records both in its
   result.

## Phase B: Fan out

Use the current host's Task tool. Spawn independent workers together with
`agent_type: "general-purpose"` and `mode: "background"` when that mode is
supported. Otherwise use the supported synchronous Task interface and disclose
that execution is serial. If Task agents are unavailable, report the swarm
blocked instead of claiming independent coverage.

Pass the resolved model from Phase A only when it is an explicit concrete slug;
otherwise omit `model`, including for both aliases. Never replay or automatically
fall back after a writing worker may have changed files.

Read-only briefs explicitly prohibit edits, commits, external writes and nested
delegation. Name the files each worker must inspect. For verification or
measurement, include exact SHAs, the required method (sample count, sample
definition and order), and before/after freshness checks. Require those facts in
the worker's report. If the work needs host-enforced tool restrictions or stable
input snapshots that the current host cannot provide, stop and report that
capability gap; instructions and hashes are not substitutes for enforcement.

Retain the returned agent IDs. Wait for terminal results using the host's
completion notifications and result-reading tools; do not respawn a worker
because it is still running. No journaled replay or automatic resume is provided.

Every brief stands alone. Include the goal, scope, exact slice or race arm, how to verify, and what to report. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence. A worker that can prove a defect reports `ISSUES` and lists every issue it can prove, not only the first.

If a worker drops out, proceed with N-1 and note it.

## Phase C: Aggregate

Read the terminal results and match each to its assigned brief. Check every
required SHA, measurement-method detail and freshness record. A supplied digest,
path, evidence string or `PASS` does not prove truth. Briefs requiring neither
SHAs nor a method need no such records.

Drop a result that omits or contradicts the required evidence. For a read-only
worker, retry that slice once with a fresh agent, the same brief and Phase A's
resolved model choice. Omit `model` for either alias, missing configuration or
a rejected slug. Apply the same evidence check to the retry. Never replay a
writing worker; record its missing evidence as a gap. Changed inputs invalidate
the affected result rather than authorizing a retry against different bytes.
Recompute coverage from accepted results. Any unresolved gap makes the report
partial, or blocked if no usable results remain. For coverage, every required
slice needs a result. For a race, apply the declared first pass, rank all or
best-of rule. Do not paste raw worker dumps.

Keep a compact result table, one-line evidenced issues, and explicit gaps or dropouts.

## Phase D: Report

Return one consolidated in-chat report with the table, issue one-liners, gaps or dropouts, and the race rule when used.
