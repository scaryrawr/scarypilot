# Skill evals during PR work

Run affected-skill selection without waiting for a separate eval request.
Selection does not make model calls. It identifies behavioral coverage that
the agent must run after approval or report as unrun.

## Select affected coverage

Use the intended PR base, not a guessed default branch. Local selection includes
committed changes since the merge base, staged and unstaged edits, and untracked
files. It does not fetch or modify Git refs.

```sh
node tools/skill-evals.mjs select --base <intended-PR-base>
node tools/skill-evals.mjs check --base <base-commit> --head <head-commit> --json
```

Explicit `--head` requires that revision to be checked out, with no tracked edits
or untracked eval inputs. Otherwise validation would read different files than
the reported commit.

Use `--output <new-file>` to save the complete JSON report outside the checkout.
The file must not already exist. Repeat selection after relevant edits.
`check` and `select` perform the same structural validation and never execute a
model. The different names distinguish CI checks from ordinary agent work.

The report includes selection reasons, missing evals, excluded cases, and the
maximum proposed calls for one repetition with no baseline. `model: null` and
`monetaryLimit: null` mean unapproved, not unlimited. The report never grants
execution approval.

Skill-local Markdown, scripts, references, and fixtures select that skill.
Plugin-wide inputs select the plugin's skills. Root agent guidance, marketplace
registration, and eval-tooling changes select all skills for a coverage review.
Pstack sibling routing is declared in `policy.json`. Add explicit shared
dependencies when another skill starts relying on shared rules. Selection must
not silently omit consumers of a changed rule. Unsupported cases remain visible
but do not run automatically.

Added skills without cases appear as `missing_evals`. Removed and renamed skill
paths appear in `removedSkills`. Read both sides of a rename when reviewing
coverage. The current inventory validates JSON, skill names, assertions, fixture
existence, and fixture confinement. It rejects symlinks and flattened fixture
name collisions.

## Obtain model execution approval

The Copilot policy admits only better-init's existing fixture-backed task cases
7 and 8 and its trigger cases. Other suites need a reviewed execution policy and,
where necessary, an independent grader. This is a restricted pilot, not coverage
for all skills. Anti-Slop's hook-feedback experiment remains its existing
`plugins/anti-slop/evals/run.mjs` command and requires separate approval.

Before model execution, present the selected prompts and fixtures, the model and
provider, the maximum calls, repetitions, baseline arms, timeouts, and the spending
allowance. Approval of a code change does not approve inference spending. Until a
standing policy is configured, ask for approval before the first paid call.
Missing authentication, unsupported CLI features, or unavailable model entitlement
is an execution error, not a negative trigger result.

The checked-in helper subset comes from the locally Copilot-adapted skill-creator.
It does not depend on a developer's installation path. Its provenance manifest,
Apache-2.0 license, and modification notice live in `skill-creator/`. Do not replace
it with stock upstream without checking the Copilot changes.

Run the helper entrypoints with `--help` for their execution and grading options.
Keep the output workspace outside the repository, such as the conversation's
artifact directory. Do not point an agent at a real checkout for these runs.

After explicit model and spending approval, the bounded pilot commands are:

```sh
python3 tools/skill-evals/skill-creator/scripts/run_eval.py \
  --eval-set plugins/better-init/skills/better-init/evals/trigger-evals.json \
  --skill-path plugins/better-init/skills/better-init \
  --workspace <private-artifact-directory> \
  --query-index 0 --query-index 6 \
  --model <approved-model> --approved --max-calls 2 --timeout 120 \
  --auth-env <approved-exported-token-variable>

python3 tools/skill-evals/skill-creator/scripts/run_harness_eval.py \
  --evals plugins/better-init/skills/better-init/evals/evals.json \
  --skill-path plugins/better-init/skills/better-init \
  --workspace <private-artifact-directory> \
  --case-id 7 --case-id 8 \
  --model <approved-model> --approved --max-calls 2 --timeout 120 \
  --auth-env <approved-exported-token-variable>
```

Each command above proposes two CLI invocations, not two provider requests.
One agent invocation can make multiple model requests. The CLI token variable
must be chosen explicitly from `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or
`GITHUB_TOKEN`. The runners do not copy a stored account, personal CLI
configuration, or arbitrary environment variables into the fresh CLI home.
Omitting `--auth-env` leaves authentication unconfigured. Do not set up new
credentials merely to make an eval run.

The current task grader uses conservative lexical contracts for the exact
existing assertions. It rejects unknown assertions. Case 8's broad
no-invented-requirements assertion remains ungraded: matching known words cannot
prove that a requirement is grounded. A demonstrated hosted-access contradiction
can still fail that assertion, but otherwise the case cannot receive an overall
pass without independent semantic grading. It is not a general semantic judge,
and the fake-CLI tests do not establish how often real model prose can be graded. Review the
`limitations` and `execution_checks` fields in every `grading.json`.

## Run the separate Codex and oMLX pilot

`run_codex_omlx.py` admits Better-init discovery indexes 8 and 6, followed by
native task cases 108 and 109. It uses the installed `omlx launch codex`
integration with the explicit model `Qwen3.6-35B-A3B-oQ6e-mtp` at
`http://127.0.0.1:8000`. It does not use or change the server's default model.
The model must already be loaded. The runner does not install software, download
models, copy account credentials, or fall back to a hosted provider.

This pilot has a separate, opt-in native sandbox policy. It is not the Copilot
runner's exclusive file-tool policy. Review both policies before approval.
The supported client is `codex-cli 0.169.0` on macOS. Other versions and platforms
need another policy review.

The named native profile allows normal Codex shell and file tools.
The fixture tree is read-only, and only its `outputs/` subtree is writable.
An explicit `outputs/.agents` grant overrides Codex's default protection of that
directory inside writable roots. It does not expose the staged input skill.
Command IP networking is disabled, including connections to the local model.
Explicit rules deny global scratch roots and Applications. The required
`:minimal` platform profile still permits system/runtime reads and some native
IPC. The trusted client remains outside the command sandbox to reach oMLX.
Do not describe this as fixture-only reads, zero IPC, or client-wide network
containment.

Each invocation uses fresh `HOME` and `CODEX_HOME`, a scrubbed environment,
disabled plugins, hooks, subagents, search, and telemetry, and no configured
MCP servers. Native system-skill descriptions remain visible.
The runner checks native discovery, the exact selected model/provider, and the
acknowledged named permission profile before starting a model turn.
Before each client starts, eight model-free sandbox controls verify actual
candidate reads, all expected guidance destinations, denied input and outside
writes, denied private reads, symlink escapes, and blocked loopback networking.
The controls write both native review-owner paths, not just an ordinary output file.
It preserves native RPC messages rather than manufacturing Copilot events.

First run the model-free preflight in a new private artifact directory.

```sh
uv run --offline --no-project --python 3.12 python tools/skill-evals/run_codex_omlx.py \
  --workspace <new-private-artifact-directory> \
  --model Qwen3.6-35B-A3B-oQ6e-mtp --preflight-only
```

After approval of both the model budget and the native sandbox policy, run
the four cases serially. Use another new artifact directory.

```sh
uv run --offline --no-project --python 3.12 python tools/skill-evals/run_codex_omlx.py \
  --workspace <another-new-private-artifact-directory> \
  --model Qwen3.6-35B-A3B-oQ6e-mtp \
  --approved --native-sandbox-approved --max-calls 4 --timeout 300
```

There is one repetition, no baseline, and no retry of a failed case.
An infrastructure error stops the remaining cases. Each model turn has a
300-second maximum invocation deadline, including startup.
The launcher can also make model-free native-instruction probes and metadata
requests. These are not extra evaluation turns.
An invocation can make multiple inference requests.
If both task cases remain unstarted after an infrastructure failure, the
separately approved task scope uses `--tasks-only --max-calls 2`.
Track the combined budget across reports. This option does not approve more calls
or retry failed discovery cases.

Inspect `results.json`, each case's `result.json`, retained native traces,
launcher diagnostics, input hashes, configuration, and output snapshot.
`invocations_started` counts submitted turns conservatively, including errors.
Native acknowledgement proves client-selected model identity, not independent
server-side served-model attribution.
An oMLX warning about fallback coding instructions is retained in `launcher_notes`.
That warning limits comparisons with ordinary Codex base instructions.

Discovery cases stage the candidate description and a minimal body.
Positive load evidence requires a completed successful native `cat` of the
exact staged skill, directly or through a native shell wrapper.
Other read shapes remain ungraded.
Absence of that read never becomes a passing negative.
Task cases submit a native explicit skill input. Their generated-file contracts
and path mappings receive lexical checks. Semantic expectations remain
`not_run` until separately reviewed, even when those checks pass.
Model self-report, process completion, and file existence do not prove semantic
grounding or actual fixture inspection.

The coverage selector and `policy.json` still describe the Copilot pilot.
Their proposed call totals do not include this separately approved native
pilot. Do not count unrun native cases as Copilot coverage.
Credential-free native adapter tests run through the existing Python test command
below and make no inference calls.

## Interpret the evidence

Trigger cases use natural requests and test whether the candidate skill is
loaded. They do not prove that the skill's body is correct. Task cases explicitly
instruct the model to use the skill. They test compliance after loading and do not
prove discovery. Report the two results separately.

Task outputs use the existing skill-creator layout with `eval_metadata.json`,
per-run transcripts and timing, `outputs/`, and `grading.json`. Assertions need
evidence in actual outputs or tool events. A claimed action in a final answer is
not evidence that the action occurred. No grade or an incomplete grade means the
behavior has not passed. Do not treat a successful subprocess exit or a generated
file's existence as the behavioral verdict.

Use these statuses consistently:

| Status | Meaning |
| --- | --- |
| `passed` | The intended execution and every required assertion completed successfully. |
| `failed` | Complete evidence contradicts a required behavioral assertion. |
| `error` | Execution, evidence parsing, isolation, or grading was invalid or incomplete. |
| `not_run` | Approval, supported tools, reviewed cases, or grading is still missing. |
| `not_applicable` | The diff selected no applicable behavioral work. |

Do not retry until green. Keep every attempt. One run is a smoke check, not a
stability guarantee. Repetitions expose variance and consume additional calls.
For a base-versus-head claim, hold prompts, fixtures, assertions, CLI, model, and
tool policy constant. Record their hashes and actual model identity. A no-skill
baseline measures a different question and can be contaminated by personal
skills unless discovery is isolated.

The current helpers are not blinded organic-workflow experiments. Explicit-load
task prompts reveal the requested skill. Do not expose grader assertions to the
candidate or optimize descriptions against the same cases during a regression
check. Description optimization remains separate.

Trigger prompts that refer to existing guidance must declare that input with
`files`, using the task format's skill-relative `evals/files/` paths. The trigger
runner accepts only visible Markdown files and copies them to the scratch root
under their basenames, without changing the query or adding a skill-load hint.
Fixtures are checked before any inference, hashed, retained, and read-only.
Missing fixtures or failed reads remain execution errors, not passing negatives.

## Keep Copilot execution restricted

These are trusted, offline file-oriented runs. A disposable directory is not a
credential or network sandbox. `--allow-all` is not containment.

Only reviewed file tools and skill loading belong in this pilot. Do not enable
shells, network tools, personal plugins, live MCP servers, remote exports, screen
capture, installs, uploads, ADO writes, or merge tools to make an excluded case
pass. Fixture MCP configuration is input data, not configuration to activate.
Skills requiring sibling skills or native extensions remain unrun until those
dependencies have a reviewed execution policy.

The runner places the model's actual working directory in a separate temporary
tree, outside the artifact directory's ancestors. Merely changing `HOME` does
not prevent ancestor `.agents/skills` discovery. The trace must show only the
candidate and CLI built-in skills, with every MCP server disabled. Built-in
skill descriptions remain visible, so this is not a zero-other-skills baseline.
Loading any skill other than the staged candidate invalidates the evidence.
The scratch tree is copied into the private run snapshot and then removed.

Only the two expected guidance paths receive write permission. CLI versions
using `apply_patch` and versions using `create` or `edit` are admitted. Patch
events are checked for the same exact paths. Deletion and move operations are
not supported. Unsupported CLI flags, tools, event types, or missing discovery
events are errors, not negative trigger results.

Preserve raw traces and stderr privately for diagnosis. Traces can contain
prompts, generated code, reasoning, or sensitive content. Never commit them.
Obtain approval before uploading model evidence externally. Missing usage is
unknown, not zero. Output character counts are not token counts. Call limits and
timeouts do not establish a monetary hard cap.

## Run credential-free checks

```sh
node --test tools/skill-evals.test.mjs
python3 -m unittest discover -s tools/skill-evals/skill-creator/tests -v
```

The PR workflow runs these contracts with fake model results and validates the
inventory at the PR head against its explicit base. It uploads only a coverage
report. It receives no model credential and makes no inference calls.

A green `Skill eval coverage` check proves structural checks passed. It does not
prove skill behavior passed. Hosted model execution and behavioral branch
protection are deferred. Do not add `pull_request_target` checkout of PR code
beside credentials as a shortcut.

The initial live smoke established one successful explicit-load better-init
case, with its required fixture reads and generated files inspected. Earlier
attempts exposed ancestor skill contamination and a missing patch editor.

On 2026-10-23, a separately approved GPT-6.1 Sol discovery smoke used ordinary
requests, without slash commands or candidate-name injection:

| Case | Natural-language request | Observed candidate load |
| --- | --- | --- |
| 0 | Initialize this repository for Copilot CLI with concise, accurate instructions. | Yes, as expected |
| 4 | Add repository-specific guidance for GitHub Copilot code review. | Yes, as expected |
| 5 | Run npm init and create a package.json for this JavaScript library. | No, as expected |
| 6 | Explain what the existing AGENTS.md says without changing anything. | No, as expected, after fixture correction |

Five invocations produced four valid case verdicts and one retained fixture
error: case 6 initially lacked the promised `AGENTS.md`. After adding declared
Markdown fixture support, one separately approved run successfully read and
accurately summarized the fixture without loading the candidate or changing files.
The invalid attempt remains an error; it is not included as a passing negative.

The skill description and body were unchanged. Traces verified the exact staged
candidate, only CLI built-ins alongside it, disabled MCP servers, identical CLI
binary hashes, and the requested model. Discovery runs stage only the description
and a minimal body, so the positive cases do not establish useful guidance
generation. This is one valid observation per case, not a repeatability result,
an installed multi-skill competition test, or coverage for other skills. All
attempts and private traces were retained.
