# Anti-Slop hook behavioral eval

This eval measures what an agent **does after** receiving hook feedback; the
hook unit tests in `../hooks/` instead test payload parsing and diagnostics.
Each case starts in a fresh temporary workspace with a stub and no repository
lint setup. The runner invokes the actual Copilot CLI twice per case: once
with this local plugin (including hooks and skill) and once with an otherwise
identical local plugin copy whose hook registration is removed. Neither run
loads user-installed plugins or repository instructions. Runs are sequential
and paired by case and repetition; the same CLI/model must be used for both.

## Run

From the repository root, after installing its existing development
dependencies, with an authenticated `copilot` CLI and registry access for
Oxlint's first-use installation:

```bash
node plugins/anti-slop/evals/run.mjs --list
node plugins/anti-slop/evals/run.mjs --case post-edit-recovery --repeats 1 --output ./anti-slop-eval.json
node plugins/anti-slop/evals/run.mjs --repeats 3 --output ./anti-slop-eval.json
node --test plugins/anti-slop/evals/run.test.mjs
```

The report path is optional; without it the runner prints a summary only.
Avoid committing eval results: CLI output is inspected in memory, not saved
as a transcript. `--mode on` or `--mode off` runs one arm; `--timeout-ms N`
changes the per-CLI-turn timeout (default 180,000 ms). Temporary workspaces,
the hooks-off plugin copy, and the isolated Copilot cache are removed after
the run. For local debugging, `--trace-dir PATH` saves raw CLI JSONL for each
turn; these traces contain prompts, generated code, and possibly model
reasoning, so keep them private and do not commit them. Do not run this
against a real project: the model edits code in scratch workspaces and incurs
model and first-install costs.

Each feedback fixture uses a separate **draft-edit turn**, then resumes the
same CLI session with a recovery request. The draft turn asks for an exact
edit, reducing the chance the agent avoids the target pattern before any
feedback can be delivered. The report counts feedback as delivered only if
it appears on that draft turn; later feedback is not evidence of recovery
from the draft. Lack of draft feedback is reported, not counted as recovery.
The legacy case has only the task turn and should not repeat an unchanged
legacy finding.
Cases cover a denied assertion chain, a post-edit filter/map diagnostic, a
renamed generic record helper, a justified object check at a JSON boundary,
and leaving an unrelated legacy assertion untouched. The prompts do not tell
the agent to invoke the skill. They restrict available tools to `view`,
`create`, and `edit`, so this eval cannot test whether an agent would bypass
a guard via shell writes in an unrestricted session.

The JSON report records, per run, whether the CLI actually delivered an
Anti-Slop denial/advisory, whether the final source passes independent
behavior checks, and whether the targeted source checks pass. **A successful
final file without observed feedback is not evidence of recovery from a
hook.** The legacy case may receive legitimate advice on newly added code;
`unexpectedFeedback` flags only advice repeating its untouched chained
assertion. The `models` field records which model answered each arm; for a
fair comparison, pin a fixed model with `--model NAME` and verify the arms
match. Compare
hook-on and hook-off pass counts for the same case and repetition; don't treat
single-run differences or wall-clock duration (which includes model time and
first-use install) as a statistical result. Behavior is checked in a separate
Node process with a timeout; the runner is for trusted local experiments, not
a security sandbox for untrusted model-generated programs.
