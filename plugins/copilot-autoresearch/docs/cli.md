# Run experiments without a native extension host

Use Node.js 22 or later and Bash on `PATH`. The installed plugin includes the
CLI bundle, TypeBox, and the same platform execution resources as the native
extension. No SDK, npm install, source checkout, or runtime download is required.
Windows has the same architecture and Git for Windows prerequisites as the
native extension.

## Initialize and keep a baseline

First prepare `.auto/measure.sh` and any `.auto/checks.sh` in your experiment
workspace. The benchmark prints `METRIC name=value` lines. Commit your session
setup before using automatic rollback. Keep the CLI's internal files out of
version control with `.auto/cli*` in the workspace's ignore rules.

The examples use a POSIX shell. Quote paths and JSON for your actual shell.
Replace both absolute paths before running anything.

```sh
CLI="/absolute/plugin path/scripts/autoresearch.mjs"
WORKSPACE="/absolute/experiment workspace"
node "$CLI" --help
node "$CLI" schema
node "$CLI" init --workspace "$WORKSPACE" --git manual \
  --json '{"name":"Reduce test time","metric_name":"time_ms","metric_unit":"ms","direction":"lower"}'
node "$CLI" run --workspace "$WORKSPACE" --baseline \
  --json '{"command":"bash .auto/measure.sh","timeout_seconds":600,"checks_timeout_seconds":300}'
node "$CLI" log --workspace "$WORKSPACE" \
  --json '{"commit":"0000000","metric":10,"status":"keep","description":"baseline","asi":{"hypothesis":"unchanged baseline"}}'
node "$CLI" status --workspace "$WORKSPACE"
```

In manual mode the example SHA is a placeholder for illustration. Supply the
real SHA of each kept change if you plan to finalize it into branches.
The CLI does not infer a metric from a model score or auto-select a decision.
Use the measured primary metric and include all tracked secondary metrics.

For candidates, omit `--baseline`. Log every completed run before the next
run or initialization. Use `init` again for a new segment and baseline.
Earlier results remain in the journal.

## Select a Git policy

`init` requires an explicit policy.

- `--git manual` records results without Git commits or reverts. You own
  rollback, commits, and the supplied SHA.
- `--git automatic` uses the native implementation. A keep stages all changes
  and commits them. Other statuses revert code while preserving experiment
  files. Use this only with explicit authority to mutate the whole repository.
  CLI setup requires an accessible Git worktree. Both initialization and logging
  check that `.auto/cli*` control files are ignored and untracked, including
  locks and temporary state files, before automatic Git changes. Rejections
  explain which files need attention; the CLI never edits or stages ignore
  configuration. Git failures or an unconfirmed new commit SHA fail the CLI
  action instead of returning a successful log.

The policy persists across processes. Native Copilot tools retain their
existing automatic Git behavior and session-specific activation.

## Observe execution gates

The CLI calls the same typed operations as the native tools. It preserves
workspace validation, the configured iteration limit, benchmark-script
enforcement, metric parsing, secondary-metric consistency, checks after passing
benchmarks, timeouts, process cancellation, and journal/confidence semantics.
Benchmark and checks output use bounded capture. Returned output tails are
limited to 10 lines and 4 KiB each.

CLI-specific restrictions prevent a new shell process from losing gates.

- Initialization explicitly activates CLI mode in that workspace.
- The first run requires `--baseline` and a positive primary metric kept after
  passing the benchmark and checks.
- A failed baseline must be logged, then followed by `init` before retrying.
  The shared journal defines the first result of each segment as its baseline,
  even when that result failed. A new segment preserves those semantics.
- A failed benchmark, timeout, or cancellation can only be logged as `crash`
  with primary metric zero. Failed checks require `checks_failed`.
- A passing run can only be logged as `keep` or `discard`.
- The CLI rejects malformed configuration instead of ignoring it. Limits are
  positive integers and timeouts are positive numbers of at most 86,400 seconds.
- Native and CLI writers must not operate concurrently in the same experiment
  directory. CLI commands use an exclusive lock; journal fingerprints detect
  changes between CLI commands.

Commands print JSON. Exit codes are 0 for success, 1 for a rejected action or
error, 2 for benchmark/check failure or timeout, and 130 for cancellation.
Send SIGINT or SIGTERM to cancel a CLI benchmark. The CLI passes cancellation
to the shared owned-process executor and waits for cleanup.

## Recover after interruption

The shared append-only `.auto/log.jsonl` is the experiment record.
`.auto/cli.json` contains CLI activation, Git policy, journal fingerprint,
run/check gates, and a pending operation receipt. Writes replace the state
atomically after flushing it. No fabricated host session or home-directory state
is used. Native automation counters remain in the native session.

Run `status` before recovery. Inspect any interrupted commands and stop them
before continuing. SIGKILL, power loss, and machine restart cannot guarantee
child-process cleanup. Recovery does not kill processes, retry Git operations,
or claim that rollback completed.

After confirming that commands stopped, run:

```sh
node "$CLI" recover --workspace "$WORKSPACE" --json '{"confirm_stopped":true}'
```

Recovery refuses a lock owned by a live PID. An interrupted run becomes an
aborted receipt that must be logged as a crash. If the journal already contains
the receipt's result, recovery clears the pending state without appending it
again. Inspect Git state separately if logging was interrupted.
If recovery itself was interrupted while reclaiming a stale lock, inspect
`.auto/cli.lock.recovery` and its PID before manually removing that guard.

Malformed or partially written journals and divergent external writes fail
closed. Inspect and repair those files manually. After an external completed
write with no pending receipt, use `init` for an explicit new segment.
Do not delete a pending receipt to bypass failed checks.

Overflow output is ephemeral, not part of journal validity. New output receipts
record the executor file's path, device, inode, and birth time. Changing `TMPDIR`
does not invalidate the experiment: the next run removes the original file only
when its identity still matches, including across `init`. Missing or replaced
files and legacy pointers without file identity are dropped with a diagnostic,
without deleting any file. Legacy overflow files may need manual cleanup.
Malformed paths and mismatched path/identity receipts still fail closed.
`status` is read-only; a dropped cleanup pointer is persisted by the next state
write. As with the journal, CLI state must not be edited concurrently.

The CLI retains the native operation's human-readable messages inside its
JSON envelope. References there to native tools describe the equivalent action,
not an extra CLI dependency.

## Native-only behavior

The CLI executes one action and exits. It does not register UI, open a live
dashboard, inject context into a session, resume an agent, or schedule turns.
An external agent or operator owns the loop and its execution authority.
Confidence is advisory and never authorizes commands, Git changes, or scheduling.
