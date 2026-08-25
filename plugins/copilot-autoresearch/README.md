# copilot-autoresearch

A [Copilot CLI](https://github.com/github/copilot-cli) extension that recreates the
[pi-autoresearch](https://github.com/davebcn87/pi-autoresearch) workflow: an
autonomous experiment loop where the agent tries an idea, benchmarks it, keeps
what works, reverts what doesn't, and repeats — without stopping until you tell
it to.

> _Try an idea, measure it, keep what works, discard what doesn't, repeat forever._

## Prerequisites

- A current [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli)
  release with plugin extension support.
- Git, Node.js, and Bash available in the repository where experiments run.

Autoresearch executes benchmark and hook commands and intentionally creates Git
commits or reverts experiment changes in the active repository. Use it only in
a repository whose changes you are prepared to let the agent modify.

## Install

```sh
copilot plugin marketplace add scaryrawr/scarypilot
copilot plugin install copilot-autoresearch@scarypilot
```

Restart Copilot or run `/clear` after installing or updating the plugin.
Approve the extension access prompt the first time it loads.

### Migrating from the standalone extension

Remove any legacy user extension at
`~/.copilot/extensions/copilot-autoresearch` before enabling this plugin, then
restart Copilot or run `/clear`. Loading both copies registers the same three
tool names; the second copy will be rejected by Copilot CLI.

## What it adds

**Tools**
| Tool | Description |
| --- | --- |
| `init_experiment` | One-time session config — name, primary metric, unit, direction. Writes a config header to `.auto/log.jsonl`. |
| `run_experiment` | Runs any shell command, times wall-clock duration, captures output, parses `METRIC name=value` lines, retains overflow output in a bounded temporary file until the next run, and runs `.auto/checks.sh` after a passing benchmark when present. |
| `log_experiment` | Records `keep` / `discard` / `crash` / `checks_failed`. On `keep`, auto-runs `git add -A && git commit`. On other statuses, auto-reverts code changes while preserving `.auto/**`. Computes a session confidence score after 3+ runs. |

**Skills**

| Skill | Description |
| --- | --- |
| `autoresearch-create` | Creates `.auto/prompt.md` and `.auto/measure.sh`, establishes the baseline, and starts the loop. |
| `autoresearch-hooks` | Authors and validates optional before/after iteration hooks. |
| `autoresearch-finalize` | Groups kept experiments into clean, independently reviewable branches and verifies their combined tree. |

**Slash command**

```
/autoresearch <text>     enter autoresearch mode and start (or resume) the loop
/autoresearch off        leave autoresearch mode
/autoresearch clear      delete current and legacy session logs and turn the mode off
/autoresearch export     open a local live dashboard in your browser
/autoresearch status     print a rehydration summary of current session state
```

**Auto-resume**

When in autoresearch mode and the agent goes idle after logging at least one
new experiment, the extension waits 800 ms then sends a follow-up
`Run the next iteration now…` prompt with a deterministic rehydration summary
attached. It matches upstream's 200-turn safety ceiling and stops after more
than 20 consecutive discards or crashes.

**Live run status**

While a benchmark is running, the extension shows a transient status message
with elapsed time and the latest non-empty output line. Completed experiment
summaries remain in the session timeline.

**Live browser dashboard**

`/autoresearch export` starts a loopback-only HTTP server, opens the dashboard
in the default browser, and refreshes it through server-sent events as results
are logged. The dashboard includes summary cards, a metric trend, confidence,
and the complete run table.
The server stops when autoresearch is turned off, cleared, or the session ends.

## Project files

New sessions use the same `.auto/` layout as pi-autoresearch. Legacy-only flat
`autoresearch.*` sessions remain readable; once a current `.auto/` session
artifact is introduced, the current layout consistently takes precedence.

| File | Purpose |
| --- | --- |
| `.auto/log.jsonl` | Append-only run log. The source of truth across restarts. |
| `.auto/prompt.md` | Living session document — objective, metrics, files in scope, what's been tried. |
| `.auto/measure.sh` | Optional benchmark script. When present, `run_experiment` rejects commands that don't invoke it. |
| `.auto/checks.sh` | Optional correctness gate (tests, types, lint). Runs after every passing benchmark. |
| `.auto/ideas.md` | Optional ideas backlog for promising deferred optimizations. |
| `.auto/hooks/before.sh` | Optional executable hook fired before each iteration. |
| `.auto/hooks/after.sh` | Optional executable hook fired after each iteration. |
| `.auto/config.json` | Optional `workingDir` and `maxIterations` configuration. |
| `.auto/runtime/<session-id>.json` | Internal per-session sidecar preserving the run/checks boundary and explicit mode state without leaking activation across sessions. |

## Confidence scoring

After 3+ experiments, the extension computes
`|best_improvement_over_baseline| / MAD(metric_values)`. ≥2.0× is likely real,
1.0–2.0× is above noise but marginal, <1.0× is within noise — re-run to
confirm before keeping. Advisory only; never auto-discards.

## Differences vs pi-autoresearch

Parity is tracked against pi-autoresearch 1.6.2. The `.auto/` contract,
experiment lifecycle, benchmark and checks gates, hooks, iteration limits,
failure guard, finalization workflow, and live browser reporting are preserved
where Copilot exposes an equivalent extension API.

The Copilot CLI extension surface is narrower than pi's, so a few things are
adapted:

- **No persistent status widget / dashboard expand-collapse / fullscreen
  overlay.** A transient status message updates while an experiment runs;
  `/autoresearch status` prints the full rehydration summary on demand.
- **No fullscreen terminal overlay.** `/autoresearch export` instead opens the
  same experiment data as a live local browser dashboard.
- **No compaction summary injection.** Copilot CLI does not expose a
  `session_before_compact` hook to extensions, so the deterministic rehydration
  summary is included in every auto-resume prompt instead.
- **No configurable keyboard shortcuts.** Copilot CLI extensions can't bind
  keys; use the slash command subcommands.
- **Tools cannot be removed dynamically from Copilot's model schema.** They
  remain discoverable while mode is off, but reject execution until
  `/autoresearch <goal>` activates the loop.

## Credits

This extension is a port of [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch)
by [@davebcn87](https://github.com/davebcn87) — all credit for the original
autoresearch concept, workflow design, and file format goes to that project.
This is simply a Copilot CLI adaptation of the same idea.

## Develop and test

```bash
cd extensions/copilot-autoresearch
npm install
npm run typecheck
npm run test
bash ../../skills/autoresearch-finalize/tests/finalize-smoke.sh
```

Copilot CLI injects its bundled `@github/copilot-sdk` when it loads the
extension. The package dependency pins the SDK version used for local
development and tests; plugin users do not need to run `npm install`. Node.js
loads the TypeScript source directly through `extension.mjs`, so no build step
is required.

## Resources

- [Copilot CLI plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference)
- [Source migration record](./NOTICE.md)
- [pi-autoresearch MIT license](./LICENSE.pi-autoresearch)

This plugin was migrated from
[`scaryrawr/copilot-autoresearch`](https://github.com/scaryrawr/copilot-autoresearch)
at the revision recorded in `NOTICE.md`.
