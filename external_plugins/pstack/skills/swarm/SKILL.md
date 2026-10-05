---
name: swarm
description: "Fan out N parallel workers, drain them, and return one report. Use for /swarm, 'swarm this', or parallel coverage, races, gauntlets, and exploration."
---

# Swarm

Fan out N parallel workers. Read-only swarms use the native `pstack-swarm`
workflow when `run_dynamic_workflow` is available. Writing swarms keep the isolated Task
worker flow because workflow concurrency does not provide workspace isolation.

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
4. Resolve each worker's model from the `swarm workers` line in `instructions/pstack-models.instructions.md` in Copilot home (`$COPILOT_HOME`, or `$HOME/.copilot` when unset). Missing configuration, a missing role line, `auto`, and `inherit-parent` all resolve to no explicit model. Only a concrete configured slug resolves to an explicit model. Use this resolved choice at every native, legacy, fallback, and retry dispatch; never copy a raw alias into `model`. No explicit model lets Copilot choose the agent's default, not necessarily the parent model. If the host rejects a concrete slug before that worker starts, resolve it to no explicit model and report the fallback. Do not retry a writing worker that may already have changed files. For a model race, name each arm's concrete model up front.
5. Give every writing worker an isolated workspace: a distinct worktree and
   branch for repository changes, or a worker-specific directory under the
   session artifact directory for scratch output. Separate filenames inside
   one checkout are not isolation because workers would still share the
   working tree and Git index. When workers verify or measure commits, each
   brief names the exact SHAs. A measurement brief also names the method
   (sample count, what one sample is, order). The worker records both in its
   result.

## Phase B: Fan out

For a read-only swarm, call `run_dynamic_workflow` once with name `pstack-swarm`
and the following `args`:

```json
{
  "schemaVersion": 1,
  "objective": "the overall goal",
  "donePredicate": "the exact completion condition",
  "aggregation": "coverage",
  "inputFiles": ["src/api.ts", "tests/api.test.ts"],
  "workers": [
    { "id": "api", "brief": "inspect API behavior" },
    { "id": "tests", "brief": "inspect behavioral coverage" }
  ]
}
```

The first workflow contract supports read-only coverage swarms only. Races,
mixed swarms, and all writing work use the legacy flow below. Include the
resolved explicit model from Phase A on each worker only when one remains. Omit
`model` for both aliases, missing configuration, and a rejected slug. The
workflow accepts 2-8 workers. Its workers are read-only and must not invoke
workflows.

For verification or measurement, declare every file whose bytes must stay
unchanged in `inputFiles`. Replace the example paths with actual workspace
files. The optional manifest accepts 1-128 unique files. It rejects missing
files, directories, symlinks, outside paths, URLs, traversal, and duplicate
canonical targets. Native confined reads require macOS or Linux.

The first attempt journals `pinnedInputSnapshot`, containing the canonical
workspace path, directory identity, and each declared file's canonical path
and exact-byte SHA256. Every attempt reads those inputs outside the journal
before admitting workers. It checks again before aggregation and before
returning the result. Workspace, path, or byte drift raises a workflow error
before cached results can be accepted. Resume with unchanged inputs reuses
the existing workers. After drift, start a new run for the changed inputs.
Do not silently remove the manifest to retry.

This protects only declared file bytes and workspace identity at those
boundaries. It does not pin undeclared reads, provide an immutable snapshot,
detect a transient edit restored between checks, or prove factual evidence.
Legacy v1 calls without `inputFiles` remain supported but have no freshness
guarantee. A supplied SHA, digest, path, `PASS`, or evidence string does not
prove truth. Phase C still owns evidence acceptance.

Save the returned run ID and wait for completion. Read the durable result with
`dynamic_workflows_manage` using `operation: "inspect-run"` and that `runId`.
Check the run envelope's status before inspecting its result: a completed run
can still contain a swarm result with `status: "partial"` or `"blocked"`.
Do not launch another workflow while the original is still running.

For verification or measurement slices, put the exact SHAs and any required
measurement method in each worker's `brief`, and explicitly require the worker
to record them in its report's `evidence` strings. The workflow's schema and
aggregate `status` do not validate these requirements; Phase C is mandatory
before accepting any workflow result, including `status: "complete"`.

If `run_dynamic_workflow` is unavailable, excluded by the active model, returns a
failed run, or completes with `status: "blocked"`, use the legacy flow below
from the beginning. Report a `partial` result with its explicit gaps instead
of replaying completed workers. A read-only workflow run may fall back once
because it cannot leave partial repository writes.
Do not use fallback to bypass pinned-input drift or an invalid manifest.
Report that error and reframe the inputs before starting new work.

For a writing swarm, do not call the workflow. Spawn all N workers in one
message with `agent_type: "general-purpose"` and `mode: "background"`. Pass the
resolved model from Phase A only when it is an explicit concrete slug; otherwise
omit `model`, including for both aliases. Never replay or
automatically fall back after a writing worker may have changed files.

Every brief stands alone. Include the goal, scope, exact slice or race arm, how to verify, and what to report. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence. A worker that can prove a defect reports `ISSUES` and lists every issue it can prove, not only the first.

If a worker drops out, proceed with N-1 and note it.

## Phase C: Aggregate

Read the terminal results. For a workflow result, match each entry in `workers` to its input brief by `id` and inspect its `evidence` strings for every required SHA and measurement-method detail (sample count, sample definition, and order). Do not trust the workflow's aggregate `status`, an empty `gaps` list, or a worker's `PASS` as proof of this evidence. Briefs that require neither SHAs nor a method need no such records.

Drop a result that omits or contradicts the SHAs or method its brief names. For a read-only workflow result, respawn that slice once as a fresh standalone background `general-purpose` worker with the same brief and Phase A's resolved model choice; do not invoke the 2-8-worker workflow for this retry. For a read-only legacy result, respawn that worker once with a fresh agent, the same brief, and the same resolved choice. In both retries, omit `model` for either alias, missing configuration, or a previously rejected slug. Apply the same evidence check to the retry. Never replay a writing worker; record its missing evidence as a gap. Recompute coverage and gaps from the accepted results, preserving workflow-reported gaps unless a valid retry fills them. Any remaining gap makes the consolidated report partial (or blocked if no usable results remain), even when the workflow reported `complete`. A gap does not count as a pass. For coverage, every required slice needs a result. For a race, apply the selection rule declared up front. Use first pass, rank all, or best-of. Do not paste raw worker dumps.

Keep a compact result table, one-line evidenced issues, and explicit gaps or dropouts.

## Phase D: Report

Return one consolidated in-chat report with the table, issue one-liners, gaps or dropouts, and the race rule when used.
