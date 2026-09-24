---
name: swarm
description: "Fan out N parallel workers, drain them, and return one report. Use for /swarm, 'swarm this', or parallel coverage, races, gauntlets, and exploration."
---

# Swarm

Fan out N parallel workers. Read-only swarms use the native `pstack-swarm`
factory when `run_factory` is available. Writing swarms keep the isolated Task
worker flow because factory concurrency does not provide workspace isolation.

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
4. Pick the worker model from `swarm workers` in `instructions/pstack-models.instructions.md` in Copilot home (`$COPILOT_HOME`, or `$HOME/.copilot` when unset) when present. Otherwise omit `model`. For a model race, name each arm's model up front.
5. Give every writing worker an isolated workspace: a distinct worktree and
   branch for repository changes, or a worker-specific directory under the
   session artifact directory for scratch output. Separate filenames inside
   one checkout are not isolation because workers would still share the
   working tree and Git index. When workers verify or measure commits, each
   brief names the exact SHAs. A measurement brief also names the method
   (sample count, what one sample is, order). The worker records both in its
   result.

## Phase B: Fan out

For a read-only swarm, call `run_factory` once with name `pstack-swarm` and:

```json
{
  "schemaVersion": 1,
  "objective": "the overall goal",
  "donePredicate": "the exact completion condition",
  "aggregation": "coverage",
  "workers": [
    { "id": "api", "brief": "inspect API behavior" },
    { "id": "tests", "brief": "inspect behavioral coverage" }
  ]
}
```

The first factory contract supports read-only coverage swarms only. Races,
mixed swarms, and all writing work use the legacy flow below. Include the
configured model on each worker only when it is present and not `auto`. The
factory accepts 2-8 workers. Its workers are read-only and must not invoke
factories.

For verification or measurement slices, put the exact SHAs and any required
measurement method in each worker's `brief`, and explicitly require the worker
to record them in its report's `evidence` strings. The factory's schema and
aggregate `status` do not validate these requirements; Phase C is mandatory
before accepting any factory result, including `status: "complete"`.

If `run_factory` is unavailable, excluded by the active model, returns a
failed run, or completes with `status: "blocked"`, use the legacy flow below
from the beginning. Report a `partial` result with its explicit gaps instead
of replaying completed workers. A read-only factory run may fall back once
because it cannot leave partial repository writes.

For a writing swarm, do not call the factory. Spawn all N workers in one
message with `agent_type: "general-purpose"` and `mode: "background"`. Pass the
configured model unless it is absent or set to `auto`. Never replay or
automatically fall back after a writing worker may have changed files.

Every brief stands alone. Include the goal, scope, exact slice or race arm, how to verify, and what to report. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence. A worker that can prove a defect reports `ISSUES` and lists every issue it can prove, not only the first.

If a worker drops out, proceed with N-1 and note it.

## Phase C: Aggregate

Read the terminal results. For a factory result, match each entry in `workers` to its input brief by `id` and inspect its `evidence` strings for every required SHA and measurement-method detail (sample count, sample definition, and order). Do not trust the factory's aggregate `status`, an empty `gaps` list, or a worker's `PASS` as proof of this evidence. Briefs that require neither SHAs nor a method need no such records.

Drop a result that omits or contradicts the SHAs or method its brief names. For a read-only factory result, rerun that slice once as a standalone background `general-purpose` worker with the same brief and configured model; do not invoke the 2-8-worker factory for this retry. For a read-only legacy result, rerun that worker once. Apply the same evidence check to the retry. Never replay a writing worker; record its missing evidence as a gap. After a second read-only miss, record a gap. Recompute coverage and gaps from the accepted results, preserving factory-reported gaps unless a valid retry fills them. Any remaining gap makes the consolidated report partial (or blocked if no usable results remain), even when the factory reported `complete`. A gap does not count as a pass. For coverage, every required slice needs a result. For a race, apply the selection rule declared up front. Use first pass, rank all, or best-of. Do not paste raw worker dumps.

Keep a compact result table, one-line evidenced issues, and explicit gaps or dropouts.

## Phase D: Report

Return one consolidated in-chat report with the table, issue one-liners, gaps or dropouts, and the race rule when used.
